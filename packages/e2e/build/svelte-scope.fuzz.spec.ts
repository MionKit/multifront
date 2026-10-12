// Seeded fuzz of the Svelte scope stamping over generated real `.ucf` files, each beside its plain `.svelte` twin.
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {svelte} from '@sveltejs/vite-plugin-svelte';
import {Parser} from 'htmlparser2';
import {build} from 'vite';
import type {Plugin, Rolldown} from 'vite';
import {describe, expect, it} from 'vitest';
import {rootRelativePath, scopeId} from '@multifront/core';
import {multifront} from '@multifront/vite';
import {withNodeEnv} from './lib/build.ts';
import {fuzzSettings, mixSeed, replayLine, shrinkActions} from './lib/fuzz.ts';
import type {FuzzSettings, Failure as SeededFailure, Violation as SeededViolation} from './lib/fuzz.ts';
import {
  ACTION_KINDS,
  CHILD_FILE,
  FUZZ_DIR,
  SCRIPT_LAYOUTS,
  buildCase,
  caseAt,
  shapeOf,
  ucfSource,
  writeCase,
} from './lib/svelteScopeFuzz.ts';
import type {SvelteAction, SvelteCase} from './lib/svelteScopeFuzz.ts';

const SPEC_PATH = 'packages/e2e/build/svelte-scope.fuzz.spec.ts';
const DEFAULT_SETTINGS: FuzzSettings = {seed: 2026, runs: 300};
// Each batch is one SSR build; a smaller one finds a negative control's first failure sooner.
const BATCH = 50;
const CONTROL_BATCH = 10;
// Below this share of usable cases (the plain file builds and renders), the rules would test too little.
const USABLE_FLOOR = 0.8;

type Rule = 'builds' | 'stamps' | 'same-html';
type Violation = SeededViolation<Rule>;

/** A hand-broken output for the negative controls: `pre` edits our `.svelte` code, `post` Svelte's compiled code. */
interface Breaker {
  pre?: (code: string) => string;
  post?: (code: string) => string;
}

interface Run {
  dir: string;
  breaker?: Breaker;
  onlyRule?: Rule;
  batch: number;
}

type Outcome = {usable: false; reason: string} | {usable: true; violations: Violation[]};

interface Failure extends SeededFailure<SvelteCase, Rule> {
  dir: string;
}

const SVELTE_ID = /\.ucf\.svelte\.svelte$/;
let builds = 0;

function breakerPlugins(breaker: Breaker | undefined): Plugin[] {
  const plugin = (enforce: 'pre' | 'post', edit: ((code: string) => string) | undefined): Plugin => ({
    name: `svelte-scope-fuzz:${enforce}-breaker`,
    enforce,
    transform: (code, id) => (edit && SVELTE_ID.test(id) ? edit(code) : undefined),
  });
  return [plugin('pre', breaker?.pre), plugin('post', breaker?.post)];
}

// --- building and rendering --------------------------------------------------------------------------------------

type Kind = 'ucf' | 'plain';

const importOf = (fuzzCase: SvelteCase, kind: Kind) =>
  kind === 'ucf' ? `./${fuzzCase.name}.ucf' with { framework: 'svelte' }` : `./${fuzzCase.name}.svelte'`;

/** One SSR build of `entries`; `render(name, kind)` uses the bundle's own `svelte/server`. */
async function buildEntries(run: Run, entries: [SvelteCase, Kind][]) {
  const label = `batch-${++builds}`;
  const entry = join(run.dir, `${label}.js`);
  const lines = [`import {render} from 'svelte/server'`, `import Child from './${CHILD_FILE}'`];
  const rows: string[] = [];
  entries.forEach(([fuzzCase, kind], index) => {
    lines.push(`import C${index} from '${importOf(fuzzCase, kind)}`);
    rows.push(`  ${JSON.stringify(`${fuzzCase.name}:${kind}`)}: C${index},`);
  });
  lines.push(`const cases = {\n${rows.join('\n')}\n}`);
  // `render()` renders lazily, on the first read of `head` or `body`.
  lines.push('export function renderCase(name, kind) {');
  lines.push('  const {head, body} = render(cases[`${name}:${kind}`], {props: {Child}})');
  lines.push('  return {head, body}');
  lines.push('}');
  writeFileSync(entry, `${lines.join('\n')}\n`);
  const outDir = join(run.dir, label);
  const result = await withNodeEnv('production', () =>
    build({
      configFile: false,
      root: run.dir,
      logLevel: 'silent',
      plugins: [
        breakerPlugins(run.breaker)[0]!,
        svelte({onwarn: () => undefined}),
        multifront(),
        breakerPlugins(run.breaker)[1]!,
      ],
      build: {ssr: true, write: true, outDir, emptyOutDir: true, minify: false, rolldownOptions: {input: {[label]: entry}}},
    })
  );
  const output = (Array.isArray(result) ? result[0]! : result) as Rolldown.RolldownOutput;
  const chunk = output.output.find((file): file is Rolldown.OutputChunk => file.type === 'chunk' && file.isEntry)!;
  const module = (await import(/* @vite-ignore */ pathToFileURL(join(outDir, chunk.fileName)).href)) as {
    renderCase: (name: string, kind: Kind) => {head: string; body: string};
  };
  return module.renderCase;
}

