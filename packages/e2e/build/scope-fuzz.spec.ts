// Seeded fuzz of the React scope transform over generated real `.ucf` files (fuzzy-testing skill).
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {format} from 'node:util';
import {TraceMap, decodedMappings} from '@jridgewell/trace-mapping';
import react from '@vitejs/plugin-react';
import {Visitor, parseSync} from 'oxc-parser';
import type {JSXOpeningElement} from 'oxc-parser';
import {createServer, isRunnableDevEnvironment} from 'vite';
import type {Plugin, ViteDevServer} from 'vite';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {checkBlocks, createBuildContext, getBlockKind, loadVueCompiler, splitBlocks} from '@multifront/core';
import type {BuildContext, VirtualFile} from '@multifront/core';
import {multifront} from '@multifront/vite';
import {fuzzSettings, mixSeed, replayLine, shrinkActions} from './lib/fuzz.ts';
import type {FuzzSettings, Failure as SeededFailure, Violation as SeededViolation} from './lib/fuzz.ts';
import {ACTION_KINDS, FRAGMENT_TAGS, FUZZ_DIR, OUTCOMES, buildCase, caseAt, shapeOf, writeCase} from './lib/scopeFuzz.ts';
import type {ScopeAction, ScopeCase} from './lib/scopeFuzz.ts';

const SPEC_PATH = 'packages/e2e/build/scope-fuzz.spec.ts';
const DEFAULT_SETTINGS: FuzzSettings = {seed: 2026, runs: 300};

type Rule = 'valid-input' | 'parses' | 'only-adds' | 'stamps' | 'renders';

type Violation = SeededViolation<Rule>;

/** A hand-broken output for the negative controls; applied in-process and by the dev server's `breaker` plugin. */
type Breaker = (code: string) => string;

interface Run {
  dir: string;
  breaker?: Breaker;
  onlyRule?: Rule;
}

interface Failure extends SeededFailure<ScopeCase, Rule> {
  dir: string;
}

mkdirSync(FUZZ_DIR, {recursive: true});
const compiler = loadVueCompiler(FUZZ_DIR);

// --- rule 1: parses --------------------------------------------------------------------------------------------

function parse(code: string) {
  return parseSync('Out.tsx', code, {lang: 'tsx', sourceType: 'module'});
}

function checkParses(code: string): Violation[] {
  const {errors} = parse(code);
  return errors.length ? [{rule: 'parses', message: `the output does not parse: ${errors[0]!.message}`}] : [];
}

// --- rule 2: only adds -----------------------------------------------------------------------------------------

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') starts.push(index + 1);
  return starts;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The fixed texts the build inserts, as one alternation; imports are counted, as each comes with one line break.
function insertPattern(fuzzCase: ScopeCase, ctx: BuildContext): {insert: RegExp; imports: RegExp} {
  const {props, name} = fuzzCase;
  const fixed = [
    ` data-v-${ctx.scopeId}=""`,
    ` {...__ucfScopeAttrs(${props})}`,
    `(__ucfWarnFragment(${props}, ${JSON.stringify(name)}), `,
    ` = ${props}; return `,
    ` = ${props};`,
    `${props}, __ref`,
    props,
    '{const ',
    'const ',
    ')',
    '}',
  ].map(escape);
  const imports = [
    'import "[^"\\n]*";',
    'import [A-Za-z_$][\\w$]* from "[^"\\n]*";',
    'import \\{[\\w$, ]*\\} from "virtual:multifront/scope-attrs";',
  ];
  return {
    insert: new RegExp(`^(?:${[...imports, ...fixed, '\\n'].join('|')})*$`),
    imports: new RegExp(imports.join('|'), 'g'),
  };
}

