// Seeded fuzz of the Svelte scope stamping over generated real `.ucf` files, each beside its plain `.svelte` twin.
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {svelte} from '@sveltejs/vite-plugin-svelte';
import {Parser} from 'htmlparser2';
import {compile} from 'svelte/compiler';
import type {Plugin, Rolldown} from 'vite';
import {describe, expect, it} from 'vitest';
import {rootRelativePath, scopeId} from '@multifront/core';
import {multifront} from '@multifront/vite';
import {buildApp} from './lib/build.ts';
import {describeKeptFailure, dropLast, fuzzSettings, mixSeed, shrinkActions} from './lib/fuzz.ts';
import type {FuzzSettings, KeptFailure, Violation as SeededViolation} from './lib/fuzz.ts';
import {
  ACTION_KINDS,
  CHILD_FILE,
  FUZZ_DIR,
  PARENT_FILE,
  PARENT_CLASS,
  PARENT_SOURCE,
  PARENT_STYLE,
  SCRIPT_LAYOUTS,
  VOID,
  buildCase,
  caseAt,
  rootKind,
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

type Rule = 'builds' | 'stamps' | 'same-html' | 'forwards';
type Violation = SeededViolation<Rule>;
type Failure = KeptFailure<SvelteCase, Rule>;

/** A hand-broken output for the negative controls: `pre` edits our `.svelte` code, `post` Svelte's compiled code. */
interface Breaker {
  pre?: (code: string) => string;
  post?: (code: string) => string;
}

interface Run {
  dir: string;
  breaker?: Breaker;
  onlyRule?: Rule;
}

// The parent's scope on a top-level element: exactly once each, at most once each, or never.
type Forwarded = 'root' | 'maybe-root' | 'none';
type Outcome = {usable: false; reason: string} | {usable: true; violations: Violation[]; forwarded?: Forwarded};

type Kind = 'ucf' | 'plain';
type Entry = [SvelteCase, Kind];
interface Html {
  head: string;
  body: string;
}
type Render = (name: string, kind: Kind) => Html;

// The cases' Svelte ids, never Parent.ucf's.
const CASE_ID = /\/Fuzz\d+(?:s\d+)?\.ucf\.svelte\.svelte$/;
let builds = 0;

function breaker(enforce: keyof Breaker, edit: Breaker[keyof Breaker]): Plugin {
  return {
    name: `svelte-scope-fuzz:${enforce}-breaker`,
    enforce,
    transform: (code, id) => (edit && CASE_ID.test(id) ? edit(code) : undefined),
  };
}

// Rolldown's own message only counts the errors; the first one says what failed.
function firstLine(err: unknown): string {
  const first = (err as Partial<Rolldown.BundleError>).errors?.[0] ?? err;
  return String((first as Partial<Error> | undefined)?.message ?? first).split('\n')[0]!;
}

// --- building and rendering --------------------------------------------------------------------------------------

/** One SSR build of `entries`; the render uses the bundle's own `svelte/server`. */
async function buildEntries(run: Run, entries: Entry[]): Promise<Render> {
  const label = `batch-${++builds}`;
  const entry = join(run.dir, `${label}.js`);
  const lines = [
    `import {render} from 'svelte/server'`,
    `import Child from './${CHILD_FILE}'`,
    `import Parent from './${PARENT_FILE}' with { framework: 'svelte' }`,
  ];
  const rows: string[] = [];
  entries.forEach(([{name}, kind], index) => {
    lines.push(`import C${index} from './${name}${kind === 'ucf' ? `.ucf' with { framework: 'svelte' }` : `.svelte'`}`);
    rows.push(`  ${JSON.stringify(`${name}:${kind}`)}: C${index},`);
  });
  lines.push(`const cases = {\n${rows.join('\n')}\n}`);
  // `render()` renders lazily, on the first read of `head` or `body`.
  lines.push('export function renderCase(name, kind) {');
  lines.push('  const {head, body} = render(Parent, {props: {Case: cases[`${name}:${kind}`], Child}})');
  lines.push('  return {head, body}');
  lines.push('}');
  writeFileSync(entry, `${lines.join('\n')}\n`);
  const outDir = join(run.dir, label);
  const {chunks} = await buildApp(run.dir, {
    configFile: false,
    plugins: [
      breaker('pre', run.breaker?.pre),
      svelte({onwarn: () => undefined}),
      multifront(),
      breaker('post', run.breaker?.post),
    ],
    build: {ssr: true, write: true, outDir, emptyOutDir: true, rolldownOptions: {input: {[label]: entry}}},
  });
  const chunk = chunks.find((file) => file.isEntry)!;
  const module = (await import(/* @vite-ignore */ pathToFileURL(join(outDir, chunk.fileName)).href)) as {renderCase: Render};
  return module.renderCase;
}

// A failed build names the module: `Fuzz3.ucf…` is our Svelte id, `Fuzz3.svelte` the plain file.
function culpritOf(err: unknown, cases: SvelteCase[]): SvelteCase | undefined {
  const bundleError = err as Partial<Rolldown.BundleError>;
  for (const {id, message} of [bundleError, ...(bundleError.errors ?? [])] as Partial<Rolldown.RollupError>[]) {
    for (const text of [id, message]) {
      const name = /(Fuzz\d+(?:s\d+)?)\.(?:ucf|svelte)\b/.exec(text ?? '')?.[1];
      const fuzzCase = cases.find((candidate) => candidate.name === name);
      if (fuzzCase) return fuzzCase;
    }
  }
  return undefined;
}

/** A case whose batch failed: each file alone, then the pair rendered, so the other rules still see it. */
async function checkAlone(run: Run, fuzzCase: SvelteCase): Promise<Outcome> {
  const fails = (kind: Kind) => buildEntries(run, [[fuzzCase, kind]]).then(() => undefined, firstLine);
  const plain = await fails('plain');
  if (plain) return {usable: false, reason: `the plain file does not build: ${plain}`};
  const ucf = await fails('ucf');
  if (ucf) return {usable: true, violations: [{rule: 'builds', message: `the .ucf file does not build: ${ucf}`}]};
  return checkRendered(
    run,
    fuzzCase,
    await buildEntries(run, [
      [fuzzCase, 'ucf'],
      [fuzzCase, 'plain'],
    ])
  );
}

// --- the rules ---------------------------------------------------------------------------------------------------

function startTags(html: string) {
  const tags: {name: string; attributes: string[]; classes: string[]; style: string; top: boolean}[] = [];
  let depth = 0;
  // Not parse5, which drops a repeated attribute; XML mode reads the tags as written, with no `<p>` the HTML rules imply.
  const parser = new Parser(
    {
      onopentagname: (name) => {
        tags.push({name, attributes: [], classes: [], style: '', top: depth === 0});
        if (!VOID.has(name)) depth++;
      },
      onattribute: (name, value) => {
        const tag = tags.at(-1)!;
        tag.attributes.push(name);
        if (name === 'class') tag.classes.push(...value.split(/\s+/));
        if (name === 'style') tag.style = value;
      },
      onclosetag: (name) => {
        if (!VOID.has(name)) depth--;
      },
    },
    {xmlMode: true}
  );
  parser.write(html);
  parser.end();
  return tags;
}

// The parent's scope is the `forwards` rule's.
function checkStamps(html: Html, stamp: string, parent: string): Violation[] {
  for (const {name, attributes} of startTags(html.body)) {
    const own = attributes.filter((attribute) => attribute === stamp).length;
    const other = attributes.filter(
      (attribute) => attribute.startsWith('data-v-') && attribute !== stamp && attribute !== parent
    );
    if (own !== 1 || other.length)
      return [{rule: 'stamps', message: `<${name}> carries ${stamp} ${own} times and ${JSON.stringify(other)}`}];
  }
  if (html.head.includes('data-v-')) return [{rule: 'stamps', message: `the head carries a scope: ${html.head}`}];
  return [];
}

// Svelte keys each `<svelte:head>` with a hash of the file name, which differs between the twins.
const normalizeHead = (head: string) => head.replace(/<!--[0-9a-z]+-->/g, '<!--head-->');

// Svelte's server render adds these to an `<img>` or other load-event element with a spread, as a forwarded root has.
const LOAD_REPLAY = / on(?:load|error)="this\.__e=event"/g;

// The parent's class and style, which the `forwards` rule checks: a plain root spreading its props gets them too.
const withoutParentProps = (html: string) =>
  html
    .replaceAll(` class="${PARENT_CLASS}"`, '')
    .replaceAll(` ${PARENT_CLASS}"`, '"')
    .replaceAll(` style="${PARENT_STYLE}"`, '')
    .replaceAll(`; ${PARENT_STYLE}"`, '"');

function checkSameHtml(ucf: Html, plain: Html, stamp: string, parent: string): Violation[] {
  const strip = (html: string) => html.replaceAll(` ${stamp}=""`, '').replaceAll(` ${parent}=""`, '');
  for (const part of ['head', 'body'] as const) {
    const [ours, theirs] = [strip(ucf[part]), plain[part]]
      .map(withoutParentProps)
      .map((html) => html.replaceAll(LOAD_REPLAY, ''))
      .map(part === 'head' ? normalizeHead : (html: string) => html);
    if (ours !== theirs)
      return [{rule: 'same-html', message: `the ${part} differs:\n    .ucf:   ${ours}\n    plain:  ${theirs}`}];
  }
  return [];
}

// Each of the parent's scope, class and style.
function checkForwards(html: Html, parent: string, forwarded: Forwarded): Violation[] {
  for (const {name, attributes, classes, style, top} of startTags(html.body)) {
    const allowed = !top ? [0] : forwarded === 'root' ? [1] : forwarded === 'maybe-root' ? [0, 1] : [0];
    const carried: [string, number][] = [
      [parent, attributes.filter((attribute) => attribute === parent).length],
      [`class ${PARENT_CLASS}`, classes.filter((value) => value === PARENT_CLASS).length],
      [`style ${PARENT_STYLE}`, style.split(/;\s*/).filter((value) => value === PARENT_STYLE).length],
    ];
    for (const [what, count] of carried) {
      if (!allowed.includes(count))
        return [{rule: 'forwards', message: `${top ? 'root' : 'inner'} <${name}> carries ${what} ${count} times (${forwarded})`}];
    }
  }
  return [];
}

// Svelte's own reading decides runes mode: the plain twin's, the same as the block's.
function forwardedOf(fuzzCase: SvelteCase): Forwarded {
  const {metadata} = compile(fuzzCase.plain, {generate: false, filename: `${fuzzCase.name}.svelte`});
  const kind = rootKind(fuzzCase.block);
  if (!metadata.runes) return 'none';
  return kind === 'single' ? 'root' : kind === 'other' ? 'maybe-root' : 'none';
}

function checkRendered(run: Run, fuzzCase: SvelteCase, render: Render): Outcome {
  let plain: Html;
  try {
    plain = render(fuzzCase.name, 'plain');
  } catch (err) {
    return {usable: false, reason: `the plain file's render threw: ${firstLine(err)}`};
  }
  let ucf: Html;
  try {
    ucf = render(fuzzCase.name, 'ucf');
  } catch (err) {
    return {usable: true, violations: [{rule: 'same-html', message: `the .ucf render threw: ${firstLine(err)}`}]};
  }
  const id = scopeId(rootRelativePath(run.dir, join(run.dir, `${fuzzCase.name}.ucf`)), ucfSource(fuzzCase), true);
  const stamp = `data-v-${id}`;
  const parent = `data-v-${scopeId(rootRelativePath(run.dir, join(run.dir, PARENT_FILE)), PARENT_SOURCE, true)}`;
  const forwarded = forwardedOf(fuzzCase);
  return {
    usable: true,
    forwarded,
    violations: [
      ...checkStamps(ucf, stamp, parent),
      ...checkSameHtml(ucf, plain, stamp, parent),
      ...checkForwards(ucf, parent, forwarded),
    ],
  };
}

/** Builds the cases together; a module that fails leaves the batch, which then builds again. */
async function checkCases(run: Run, cases: SvelteCase[]): Promise<Map<string, Outcome>> {
  const outcomes = new Map<string, Outcome>();
  for (const fuzzCase of cases) writeCase(run.dir, fuzzCase);
  let pending = cases;
  while (pending.length) {
    let render: Render;
    try {
      render = await buildEntries(
        run,
        pending.flatMap((fuzzCase): Entry[] => [
          [fuzzCase, 'ucf'],
          [fuzzCase, 'plain'],
        ])
      );
    } catch (err) {
      const culprit = culpritOf(err, pending);
      const failed = culprit ? [culprit] : pending;
      for (const fuzzCase of failed) outcomes.set(fuzzCase.name, await checkAlone(run, fuzzCase));
      pending = pending.filter((fuzzCase) => !failed.includes(fuzzCase));
      continue;
    }
    for (const fuzzCase of pending) outcomes.set(fuzzCase.name, checkRendered(run, fuzzCase, render));
    pending = [];
  }
  for (const [name, outcome] of outcomes) {
    if (!outcome.usable || !run.onlyRule) continue;
    outcomes.set(name, {...outcome, violations: outcome.violations.filter(({rule}) => rule === run.onlyRule)});
  }
  return outcomes;
}

// --- runner ------------------------------------------------------------------------------------------------------

interface Result {
  failure?: Failure;
  usable: number;
  checked: number;
  unusable: string[]; // why, one line per case
  reached: Set<string>; // the shape facts of the usable cases
  deepest: number;
}

async function fuzz(settings: FuzzSettings, breaker?: Breaker, onlyRule?: Rule): Promise<Result> {
  mkdirSync(FUZZ_DIR, {recursive: true});
  const run: Run = {dir: mkdtempSync(join(FUZZ_DIR, 'run-')), breaker, onlyRule};
  const batch = breaker ? CONTROL_BATCH : BATCH;
  const result: Result = {usable: 0, checked: 0, unusable: [], reached: new Set(), deepest: 0};
  for (let first = 0; first < settings.runs; first += batch) {
    const indices = Array.from({length: Math.min(batch, settings.runs - first)}, (_, offset) => first + offset);
    const cases = indices.map((runIndex) => caseAt(settings.seed, runIndex, run.dir));
    const outcomes = await checkCases(run, cases);
    for (const [index, input] of cases.entries()) {
      const runIndex = indices[index]!;
      result.checked = runIndex + 1;
      const outcome = outcomes.get(input.name)!;
      if (!outcome.usable) {
        result.unusable.push(`${input.name}: ${outcome.reason}`);
        continue;
      }
      result.usable++;
      for (const kind of input.applied) result.reached.add(kind);
      result.reached.add(`forwards:${outcome.forwarded}`);
      for (const fact of shapeOf(input)) {
        if (fact.startsWith('depth:')) result.deepest = Math.max(result.deepest, Number(fact.slice('depth:'.length)));
        else result.reached.add(fact);
      }
      if (!outcome.violations.length) continue;
      const shrunk = await shrink(run, input, outcome.violations[0]!.rule);
      const runSeed = mixSeed(settings.seed, 'run', runIndex);
      result.failure = {seed: settings.seed, runIndex, runSeed, dir: run.dir, input, shrunk, violations: outcome.violations};
      return result;
    }
  }
  rmSync(run.dir, {recursive: true, force: true});
  return result;
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
  `  ${fuzzCase.name} (${fuzzCase.legacy ? 'legacy' : 'runes'}), actions ${JSON.stringify(fuzzCase.applied)}:\n${ucfSource(fuzzCase)}\n  plain twin:\n${fuzzCase.plain}`;

const describeFailure = (failure: Failure) => describeKeptFailure(failure, SPEC_PATH, showCase);

const EXPECTED_FACTS = [
  ...ACTION_KINDS,
  'mode:runes',
  'mode:legacy',
  ...SCRIPT_LAYOUTS.map((layout) => `script:${layout}`),
  'root:single',
  'root:many',
  'root:each',
  'forwards:root',
  'forwards:none',
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
    'RenderTag',
    'SvelteBoundary',
    'SvelteHead',
    'SvelteWindow',
    'SvelteBody',
    'SvelteDocument',
    'SvelteOptions',
    'Comment',
  ].map((type) => `type:${type}`),
];

// --- tests -------------------------------------------------------------------------------------------------------

describe('svelte scope stamping fuzz', () => {
  const settings = fuzzSettings(DEFAULT_SETTINGS);

  it(
    `holds every rule over ${settings.runs} generated files (seed ${settings.seed})`,
    async () => {
      const {failure, usable, checked, unusable, reached, deepest} = await fuzz(settings);
      if (failure) expect.fail(describeFailure(failure));
      const why = `${usable} of ${checked} cases usable:\n${unusable.join('\n')}`;
      expect(usable, why).toBeGreaterThanOrEqual(Math.ceil(checked * USABLE_FLOOR));
      // A short replay need not reach every shape; a default-size run must, among the cases the rules checked.
      if (settings.runs < DEFAULT_SETTINGS.runs) return;
      expect(EXPECTED_FACTS.filter((fact) => !reached.has(fact))).toEqual([]);
      expect(deepest).toBeGreaterThanOrEqual(5);
    },
    // Node's timers take at most 2^31 - 1 ms; a longer one fires at once.
    Math.min(60_000 + settings.runs * 1_000, 2 ** 31 - 1)
  );

  // Each rule is proven live: a hand-broken output must make it fail, with a seed and a shrunk input.
  describe('negative controls', () => {
    const STAMP = / data-v-[0-9a-f]{8}=""/;
    const SPREAD = / \{\.\.\.__ucfScopeAttrs\(\w+(?:, '\w+')*\)\}/;
    const spreadOnLastStamp = (code: string) => {
      const spread = SPREAD.exec(code)?.[0];
      const last = [...code.matchAll(new RegExp(STAMP.source, 'g'))].at(-1);
      if (!spread || !last) return code;
      const end = last.index + last[0].length;
      return code.slice(0, end) + spread + code.slice(end);
    };
    const BROKEN: [string, Rule, Breaker][] = [
      ['an unclosed block', 'builds', {pre: (code) => `${code}\n{#if true}`}],
      ['the last stamp missing', 'stamps', {pre: (code) => dropLast(code, STAMP)}],
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
      ['a dropped forward', 'forwards', {pre: (code) => code.replace(SPREAD, '')}],
      // On the last stamped element, an inner one when the root has children.
      ['a forward on an inner element', 'forwards', {pre: (code) => spreadOnLastStamp(code)}],
      // The root reads `klass`, which the parent never passes: its class merge and its added class get nothing.
      [
        "the parent's class dropped",
        'forwards',
        {pre: (code) => code.replaceAll(/(\w)\.class\)/g, '$1.klass)').replaceAll(", 'class'", ", 'klass'")},
      ],
    ];

    it.each(BROKEN)(
      '%s fails rule %s',
      async (_, rule, broken) => {
        const {failure} = await fuzz(DEFAULT_SETTINGS, broken, rule);
        expect(failure?.violations.map((violation) => violation.rule)).toContain(rule);
        const {input, shrunk, runIndex, dir} = failure!;
        try {
          const outcome = (await checkCases({dir, breaker: broken, onlyRule: rule}, [shrunk])).get(shrunk.name)!;
          expect(outcome.usable && outcome.violations.map((violation) => violation.rule)).toContain(rule);
          expect(shrunk.applied.length).toBeLessThanOrEqual(input.applied.length);
          expect(describeFailure(failure!)).toContain(
            `MULTIFRONT_FUZZ_SEED=${DEFAULT_SETTINGS.seed} MULTIFRONT_FUZZ_RUNS=${runIndex + 1}`
          );
          expect(caseAt(DEFAULT_SETTINGS.seed, runIndex, dir).block).toBe(input.block);
        } finally {
          rmSync(dir, {recursive: true, force: true});
        }
      },
      300_000
    );
  });
});