async function buildsAlone(run: Run, fuzzCase: SvelteCase, kind: Kind): Promise<string | undefined> {
  try {
    await buildEntries(run, [[fuzzCase, kind]]);
    return undefined;
  } catch (err) {
    return firstLine(err);
  }
}

const firstLine = (err: unknown) => String(err instanceof Error ? err.message : err).split('\n')[0]!;

// The module a failed build names: `Fuzz3.ucf…` is our Svelte id, `Fuzz3.svelte` the plain file.
function culpritOf(err: unknown, cases: SvelteCase[]): {fuzzCase: SvelteCase; kind: Kind} | undefined {
  const errors = [err, ...((err as {errors?: unknown[]}).errors ?? [])] as {id?: string; message?: string}[];
  for (const {id, message} of errors) {
    for (const text of [id, message]) {
      const match = /(Fuzz\d+(?:s\d+)?)\.(ucf|svelte)\b/.exec(text ?? '');
      const fuzzCase = match && cases.find(({name}) => name === match[1]);
      if (fuzzCase) return {fuzzCase, kind: match[2] === 'ucf' ? 'ucf' : 'plain'};
    }
  }
  return undefined;
}

async function classify(run: Run, fuzzCase: SvelteCase): Promise<Outcome> {
  const plain = await buildsAlone(run, fuzzCase, 'plain');
  if (plain) return {usable: false, reason: `the plain file does not build: ${plain}`};
  const ucf = await buildsAlone(run, fuzzCase, 'ucf');
  return {usable: true, violations: ucf ? [{rule: 'builds', message: `the .ucf file does not build: ${ucf}`}] : []};
}

// --- the rules ---------------------------------------------------------------------------------------------------

function startTags(html: string): {name: string; attributes: string[]}[] {
  const tags: {name: string; attributes: string[]}[] = [];
  // Not parse5, which drops a repeated attribute; XML mode reads the tags as written, with no `<p>` the HTML rules imply.
  const parser = new Parser(
    {
      onopentagname: (name) => void tags.push({name, attributes: []}),
      onattribute: (name) => void tags.at(-1)!.attributes.push(name),
    },
    {xmlMode: true}
  );
  parser.write(html);
  parser.end();
  return tags;
}

function checkStamps(html: {head: string; body: string}, stamp: string): Violation[] {
  for (const {name, attributes} of startTags(html.body)) {
    const own = attributes.filter((attribute) => attribute === stamp).length;
    const other = attributes.filter((attribute) => attribute.startsWith('data-v-') && attribute !== stamp);
    if (own !== 1 || other.length)
      return [{rule: 'stamps', message: `<${name}> carries ${stamp} ${own} times and ${JSON.stringify(other)}`}];
  }
  if (html.head.includes('data-v-')) return [{rule: 'stamps', message: `the head carries a scope: ${html.head}`}];
  return [];
}

// Svelte keys each `<svelte:head>` with a hash of the file name, which differs between the twins.
const normalizeHead = (head: string) => head.replace(/<!--[0-9a-z]+-->/g, '<!--head-->');

function checkSameHtml(ucf: {head: string; body: string}, plain: {head: string; body: string}, stamp: string): Violation[] {
  const strip = (html: string) => html.replaceAll(` ${stamp}=""`, '');
  for (const part of ['head', 'body'] as const) {
    const [ours, theirs] = [strip(ucf[part]), plain[part]].map(part === 'head' ? normalizeHead : (html: string) => html);
    if (ours !== theirs)
      return [{rule: 'same-html', message: `the ${part} differs:\n    .ucf:   ${ours}\n    plain:  ${theirs}`}];
  }
  return [];
}

function checkRendered(
  run: Run,
  fuzzCase: SvelteCase,
  render: (name: string, kind: Kind) => {head: string; body: string}
): Outcome {
  let plain: {head: string; body: string};
  try {
    plain = render(fuzzCase.name, 'plain');
  } catch (err) {
    return {usable: false, reason: `the plain file's render threw: ${firstLine(err)}`};
  }
  let ucf: {head: string; body: string};
  try {
    ucf = render(fuzzCase.name, 'ucf');
  } catch (err) {
    return {usable: true, violations: [{rule: 'same-html', message: `the .ucf render threw: ${firstLine(err)}`}]};
  }
  const id = scopeId(rootRelativePath(run.dir, join(run.dir, `${fuzzCase.name}.ucf`)), ucfSource(fuzzCase), true);
  const stamp = `data-v-${id}`;
  return {usable: true, violations: [...checkStamps(ucf, stamp), ...checkSameHtml(ucf, plain, stamp)]};
}