function checkOnlyAdds(fuzzCase: ScopeCase, ctx: BuildContext, file: VirtualFile, code: string): Violation[] {
  const fail = (message: string): Violation[] => [{rule: 'only-adds', message}];
  const {source} = fuzzCase;
  const block = splitBlocks(source, ctx.filename).targets.react!;
  const sourceLines = lineStarts(source);
  const outLines = lineStarts(code);
  // magic-string's hires map gives each original character a segment of its own, line breaks aside.
  const mapped = new Map<number, number>();
  decodedMappings(new TraceMap(file.map!)).forEach((segments, line) => {
    for (const segment of segments)
      if (segment.length >= 4) mapped.set(outLines[line]! + segment[0], sourceLines[segment[2]!]! + segment[3]!);
  });
  for (const [at, offset] of mapped) {
    if (offset < block.contentStart || offset >= block.contentEnd)
      return fail(`output ${at} maps to ${offset}, outside the <react> block`);
    if (code[at] !== source[offset])
      return fail(`output ${at} is ${JSON.stringify(code[at])} but maps to ${JSON.stringify(source[offset])} at ${offset}`);
  }
  const expected: number[] = [];
  for (let offset = block.contentStart; offset < block.contentEnd; offset++) if (source[offset] !== '\n') expected.push(offset);
  const actual = [...mapped.values()].sort((first, second) => first - second);
  if (actual.join() !== expected.join()) {
    const missing = expected.find((offset, index) => actual[index] !== offset) ?? expected.length;
    return fail(`the mapped characters are not the block content once each, first difference near offset ${missing}`);
  }
  const {insert, imports} = insertPattern(fuzzCase, ctx);
  let breaks = 0;
  let importCount = 0;
  for (let at = 0; at < code.length;) {
    if (mapped.has(at)) {
      at++;
      continue;
    }
    let end = at;
    while (end < code.length && !mapped.has(end)) end++;
    const piece = code.slice(at, end);
    if (!insert.test(piece)) return fail(`unexpected text inserted at ${at}: ${JSON.stringify(piece)}`);
    breaks += piece.split('\n').length - 1;
    importCount += piece.match(imports)?.length ?? 0;
    at = end;
  }
  const contentBreaks = block.content.split('\n').length - 1;
  if (breaks !== contentBreaks + importCount)
    return fail(`${breaks} unmapped line breaks, expected ${contentBreaks} of the block and ${importCount} of the imports`);
  return [];
}

// --- rule 3: stamps --------------------------------------------------------------------------------------------

function openingElements(code: string): {name: string; stamps: number}[] {
  const found: {name: string; stamps: number}[] = [];
  const visit = (node: JSXOpeningElement) => {
    const stamps = node.attributes.filter(
      (attribute) =>
        attribute.type === 'JSXAttribute' && attribute.name.type === 'JSXIdentifier' && attribute.name.name.startsWith('data-v-')
    ).length;
    found.push({name: code.slice(node.name.start, node.name.end), stamps});
  };
  new Visitor({JSXOpeningElement: visit}).visit(parse(code).program);
  return found;
}

function checkStamps(fuzzCase: ScopeCase, code: string, content: string): Violation[] {
  const input = openingElements(content).map(({name}) => name);
  const output = openingElements(code);
  if (output.map(({name}) => name).join() !== input.join())
    return [{rule: 'stamps', message: `opening elements changed: ${JSON.stringify(output.map(({name}) => name))}`}];
  const {scoped} = fuzzCase.model;
  const wrong = output.find(({name, stamps}) => stamps !== (scoped && !FRAGMENT_TAGS.includes(name) ? 1 : 0));
  if (!wrong) return [];
  return [{rule: 'stamps', message: `<${wrong.name}> carries ${wrong.stamps} stamps (scoped: ${scoped})`}];
}

// --- rule 4: renders -------------------------------------------------------------------------------------------

let server: ViteDevServer | undefined;
let active: Run | undefined;

const breakerPlugin: Plugin = {
  name: 'scope-fuzz:breaker',
  enforce: 'pre',
  transform(code, id) {
    if (active?.breaker && id.startsWith(active.dir) && id.endsWith('.ucf.react.tsx')) return active.breaker(code);
    return undefined;
  },
};

const ENTRY = (name: string) => `import { renderToString } from 'react-dom/server'
import Case from './${name}.ucf'

export function render(branch?: string) {
  return renderToString(
    <main>{branch === undefined ? <Case data-v-parent="" /> : <Case data-v-parent="" branch={branch} />}</main>
  )
}
`;

