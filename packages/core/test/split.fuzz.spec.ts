import {describe, expect, it} from 'vitest';
import {checkBlocks, getBlockKind, splitBlocks} from '@multifront/core';
import type {Block, BlockTag, Diagnostic, SplitResult} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {componentPath, listComponents, readComponent} from '../../e2e/fixtures/index.ts';
import {DEFAULT_FUZZ_SETTINGS, createRandom, describeFailure, fuzzSettings, mixSeed, runFuzz} from './fuzz.ts';
import type {FuzzFailure, Random, Violation} from './fuzz.ts';
import {tsxSyntaxErrors} from './tsx.ts';

const SPEC_PATH = 'packages/core/test/split.fuzz.spec.ts';

const ACTION_KINDS = [
  'shuffle',
  'gap',
  'requote',
  'recombine',
  'duplicate',
  'delete-close',
  'close-in-string',
  'truncate',
] as const;
type ActionKind = (typeof ACTION_KINDS)[number];

interface Action {
  kind: ActionKind;
  seed: number;
}

interface ModelBlock {
  type: BlockTag;
  open: string;
  content: string;
  close: string;
  attrs: Block['attrs'];
  intact: boolean; // opening tag, content and closing tag all read as the fixture's did
}

interface Model {
  gaps: string[]; // gaps[i] comes before blocks[i]; one more gap than blocks
  blocks: ModelBlock[];
  deletedCloses: number;
  closeInString: boolean;
  cuts: number[]; // truncate points as fractions of the length, applied last
}

type PlacedBlock = ModelBlock & Pick<Block, 'start' | 'contentStart' | 'contentEnd' | 'end'>;

// `placed` is missing once the shrinker cuts raw lines: only the model-free rules (1 to 3) apply then.
interface FuzzCase {
  fixture: string;
  actions: Action[];
  applied: ActionKind[];
  source: string;
  placed?: PlacedBlock[];
  damaged?: boolean;
}

type Splitter = (source: string, filename: string) => SplitResult;

// --- fixtures --------------------------------------------------------------------------------------------------

const FIXTURES = listComponents();

const BASE_MODELS = new Map(
  FIXTURES.map((name) => {
    const {filename, source} = readComponent(name);
    return [name, modelOf(splitBlocks(source, filename))];
  })
);

function modelOf(split: SplitResult): Model {
  const {source, blocks} = split;
  const gaps = blocks.map((block, index) => source.slice(index ? blocks[index - 1]!.end : 0, block.start));
  gaps.push(source.slice(blocks.at(-1)?.end ?? 0));
  return {
    gaps,
    blocks: blocks.map((block) => ({
      type: block.type,
      open: source.slice(block.start, block.contentStart),
      content: block.content,
      close: source.slice(block.contentEnd, block.end),
      attrs: block.attrs,
      intact: true,
    })),
    deletedCloses: 0,
    closeInString: false,
    cuts: [],
  };
}

// Real HTML comments found between the blocks of the valid fixtures.
const GAP_COMMENTS = [...BASE_MODELS.values()].flatMap((model) => model.gaps.flatMap((gap) => gap.match(/<!--[^]*?-->/g) ?? []));

// Lines of TsxEdges' <react> block that are a statement on their own and cannot close a block.
const DONOR_LINES = BASE_MODELS.get('TsxEdges.ucf')!
  .blocks.filter((block) => block.type === 'react')
  .flatMap((block) => block.content.split('\n'))
  .map((line) => line.trim())
  .filter((line) => line && !/<\/react[\s>]/.test(line) && !tsxSyntaxErrors(line).length);

const QUOTED_RUN = /'[^'\n]*'|"[^"\n]*"/g;

// --- input maker -----------------------------------------------------------------------------------------------

const isTarget = (block: ModelBlock) => getBlockKind(block.type).role === 'target';
const quotedRuns = (block: ModelBlock) => [...block.content.matchAll(QUOTED_RUN)];