/** Builds the cases together; a module that fails leaves the batch, which then builds again. */
async function checkCases(run: Run, cases: SvelteCase[]): Promise<Map<string, Outcome>> {
  const outcomes = new Map<string, Outcome>();
  for (const fuzzCase of cases) writeCase(run.dir, fuzzCase);
  let pending = cases;
  while (pending.length) {
    let render: (name: string, kind: Kind) => {head: string; body: string};
    try {
      render = await buildEntries(
        run,
        pending.flatMap((fuzzCase) => [[fuzzCase, 'ucf'] as [SvelteCase, Kind], [fuzzCase, 'plain'] as [SvelteCase, Kind]])
      );
    } catch (err) {
      const culprit = culpritOf(err, pending);
      const failed = culprit ? [culprit.fuzzCase] : pending;
      for (const fuzzCase of failed) outcomes.set(fuzzCase.name, await classify(run, fuzzCase));
      pending = pending.filter((fuzzCase) => !failed.includes(fuzzCase));
      continue;
    }
    for (const fuzzCase of pending) outcomes.set(fuzzCase.name, checkRendered(run, fuzzCase, render));
    pending = [];
  }
  for (const [name, outcome] of outcomes) {
    if (!outcome.usable || !run.onlyRule) continue;
    outcomes.set(name, {usable: true, violations: outcome.violations.filter(({rule}) => rule === run.onlyRule)});
  }
  return outcomes;
}

// --- runner ------------------------------------------------------------------------------------------------------

interface Result {
  failure?: Failure;
  usable: number;
  checked: number;
}

async function fuzz(settings: FuzzSettings, breaker?: Breaker, onlyRule?: Rule): Promise<Result> {
  mkdirSync(FUZZ_DIR, {recursive: true});
  const run: Run = {dir: mkdtempSync(join(FUZZ_DIR, 'run-')), breaker, onlyRule, batch: breaker ? CONTROL_BATCH : BATCH};
  let usable = 0;
  for (let first = 0; first < settings.runs; first += run.batch) {
    const indices = Array.from({length: Math.min(run.batch, settings.runs - first)}, (_, offset) => first + offset);
    const cases = indices.map((runIndex) => caseAt(settings.seed, runIndex, run.dir));
    const outcomes = await checkCases(run, cases);
    for (const [index, input] of cases.entries()) {
      const outcome = outcomes.get(input.name)!;
      if (!outcome.usable) continue;
      usable++;
      if (!outcome.violations.length) continue;
      const shrunk = await shrink(run, input, outcome.violations[0]!.rule);
      const runIndex = indices[index]!;
      const runSeed = mixSeed(settings.seed, 'run', runIndex);
      const failure = {seed: settings.seed, runIndex, runSeed, dir: run.dir, input, shrunk, violations: outcome.violations};
      return {failure, usable, checked: runIndex + 1};
    }
  }
  rmSync(run.dir, {recursive: true, force: true});
  return {usable, checked: settings.runs};
}

/** Each round builds all of its candidates in one batch. */
async function shrink(run: Run, input: SvelteCase, rule: Rule): Promise<SvelteCase> {
  let attempt = 0;
  const candidate = (actions: SvelteAction[]) => buildCase(input, actions, {name: `${input.name}s${++attempt}`, dir: run.dir});
  let round: {current: SvelteAction[]; fails: Map<string, boolean>} | undefined;
  const actions = await shrinkActions(input.actions, async (fewer, current) => {
    if (round?.current !== current) {
      const candidates = current.map((_, index) => candidate(current.filter((__, other) => other !== index)));
      const outcomes = await checkCases(run, candidates);
      const fails = new Map(
        candidates.map((fuzzCase) => {
          const outcome = outcomes.get(fuzzCase.name)!;
          return [JSON.stringify(fuzzCase.actions), outcome.usable && outcome.violations.some((found) => found.rule === rule)];
        })
      );
      round = {current, fails};
    }
    return round.fails.get(JSON.stringify(fewer)) ?? false;
  });
  const shrunk = candidate(actions);
  // Kept for the reader beside the input.
  writeCase(run.dir, shrunk);
  return shrunk;
}

const showCase = (fuzzCase: SvelteCase) =>
  `  ${fuzzCase.name} (${fuzzCase.legacy ? 'legacy' : 'runes'}), actions ${JSON.stringify(fuzzCase.applied)}:\n${ucfSource(fuzzCase)}`;

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