async function withConsole<Result>(logged: string[], run: () => Promise<Result>): Promise<Result> {
  const record = (...args: unknown[]) => void logged.push(format(...args));
  const spies = [vi.spyOn(console, 'error').mockImplementation(record), vi.spyOn(console, 'warn').mockImplementation(record)];
  try {
    return await run();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

async function checkRenders(fuzzCase: ScopeCase, run: Run): Promise<Violation[]> {
  const fail = (message: string): Violation[] => [{rule: 'renders', message}];
  const ssr = server!.environments.ssr;
  if (!isRunnableDevEnvironment(ssr)) throw new Error('the ssr environment has no module runner');
  const entry = join(run.dir, `${fuzzCase.name}.render.tsx`);
  writeFileSync(entry, ENTRY(fuzzCase.name));
  active = run;
  try {
    const logged: string[] = [];
    let render: (branch?: string) => string;
    try {
      ({render} = await withConsole(logged, () => ssr.runner.import(`/${relative(FUZZ_DIR, entry)}`)));
    } catch (err) {
      return fail(`the module does not load: ${String(err)}`);
    }
    if (logged.length) return fail(`loading logged: ${logged[0]}`);
    const fragmentWarning = new RegExp(`^\\[multifront\\] <${fuzzCase.name}> renders a fragment root`);
    for (const {branch, outcome} of fuzzCase.branches) {
      let html: string;
      try {
        html = await withConsole(logged, async () => render(branch));
      } catch (err) {
        return fail(`branch ${branch}: render threw ${String(err)}`);
      }
      const unexpected = logged.find((message) => !(outcome === 'fragment' && fragmentWarning.test(message)));
      if (unexpected) return fail(`branch ${branch} (${outcome}): React logged ${JSON.stringify(unexpected)}`);
      logged.length = 0;
      const carries = outcome === 'host' || outcome === 'forwarding-component';
      const count = html.split('data-v-parent=""').length - 1;
      const first = /^<main><[a-z][^>]*>/.exec(html)?.[0] ?? '';
      if (carries ? count !== 1 || !first.includes('data-v-parent=""') : count !== 0)
        return fail(
          `branch ${branch} (${outcome}): ${count} elements carry data-v-parent in ${JSON.stringify(html.slice(0, 200))}`
        );
    }
    return [];
  } finally {
    active = undefined;
  }
}

// --- one case --------------------------------------------------------------------------------------------------

async function checkCase(fuzzCase: ScopeCase, run: Run): Promise<Violation[]> {
  const filename = writeCase(run.dir, fuzzCase);
  const split = splitBlocks(fuzzCase.source, filename);
  const diagnostics = checkBlocks(split);
  if (diagnostics.length || !split.targets.react)
    return [{rule: 'valid-input', message: `the generated file is invalid: ${JSON.stringify(diagnostics[0])}`}];
  const block = split.targets.react;
  const violations: Violation[] = [];
  for (const production of [false, true]) {
    const ctx = await createBuildContext(split, {root: run.dir, compiler, production});
    let file: VirtualFile;
    try {
      file = getBlockKind('react').build(block, ctx);
    } catch (err) {
      violations.push({rule: 'parses', message: `react.build threw: ${String(err)}`});
      continue;
    }
    const code = run.breaker ? run.breaker(file.code) : file.code;
    const label = (found: Violation[]) =>
      found.map((violation) => ({...violation, message: `${production ? 'production' : 'dev'}: ${violation.message}`}));
    const parses = checkParses(code);
    violations.push(...label(parses));
    if (parses.length) continue;
    violations.push(...label(checkOnlyAdds(fuzzCase, ctx, file, code)), ...label(checkStamps(fuzzCase, code, block.content)));
  }
  const relevant = (violation: Violation) => !run.onlyRule || violation.rule === run.onlyRule || violation.rule === 'valid-input';
  if (fuzzCase.render && (!run.onlyRule || run.onlyRule === 'renders')) violations.push(...(await checkRenders(fuzzCase, run)));
  return violations.filter(relevant);
}

// --- runner ----------------------------------------------------------------------------------------------------

async function fuzz(settings: FuzzSettings, breaker?: Breaker, onlyRule?: Rule): Promise<Failure | undefined> {
  const run: Run = {dir: mkdtempSync(join(FUZZ_DIR, 'run-')), breaker, onlyRule};
  for (let runIndex = 0; runIndex < settings.runs; runIndex++) {
    const input = caseAt(settings.seed, runIndex);
    const violations = await checkCase(input, run);
    if (!violations.length) continue;
    const rule = violations[0]!.rule;
    let attempt = 0;
    const candidate = (actions: ScopeAction[]) =>
      buildCase(input.fixture, actions, {name: `${input.name}s${++attempt}`, render: input.render});
    const actions = await shrinkActions(input.actions, async (fewer) =>
      (await checkCase(candidate(fewer), run)).some((found) => found.rule === rule)
    );
    const shrunk = buildCase(input.fixture, actions, {name: `${input.name}s${++attempt}`, render: input.render});
    // Kept for the reader; never loaded here, so a replay of it still sees React's first warning.
    writeCase(run.dir, shrunk);
    const runSeed = mixSeed(settings.seed, 'run', runIndex);
    return {seed: settings.seed, runIndex, runSeed, dir: run.dir, input, shrunk, violations};
  }
  rmSync(run.dir, {recursive: true, force: true});
  return undefined;
}

const showCase = (fuzzCase: ScopeCase) =>
  `  ${fuzzCase.name}: fixture ${fuzzCase.fixture}, actions ${JSON.stringify(fuzzCase.applied)}\n${fuzzCase.source}`;

// CI shows only the assertion message, so it carries the replay line.
function describeFailure(failure: Failure): string {
  return [
    `fuzz failure at run ${failure.runIndex} (run seed ${failure.runSeed}), files kept in ${failure.dir}`,
    ...failure.violations.map((violation) => `  [${violation.rule}] ${violation.message}`),
    replayLine(failure.seed, failure.runIndex, SPEC_PATH),
    'shrunk:',
    showCase(failure.shrunk),
  ].join('\n');
}

// --- tests -----------------------------------------------------------------------------------------------------

describe('scope transform fuzz', () => {
  const settings = fuzzSettings(DEFAULT_SETTINGS);

  beforeAll(async () => {
    server = await createServer({
      configFile: false,
      root: FUZZ_DIR,
      cacheDir: join(FUZZ_DIR, '.vite'),
      logLevel: 'silent',
      appType: 'custom',
      plugins: [breakerPlugin, react(), multifront()],
      server: {middlewareMode: true, ws: false, preTransformRequests: false},
      optimizeDeps: {noDiscovery: true},
    });
  });

  afterAll(async () => {
    await server?.close();
    rmSync(join(FUZZ_DIR, '.vite'), {recursive: true, force: true});
  });

  it(
    `holds every rule over ${settings.runs} generated files (seed ${settings.seed})`,
    async () => {
      const failure = await fuzz(settings);
      if (failure) expect.fail(describeFailure(failure));
    },
    60_000 + settings.runs * 100
  );

  it('reaches every case', () => {
    const reached = new Set<string>();
    for (let runIndex = 0; runIndex < DEFAULT_SETTINGS.runs; runIndex++) {
      const fuzzCase = caseAt(DEFAULT_SETTINGS.seed, runIndex);
      for (const kind of fuzzCase.applied) reached.add(kind);
      for (const fact of shapeOf(fuzzCase)) reached.add(fact);
      if (fuzzCase.render) for (const {outcome} of fuzzCase.branches) reached.add(`rendered:${outcome}`);
    }
    const expected = [
      ...ACTION_KINDS,
      ...OUTCOMES.map((outcome) => `rendered:${outcome}`),
      ...['unwrapped', 'memo', 'forwardRef', 'forwardRef+memo'].map((wrappers) => `wrappers:${wrappers}`),
      'function:block',
      'arrow:block',
      'arrow:expression',
      ...['plain', 'destructured', 'none'].map((props) => `props:${props}`),
      ...['direct', 'identifier', 'as-default'].map((style) => `export:${style}`),
      'style:scoped',
      'style:plain',
    ];
    expect(expected.filter((fact) => !reached.has(fact))).toEqual([]);
  });

  // Each rule is proven live: a hand-broken output must make it fail, with a seed and a shrunk input.
  describe('negative controls', () => {
    const STAMP = / data-v-[0-9a-f]+=""/;
    const SPREAD = / \{\.\.\.__ucfScopeAttrs\(\w+\)\}/;
    let unknownProps = 0;
    const BROKEN: [string, Rule, Breaker][] = [
      ['a forwarding spread left open', 'parses', (code) => code.replace(SPREAD, (spread) => spread.slice(0, -1))],
      ['a stray comment after a stamp', 'only-adds', (code) => code.replace(STAMP, (stamp) => `${stamp}/*x*/`)],
      ['a dropped character after a stamp', 'only-adds', (code) => code.replace(new RegExp(`(${STAMP.source}) \\S`), '$1 ')],
      [
        'the last stamp missing',
        'stamps',
        (code) => {
          const last = [...code.matchAll(new RegExp(STAMP.source, 'g'))].at(-1);
          return last ? code.slice(0, last.index) + code.slice(last.index + last[0].length) : code;
        },
      ],
      ['a doubled stamp', 'stamps', (code) => code.replace(STAMP, (stamp) => stamp + stamp)],
      ['every forwarding spread removed', 'renders', (code) => code.replace(new RegExp(SPREAD.source, 'g'), '')],
      // React warns once per prop name, so each module gets names of its own.
      ['an unknown DOM prop', 'renders', (code) => code.replaceAll(' className=', () => ` unknownProp${++unknownProps}=`)],
    ];

    it.each(BROKEN)(
      '%s fails rule %s',
      async (_, rule, breaker) => {
        const failure = await fuzz(DEFAULT_SETTINGS, breaker, rule);
        expect(failure?.violations.map((violation) => violation.rule)).toContain(rule);
        const {input, shrunk, runIndex, dir} = failure!;
        try {
          const run: Run = {dir, breaker, onlyRule: rule};
          expect((await checkCase(shrunk, run)).map((violation) => violation.rule)).toContain(rule);
          expect(shrunk.applied.length).toBeLessThanOrEqual(input.applied.length);
          expect(describeFailure(failure!)).toContain(
            `MULTIFRONT_FUZZ_SEED=${DEFAULT_SETTINGS.seed} MULTIFRONT_FUZZ_RUNS=${runIndex + 1}`
          );
          const replayed = await fuzz({seed: DEFAULT_SETTINGS.seed, runs: runIndex + 1}, breaker, rule);
          expect(replayed?.input.source).toBe(input.source);
          if (replayed) rmSync(replayed.dir, {recursive: true, force: true});
        } finally {
          rmSync(dir, {recursive: true, force: true});
        }
      },
      120_000
    );
  });
});