function applicable(model: Model): ActionKind[] {
  const {blocks} = model;
  const react = blocks.filter((block) => block.type === 'react');
  return ACTION_KINDS.filter((kind) => {
    if (kind === 'shuffle') return blocks.length > 1;
    if (kind === 'requote') return blocks.length > 0;
    if (kind === 'recombine') return react.length > 0;
    if (kind === 'duplicate') return blocks.some(isTarget);
    if (kind === 'delete-close') return blocks.some((block) => block.close);
    if (kind === 'close-in-string') return react.some((block) => quotedRuns(block).length);
    return true;
  });
}

function whitespace(random: Random, chars: readonly string[]): string {
  return Array.from({length: 1 + random.int(3)}, () => random.pick(chars)).join('');
}

function requote(block: ModelBlock, random: Random): string {
  const parts = Object.entries(block.attrs).map(([name, value]) => {
    if (value === true) return name;
    const quotes = ['"', "'"].filter((quote) => !value.includes(quote));
    if (value && !/[\s"'=<>`]/.test(value)) quotes.push('');
    const quote = random.pick(quotes);
    const equals = random.pick(['', ' ', '  ', '\t']);
    return `${name}${equals}=${random.pick(['', equals])}${quote}${value}${quote}`;
  });
  const separators = [' ', '\t', '\n'];
  return `<${block.type}${parts.map((part) => whitespace(random, separators) + part).join('')}${random.pick(['', whitespace(random, separators)])}>`;
}

function apply(model: Model, kind: ActionKind, random: Random): void {
  const {blocks, gaps} = model;
  if (kind === 'shuffle') model.blocks = random.shuffle(blocks);
  else if (kind === 'gap') {
    const index = random.int(gaps.length);
    const text = GAP_COMMENTS.length && random.int(2) ? random.pick(GAP_COMMENTS) : whitespace(random, [' ', '\t', '\n', '\r\n']);
    gaps[index] = random.int(2) ? text + gaps[index] : gaps[index] + text;
  } else if (kind === 'requote') {
    const block = random.pick(blocks);
    block.open = requote(block, random);
  } else if (kind === 'recombine') {
    const block = random.pick(blocks.filter((candidate) => candidate.type === 'react'));
    block.content = `\n  ${random.pick(DONOR_LINES)};${block.content}`;
  } else if (kind === 'duplicate') {
    const index = random.int(blocks.length + 1);
    blocks.splice(index, 0, {...random.pick(blocks.filter(isTarget))});
    gaps.splice(index + 1, 0, '\n\n');
  } else if (kind === 'delete-close') {
    const block = random.pick(blocks.filter((candidate) => candidate.close));
    block.close = '';
    block.intact = false;
    model.deletedCloses++;
  } else if (kind === 'close-in-string') {
    const block = random.pick(blocks.filter((candidate) => candidate.type === 'react' && quotedRuns(candidate).length));
    const at = random.pick(quotedRuns(block)).index + 1;
    block.content = `${block.content.slice(0, at)}</react>${block.content.slice(at)}`;
    block.intact = false;
    model.closeInString = true;
  } else model.cuts.push(random.next());
}

// Replays `actions` on the fixture; an action that no longer applies (the shrinker dropped what it needed) is skipped.
function replay(fixture: string, actions: Action[]): {model: Model; applied: ActionKind[]} {
  const base = BASE_MODELS.get(fixture)!;
  const model: Model = {...base, gaps: [...base.gaps], blocks: base.blocks.map((block) => ({...block})), cuts: []};
  const applied: ActionKind[] = [];
  // A truncation runs last, so its cut lands in the final text.
  const ordered = [
    ...actions.filter((action) => action.kind !== 'truncate'),
    ...actions.filter((action) => action.kind === 'truncate'),
  ];
  for (const action of ordered) {
    if (!applicable(model).includes(action.kind)) continue;
    apply(model, action.kind, createRandom(action.seed));
    applied.push(action.kind);
  }
  return {model, applied};
}

function build(fixture: string, actions: Action[]): FuzzCase {
  const {model, applied} = replay(fixture, actions);
  let source = model.gaps[0]!;
  const placed: PlacedBlock[] = model.blocks.map((block, index) => {
    const start = source.length;
    const contentStart = start + block.open.length;
    const contentEnd = contentStart + block.content.length;
    source += block.open + block.content + block.close + model.gaps[index + 1];
    return {...block, start, contentStart, contentEnd, end: contentEnd + block.close.length};
  });
  for (const cut of model.cuts) source = source.slice(0, Math.floor(cut * (source.length + 1)));
  const kept = placed
    .filter((block) => block.start < source.length)
    .map((block) => (block.end <= source.length ? block : {...block, intact: false}));
  const damaged = model.deletedCloses > 0 || model.closeInString || model.cuts.length > 0;
  return {fixture, actions, applied, source, placed: kept, damaged};
}

function generate(random: Random): FuzzCase {
  const fixture = random.pick(FIXTURES);
  const actions: Action[] = [];
  const count = 1 + random.int(4);
  while (actions.length < count) {
    actions.push({kind: random.pick(applicable(replay(fixture, actions).model)), seed: random.int(2 ** 32)});
  }
  return build(fixture, actions);
}

// --- rules -----------------------------------------------------------------------------------------------------

interface Outcome {
  split: SplitResult;
  diagnostics: Diagnostic[];
}

const parsesMemo = new Map<string, boolean>();
function parsesAsTsx(code: string): boolean {
  if (!parsesMemo.has(code)) parsesMemo.set(code, !tsxSyntaxErrors(code).length);
  return parsesMemo.get(code)!;
}

function realPosition(source: string, offset: number): {line: number; column: number} {
  const lines = source.slice(0, offset).split('\n');
  return {line: lines.length, column: lines.at(-1)!.length};
}

const fieldsOf = (block: Pick<Block, 'type' | 'attrs' | 'content' | 'start' | 'contentStart' | 'contentEnd' | 'end'>) =>
  JSON.stringify([block.type, block.attrs, block.content, block.start, block.contentStart, block.contentEnd, block.end]);

function intactPrefix(placed: PlacedBlock[]): PlacedBlock[] {
  const firstBroken = placed.findIndex((block) => !block.intact);
  return firstBroken === -1 ? placed : placed.slice(0, firstBroken);
}

// Each non-first block of a target, among `blocks`.
function extraTargetCopies(blocks: PlacedBlock[]): PlacedBlock[] {
  const seen = new Set<BlockTag>();
  return blocks.filter((block) => getBlockKind(block.type).role === 'target' && (seen.has(block.type) || !seen.add(block.type)));
}

// The block whose closing tag was deleted, when that is the only damage and nothing later can close it.
function soleUnclosable(fuzzCase: FuzzCase): PlacedBlock | undefined {
  const {placed, source, applied} = fuzzCase;
  const damage = applied.filter((kind) => kind === 'delete-close' || kind === 'close-in-string' || kind === 'truncate');
  if (!placed || damage.length !== 1 || damage[0] !== 'delete-close') return undefined;
  const block = placed.find((candidate) => !candidate.close)!;
  return new RegExp(`</${block.type}[\\s>]`).test(source.slice(block.contentStart)) ? undefined : block;
}

function checkPositions({source}: FuzzCase, {diagnostics}: Outcome): Violation[] {
  return diagnostics.flatMap((diagnostic) => {
    const {code, start, end, line, column} = diagnostic;
    if (!(0 <= start && start <= end && end <= source.length))
      return [{rule: 'positions', message: `${code} range [${start}, ${end}) is outside the file (length ${source.length})`}];
    const real = realPosition(source, start);
    if (real.line === line && real.column === column) return [];
    return [{rule: 'positions', message: `${code} at ${line}:${column}, but offset ${start} is at ${real.line}:${real.column}`}];
  });
}

function checkStructure({source}: FuzzCase, {split}: Outcome): Violation[] {
  if (split.errors.length) return [];
  const fail = (message: string): Violation[] => [{rule: 'structure', message}];
  let rebuilt = '';
  let previousEnd = 0;
  for (const block of split.blocks) {
    const gap = source.slice(previousEnd, block.start);
    if (block.start < previousEnd) return fail(`<${block.type}> at ${block.start} overlaps the block before it`);
    if (!/^(\s|<!--[^]*?-->)*$/.test(gap)) return fail(`text between blocks before ${block.start}: ${JSON.stringify(gap)}`);
    const opening = source.slice(block.start, block.contentStart);
    const closing = source.slice(block.contentEnd, block.end);
    if (!new RegExp(`^<${block.type}(\\s[^]*)?>$`).test(opening))
      return fail(`<${block.type}> at ${block.start} has opening tag ${JSON.stringify(opening)}`);
    if (!new RegExp(`^</${block.type}\\s*>$`).test(closing))
      return fail(`<${block.type}> at ${block.start} has closing tag ${JSON.stringify(closing)}`);
    if (source.slice(block.contentStart, block.contentEnd) !== block.content)
      return fail(`<${block.type}> at ${block.start}: content is not the text between its tags`);
    rebuilt += gap + opening + block.content + closing;
    previousEnd = block.end;
  }
  const tail = source.slice(previousEnd);
  if (!/^(\s|<!--[^]*?-->)*$/.test(tail)) return fail(`text after the last block: ${JSON.stringify(tail)}`);
  return rebuilt + tail === source ? [] : fail('gaps plus blocks do not rebuild the file');
}

function checkUntouched({placed}: FuzzCase, {split}: Outcome): Violation[] {
  if (!placed) return [];
  const violations: Violation[] = [];
  const fail = (message: string) => violations.push({rule: 'untouched', message});
  const matched: Block[] = [];
  const counts = new Map<BlockTag, number>();
  intactPrefix(placed).forEach((expected, position) => {
    const index = counts.get(expected.type) ?? 0;
    counts.set(expected.type, index + 1);
    const found = split.blocks[position];
    if (!found || fieldsOf(found) !== fieldsOf(expected) || found.index !== index)
      fail(`untouched <${expected.type}> at ${expected.start} came back as ${found ? fieldsOf(found) : 'nothing'}`);
    else matched.push(found);
  });
  for (const expected of placed.slice(intactPrefix(placed).length).filter((block) => block.intact)) {
    const found = split.blocks.find((block) => block.start === expected.start);
    if (!found) continue;
    if (fieldsOf(found) !== fieldsOf(expected))
      fail(`untouched <${expected.type}> at ${expected.start} came back as ${fieldsOf(found)}`);
    else matched.push(found);
  }
  for (const block of matched.filter((candidate) => candidate.type === 'react'))
    if (!parsesAsTsx(block.content)) fail(`untouched <react> at ${block.start} no longer parses as TSX`);
  return violations;
}

function checkKnownOutcomes(fuzzCase: FuzzCase, {split, diagnostics}: Outcome): Violation[] {
  const {placed, damaged} = fuzzCase;
  if (!placed) return [];
  const fail = (message: string): Violation[] => [{rule: 'known-outcome', message}];
  const hasError = (code: Diagnostic['code'], start: number) =>
    split.errors.some((error) => error.code === code && error.start === start);
  if (!damaged) {
    const expected = extraTargetCopies(placed).map((block) => ['duplicate-target', block.start, block.contentStart]);
    const actual = split.errors.map((error) => [error.code, error.start, error.end]);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      return fail(`undamaged file: expected errors ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    if (JSON.stringify(diagnostics) !== JSON.stringify(split.errors))
      return fail(
        `undamaged file: checkBlocks added ${JSON.stringify(diagnostics.filter((found) => !split.errors.includes(found)))}`
      );
    return [];
  }
  const missing = extraTargetCopies(intactPrefix(placed)).find((block) => !hasError('duplicate-target', block.start));
  if (missing) return fail(`duplicated <${missing.type}> at ${missing.start} has no duplicate-target`);
  const unclosable = soleUnclosable(fuzzCase);
  if (unclosable && !hasError('unclosed-block', unclosable.start))
    return fail(`<${unclosable.type}> at ${unclosable.start} lost its closing tag but has no unclosed-block`);
  return [];
}

function checkCase(fuzzCase: FuzzCase, splitter: Splitter = splitBlocks): Violation[] {
  let outcome: Outcome;
  try {
    const split = splitter(fuzzCase.source, componentPath(fuzzCase.fixture));
    outcome = {split, diagnostics: checkBlocks(split)};
  } catch (err) {
    return [{rule: 'never-throws', message: String(err)}];
  }
  return [checkPositions, checkStructure, checkUntouched, checkKnownOutcomes].flatMap((rule) => rule(fuzzCase, outcome));
}

// --- shrinker --------------------------------------------------------------------------------------------------

function shrink(fuzzCase: FuzzCase, stillFails: (candidate: FuzzCase) => boolean): FuzzCase {
  let {actions} = fuzzCase;
  for (let index = 0; index < actions.length;) {
    const fewer = actions.filter((_, other) => other !== index);
    const candidate = build(fuzzCase.fixture, fewer);
    // Dropping a truncation can lengthen the file: only a shorter or equal failing file counts as smaller.
    if (candidate.source.length <= build(fuzzCase.fixture, actions).source.length && stillFails(candidate)) actions = fewer;
    else index++;
  }
  const smallest = build(fuzzCase.fixture, actions);
  // Raw text has no model, so only a model-free rule can still fail on it.
  const raw = (lines: string[]): FuzzCase => ({
    fixture: smallest.fixture,
    actions,
    applied: smallest.applied,
    source: lines.join(''),
  });
  let lines = smallest.source.split(/(?<=\n)/);
  if (!stillFails(raw(lines))) return smallest;
  for (let chunk = Math.ceil(lines.length / 2); chunk >= 1; chunk = chunk === 1 ? 0 : Math.ceil(chunk / 2)) {
    for (let start = 0; start < lines.length;) {
      const fewer = [...lines.slice(0, start), ...lines.slice(start + chunk)];
      if (stillFails(raw(fewer))) lines = fewer;
      else start += chunk;
    }
  }
  return raw(lines);
}

const showCase = (fuzzCase: FuzzCase) =>
  `  fixture ${fuzzCase.fixture}, actions ${JSON.stringify(fuzzCase.applied)}\n  source ${JSON.stringify(fuzzCase.source)}`;

// `onlyRule` keeps one rule's violations, so a negative control proves that rule on its own.
function fuzz(splitter: Splitter = splitBlocks, settings = fuzzSettings(), onlyRule?: string): FuzzFailure<FuzzCase> | undefined {
  const check = (fuzzCase: FuzzCase) =>
    checkCase(fuzzCase, splitter).filter((violation) => !onlyRule || violation.rule === onlyRule);
  return runFuzz({...settings, generate, check, shrink});
}

// --- tests -----------------------------------------------------------------------------------------------------

describe('splitBlocks fuzz', () => {
  const {seed, runs} = fuzzSettings();

  it(`holds every rule over ${runs} generated files (seed ${seed})`, () => {
    const failure = fuzz();
    if (failure) expect.fail(describeFailure(failure, SPEC_PATH, showCase));
  });

  it('reaches every case', () => {
    const reached = new Set<string>();
    for (let runIndex = 0; runIndex < DEFAULT_FUZZ_SETTINGS.runs; runIndex++) {
      const fuzzCase = generate(createRandom(mixSeed(DEFAULT_FUZZ_SETTINGS.seed, 'run', runIndex)));
      const split = splitBlocks(fuzzCase.source, componentPath(fuzzCase.fixture));
      const placed = fuzzCase.placed!;
      const prefix = intactPrefix(placed);
      for (const kind of fuzzCase.applied) reached.add(kind);
      if (!split.errors.length) reached.add('error-free file');
      if (!fuzzCase.damaged) reached.add('undamaged file');
      if (!fuzzCase.damaged && extraTargetCopies(placed).length) reached.add('undamaged duplicate');
      if (fuzzCase.damaged && prefix.length) reached.add('damaged file with an intact prefix');
      if (fuzzCase.damaged && extraTargetCopies(prefix).length) reached.add('damaged file with a duplicate in the intact prefix');
      const later = placed.slice(prefix.length).filter((block) => block.intact);
      if (later.some((block) => split.blocks.some((found) => found.start === block.start)))
        reached.add('intact block after damage');
      if (soleUnclosable(fuzzCase)) reached.add('sole unclosable closing tag');
    }
    expect([...reached].sort()).toEqual(
      [
        ...ACTION_KINDS,
        'error-free file',
        'undamaged file',
        'undamaged duplicate',
        'damaged file with an intact prefix',
        'damaged file with a duplicate in the intact prefix',
        'intact block after damage',
        'sole unclosable closing tag',
      ].sort()
    );
  });

  // Each rule is proven live: a deliberately broken splitter must make it fail, with a seed and a shrunk input.
  describe('negative controls', () => {
    const mapBlocks = (split: SplitResult, change: (block: Block) => Block): SplitResult => ({
      ...split,
      blocks: split.blocks.map(change),
    });
    const withoutCode =
      (code: Diagnostic['code']): Splitter =>
      (source, filename) => {
        const split = splitBlocks(source, filename);
        return {...split, errors: split.errors.filter((error) => error.code !== code)};
      };
    const BROKEN: [string, string, Splitter][] = [
      [
        'a throw on truncated input',
        'never-throws',
        (source, filename) => {
          if (!source.trimEnd().endsWith('>')) throw new Error('cannot split a truncated file');
          return splitBlocks(source, filename);
        },
      ],
      [
        'a column one too far',
        'positions',
        (source, filename) => {
          const split = splitBlocks(source, filename);
          return {...split, errors: split.errors.map((error) => ({...error, column: error.column + 1}))};
        },
      ],
      [
        'an off-by-one content start',
        'structure',
        (source, filename) =>
          mapBlocks(splitBlocks(source, filename), (block) => ({
            ...block,
            contentStart: block.contentStart + 1,
            content: source.slice(block.contentStart + 1, block.contentEnd),
          })),
      ],
      [
        'a <react> block cut early',
        'untouched',
        (source, filename) =>
          mapBlocks(splitBlocks(source, filename), (block) => {
            if (block.type !== 'react') return block;
            const content = block.content.slice(0, block.content.lastIndexOf('\n', block.content.length - 2) + 1);
            return {...block, content, contentEnd: block.contentStart + content.length};
          }),
      ],
      ['a missing duplicate-target', 'known-outcome', withoutCode('duplicate-target')],
      ['a missing unclosed-block', 'known-outcome', withoutCode('unclosed-block')],
    ];

    it.each(BROKEN)('%s fails rule %s', (_, rule, splitter) => {
      const failure = fuzz(splitter, DEFAULT_FUZZ_SETTINGS, rule);
      expect(failure?.violations.map((violation) => violation.rule)).toContain(rule);
      const {input, shrunk} = failure!;
      expect(checkCase(shrunk, splitter).map((violation) => violation.rule)).toContain(rule);
      expect(shrunk.source.length).toBeLessThanOrEqual(input.source.length);
      expect(describeFailure(failure!, SPEC_PATH, showCase)).toContain(
        `MULTIFRONT_FUZZ_SEED=${DEFAULT_FUZZ_SETTINGS.seed} MULTIFRONT_FUZZ_RUNS=${failure!.runIndex + 1}`
      );
    });
  });
});