// --- tests -------------------------------------------------------------------------------------------------------

describe('svelte scope stamping fuzz', () => {
  const settings = fuzzSettings(DEFAULT_SETTINGS);

  it(
    `holds every rule over ${settings.runs} generated files (seed ${settings.seed})`,
    async () => {
      const {failure, usable, checked} = await fuzz(settings);
      if (failure) expect.fail(describeFailure(failure));
      expect(usable, `${usable} of ${checked} cases usable`).toBeGreaterThanOrEqual(Math.ceil(checked * USABLE_FLOOR));
    },
    60_000 + settings.runs * 1_000
  );

  it('reaches every case', () => {
    const reached = new Set<string>();
    let deepest = 0;
    for (let runIndex = 0; runIndex < DEFAULT_SETTINGS.runs; runIndex++) {
      const fuzzCase = caseAt(DEFAULT_SETTINGS.seed, runIndex, FUZZ_DIR);
      for (const kind of fuzzCase.applied) reached.add(kind);
      for (const fact of shapeOf(fuzzCase)) {
        if (fact.startsWith('depth:')) deepest = Math.max(deepest, Number(fact.slice('depth:'.length)));
        else reached.add(fact);
      }
    }
    const expected = [
      ...ACTION_KINDS,
      'mode:runes',
      'mode:legacy',
      ...SCRIPT_LAYOUTS.map((layout) => `script:${layout}`),
      ...[
        'RegularElement',
        'SvelteElement',
        'Component',
        'SvelteComponent',
        'SvelteSelf',
        'SlotElement',
        'SvelteFragment',
        'IfBlock',
        'EachBlock',
        'AwaitBlock',
        'KeyBlock',
        'SnippetBlock',
        'SvelteBoundary',
        'SvelteHead',
        'SvelteWindow',
        'SvelteBody',
        'SvelteDocument',
        'SvelteOptions',
        'Comment',
      ].map((type) => `type:${type}`),
    ];
    expect(expected.filter((fact) => !reached.has(fact))).toEqual([]);
    expect(deepest).toBeGreaterThanOrEqual(5);
  });

  // Each rule is proven live: a hand-broken output must make it fail, with a seed and a shrunk input.
  describe('negative controls', () => {
    const STAMP = / data-v-[0-9a-f]{8}=""/;
    const BROKEN: [string, Rule, Breaker][] = [
      ['an unclosed block', 'builds', {pre: (code) => `${code}\n{#if true}`}],
      [
        'the last stamp missing',
        'stamps',
        {
          pre: (code) => {
            const last = [...code.matchAll(new RegExp(STAMP.source, 'g'))].at(-1);
            return last ? code.slice(0, last.index) + code.slice(last.index + last[0].length) : code;
          },
        },
      ],
      // Svelte rejects a repeated attribute, so the doubling goes into its compiled server code.
      ['a doubled stamp', 'stamps', {post: (code) => code.replace(STAMP, (stamp) => stamp + stamp)}],
      [
        'a stamped head element',
        'stamps',
        // Not `<title>`: Svelte renders only its text.
        {pre: (code) => code.replace(/<meta(?= )/, (meta) => `${meta}${code.match(STAMP)?.[0] ?? ''}`)},
      ],
      ['an added text', 'same-html', {pre: (code) => `${code}\nbroken`}],
      ['a renamed shorthand key', 'same-html', {pre: (code) => code.replace(/\$style: (__ucf\w+)/, '$1')}],
    ];

    it.each(BROKEN)(
      '%s fails rule %s',
      async (_, rule, breaker) => {
        const {failure} = await fuzz(DEFAULT_SETTINGS, breaker, rule);
        expect(failure?.violations.map((violation) => violation.rule)).toContain(rule);
        const {input, shrunk, runIndex, dir} = failure!;
        try {
          const run: Run = {dir, breaker, onlyRule: rule, batch: CONTROL_BATCH};
          const outcome = (await checkCases(run, [shrunk])).get(shrunk.name)!;
          expect(outcome.usable && outcome.violations.map((violation) => violation.rule)).toContain(rule);
          expect(shrunk.applied.length).toBeLessThanOrEqual(input.applied.length);
          expect(describeFailure(failure!)).toContain(
            `MULTIFRONT_FUZZ_SEED=${DEFAULT_SETTINGS.seed} MULTIFRONT_FUZZ_RUNS=${runIndex + 1}`
          );
          const replayed = caseAt(DEFAULT_SETTINGS.seed, runIndex, dir);
          expect(replayed.block).toBe(input.block);
        } finally {
          rmSync(dir, {recursive: true, force: true});
        }
      },
      300_000
    );
  });
});
