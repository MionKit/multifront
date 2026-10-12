// The Svelte scope stamping fuzz generator: real `.ucf` files recombined from the svelte/shapes/ fixtures.
import {copyFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {parse} from 'svelte/compiler';
import type {AST} from 'svelte/compiler';
import {classMapId, splitBlocks} from '@multifront/core';
import {TMP_DIR, componentPath, listComponents, readComponent} from '../../fixtures/index.ts';
import {createRandom, mixSeed} from './fuzz.ts';
import type {Action, Random} from './fuzz.ts';

export const ACTION_KINDS = ['splice', 'tricky', 'head', 'window', 'body', 'document', 'options-runes', 'module-script'] as const;
type ActionKind = (typeof ACTION_KINDS)[number];
export type SvelteAction = Action<ActionKind>;

const SPECIALS = ['head', 'window', 'body', 'document', 'options-runes'] as const;
type Special = (typeof SPECIALS)[number];
const SPECIAL_TYPES: Record<Special, string> = {
  head: 'SvelteHead',
  window: 'SvelteWindow',
  body: 'SvelteBody',
  document: 'SvelteDocument',
  'options-runes': 'SvelteOptions',
};

export const SCRIPT_LAYOUTS = ['none', 'instance', 'module', 'both'] as const;
type ScriptLayout = (typeof SCRIPT_LAYOUTS)[number];

const SHAPES_DIR = 'svelte/shapes';
export const FUZZ_DIR = join(TMP_DIR, 'svelte-fuzz');
export const CHILD_FILE = 'Child.svelte';

// --- the Svelte AST ----------------------------------------------------------------------------------------------

type Node = AST.BaseNode & Record<string, unknown>;

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';

// Keys that hold no code a free name can hide in.
const SKIPPED_KEYS = new Set(['typeAnnotation', 'typeParameters', 'typeArguments', 'returnType', 'metadata', 'loc', 'name_loc']);
const FRAGMENT_KEYS = ['fragment', 'consequent', 'alternate', 'body', 'fallback', 'pending', 'then', 'catch'] as const;

function patternNames(pattern: unknown, names: Set<string>): void {
  if (!isNode(pattern)) return;
  if (pattern.type === 'Identifier') names.add(pattern.name as string);
  else if (pattern.type === 'ObjectPattern')
    for (const property of pattern.properties as Node[])
      patternNames(property.type === 'RestElement' ? property : property.value, names);
  else if (pattern.type === 'ArrayPattern') for (const element of pattern.elements as Node[]) patternNames(element, names);
  else if (pattern.type === 'AssignmentPattern') patternNames(pattern.left, names);
  else if (pattern.type === 'RestElement') patternNames(pattern.argument, names);
}

const namesOf = (...patterns: unknown[]): Set<string> => {
  const names = new Set<string>();
  for (const pattern of patterns) patternNames(pattern, names);
  return names;
};

const union = (bound: ReadonlySet<string>, more: Iterable<string>) => new Set([...bound, ...more]);

/** Names read from outside: snippets, `{#each}`, `{:then}`, `{:catch}` and functions bind their own. */
function freeNames(value: unknown, bound: ReadonlySet<string>, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) freeNames(item, bound, found);
    return;
  }
  if (!isNode(value)) return;
  const visit = (child: unknown, inner: ReadonlySet<string> = bound) => freeNames(child, inner, found);
  switch (value.type) {
    case 'Identifier':
      if (!bound.has(value.name as string)) found.add(value.name as string);
      return;
    case 'MemberExpression':
      visit(value.object);
      if (value.computed) visit(value.property);
      return;
    case 'Property':
      if (value.computed) visit(value.key);
      visit(value.value);
      return;
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
    case 'FunctionDeclaration':
      visit(value.body, union(bound, namesOf(...(value.params as Node[]))));
      return;
    case 'Fragment': {
      const declared = (value.nodes as Node[]).flatMap((node) =>
        node.type === 'SnippetBlock' ? [(node.expression as Node).name as string] : []
      );
      visit(value.nodes, union(bound, declared));
      return;
    }
    case 'EachBlock': {
      visit(value.expression);
      const inner = union(bound, namesOf(value.context));
      if (typeof value.index === 'string') inner.add(value.index);
      visit(value.key, inner);
      visit(value.body, inner);
      visit(value.fallback);
      return;
    }
    case 'AwaitBlock':
      visit(value.expression);
      visit(value.pending);
      visit(value.then, union(bound, namesOf(value.value)));
      visit(value.catch, union(bound, namesOf(value.error)));
      return;
    case 'SnippetBlock':
      visit(value.body, union(bound, namesOf(...(value.parameters as Node[]))));
      return;
    case 'Component': {
      const root = (value.name as string).split('.')[0]!;
      if (!bound.has(root)) found.add(root);
      break;
    }
  }
  for (const [key, child] of Object.entries(value)) if (!SKIPPED_KEYS.has(key) && typeof child === 'object') visit(child);
}

function freeOf(value: unknown): Set<string> {
  const found = new Set<string>();
  freeNames(value, new Set(), found);
  return found;
}

// What a block binds for one of its fragments: `{#each}` context and index, `{:then}`, `{:catch}`, snippet parameters.
function bindsFor(node: Node, key: (typeof FRAGMENT_KEYS)[number]): Set<string> {
  if (node.type === 'EachBlock' && key === 'body') {
    const names = namesOf(node.context);
    if (typeof node.index === 'string') names.add(node.index);
    return names;
  }
  if (node.type === 'AwaitBlock') return key === 'then' ? namesOf(node.value) : key === 'catch' ? namesOf(node.error) : new Set();
  return node.type === 'SnippetBlock' ? namesOf(...(node.parameters as Node[])) : new Set();
}

/** Every node of a fragment tree with the names its enclosing blocks bind, `<svelte:head>` content left out when asked. */
function eachNode(
  value: unknown,
  visit: (node: Node, bound: ReadonlySet<string>) => void,
  intoHead = true,
  bound: ReadonlySet<string> = new Set()
): void {
  if (Array.isArray(value)) return value.forEach((item) => eachNode(item, visit, intoHead, bound));
  if (!isNode(value)) return;
  visit(value, bound);
  if (value.type === 'SvelteHead' && !intoHead) return;
  for (const key of FRAGMENT_KEYS) {
    const fragment = value[key];
    if (isNode(fragment) && fragment.type === 'Fragment')
      eachNode(fragment.nodes, visit, intoHead, union(bound, bindsFor(value, key)));
  }
  if (value.type === 'Fragment') eachNode(value.nodes, visit, intoHead, bound);
}

// --- harvest from the fixtures -----------------------------------------------------------------------------------

interface Parsed {
  content: string;
  root: AST.Root;
  styles: string[];
}

const PARSED: Parsed[] = listComponents(SHAPES_DIR).map((fixture) => {
  const {filename, source} = readComponent(fixture);
  const split = splitBlocks(source, filename);
  const content = split.targets.svelte!.content;
  return {content, root: parse(content, {modern: true}), styles: split.styles.map((style) => style.content)};
});

const slice = ({content}: Parsed, node: {start: number; end: number}) => content.slice(node.start, node.end);

/** A piece of a fixture and the names it reads from outside. */
interface Harvested {
  text: string;
  free: Set<string>;
}

interface Prop {
  name: string;
  text: string; // `label = 'Hello'`
}
interface Statement extends Harvested {
  declares: string[];
  runes: boolean;
}

const RUNE_CALL = /\$(state|derived|effect)\b/;
const PROPS: Prop[] = [];
const STATEMENTS: Statement[] = [];
const MODULE_STATEMENTS: Statement[] = [];
const TAKEN = new Set<string>();

function addProp(name: string, text: string): void {
  if (TAKEN.has(name)) return;
  TAKEN.add(name);
  PROPS.push({name, text});
}

function addStatement(list: Statement[], text: string, node: Node): void {
  const target = node.type === 'ExportNamedDeclaration' && isNode(node.declaration) ? node.declaration : node;
  const declares =
    target.type === 'ImportDeclaration'
      ? (target.specifiers as Node[]).map(({local}) => (local as Node).name as string)
      : target.type === 'VariableDeclaration'
        ? [...namesOf(...(target.declarations as Node[]).map(({id}) => id))]
        : [];
  if (!declares.length || declares.some((name) => TAKEN.has(name))) return;
  for (const name of declares) TAKEN.add(name);
  const free =
    target.type === 'ImportDeclaration' ? new Set<string>() : freeOf((target.declarations as Node[]).map(({init}) => init));
  list.push({text, declares, free, runes: RUNE_CALL.test(text)});
}

const isPropsCall = (init: unknown) =>
  isNode(init) && init.type === 'CallExpression' && isNode(init.callee) && init.callee.name === '$props';

// Props first, so a statement never takes a prop's name.
for (const parsed of PARSED) {
  for (const node of (parsed.root.instance?.content.body ?? []) as unknown as Node[]) {
    if (node.type === 'VariableDeclaration') {
      for (const {id, init} of node.declarations as Node[]) {
        if (!isPropsCall(init) || !isNode(id) || id.type !== 'ObjectPattern') continue;
        for (const property of id.properties as Node[])
          if (property.type === 'Property') addProp((property.key as Node).name as string, slice(parsed, property));
      }
    }
    const declaration = node.type === 'ExportNamedDeclaration' && isNode(node.declaration) ? node.declaration : undefined;
    if (declaration?.type === 'VariableDeclaration' && declaration.kind === 'let')
      for (const declarator of declaration.declarations as Node[])
        addProp((declarator.id as Node).name as string, slice(parsed, declarator));
  }
}
for (const parsed of PARSED) {
  for (const node of (parsed.root.instance?.content.body ?? []) as unknown as Node[]) {
    const props = node.type === 'VariableDeclaration' && (node.declarations as Node[]).some(({init}) => isPropsCall(init));
    if (!props && node.type !== 'ExportNamedDeclaration') addStatement(STATEMENTS, slice(parsed, node), node);
  }
  // A store subscription in `<script module>` is an error in the plain file.
  for (const node of (parsed.root.module?.content.body ?? []) as unknown as Node[])
    if (!slice(parsed, node).includes('$style')) addStatement(MODULE_STATEMENTS, slice(parsed, node), node);
}

// The plain file's store header takes these.
for (const name of ['style', 'readable', '__fuzzClasses'])
  if (TAKEN.has(name)) throw new Error(`a svelte/shapes/ fixture declares ${name}, which the plain file's store header uses`);

function needsTypeScript(text: string): boolean {
  try {
    parse(text, {modern: true});
    return false;
  } catch {
    return true;
  }
}

interface Snippet extends Harvested {
  name: string;
  ts: boolean;
}

const SNIPPETS: Snippet[] = [];
for (const parsed of PARSED) {
  for (const node of parsed.root.fragment.nodes) {
    if (node.type !== 'SnippetBlock') continue;
    const {name} = node.expression;
    if (TAKEN.has(name)) continue;
    TAKEN.add(name);
    const text = slice(parsed, node);
    SNIPPETS.push({name, text, free: freeOf(node), ts: needsTypeScript(text)});
  }
}

const SPECIAL_TEXT = {} as Record<Special, Harvested>;
for (const parsed of PARSED) {
  for (const node of parsed.root.fragment.nodes) {
    const special = SPECIALS.find((name) => SPECIAL_TYPES[name] === node.type);
    if (special) SPECIAL_TEXT[special] ??= {text: slice(parsed, node), free: freeOf(node)};
  }
  // `<svelte:options>` is not a fragment node.
  const {options} = parsed.root;
  if (options) SPECIAL_TEXT['options-runes'] ??= {text: slice(parsed, options), free: new Set()};
}
for (const special of SPECIALS)
  if (!SPECIAL_TEXT[special]) throw new Error(`no svelte/shapes/ fixture holds a ${SPECIAL_TYPES[special]}`);

/** What a name needs to be available: a prop, a statement, a header snippet or a `$` name (runes, `$style`). */
function available(name: string, legacy: boolean): boolean {
  if (name.startsWith('$') || name in globalThis) return true;
  if (PROPS.some((prop) => prop.name === name) || SNIPPETS.some((snippet) => snippet.name === name)) return true;
  if (MODULE_STATEMENTS.some((statement) => statement.declares.includes(name))) return true;
  const statement = STATEMENTS.find((candidate) => candidate.declares.includes(name));
  return !!statement && !(legacy && statement.runes) && [...statement.free].every((free) => available(free, legacy));
}

// The tags whose start the HTML parser lets close an open `<p>`: Svelte rejects them under one.
const CLOSES_P = new Set(
  'address article aside blockquote details div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre section table ul'.split(
    ' '
  )
);
const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const NO_SLOTS = new Set(['svg', 'title', 'textarea', 'script', 'style']);
const HEADINGS = /^h[1-6]$/;

interface Slot {
  at: number; // in the donor's text
  ancestors: string[];
  reset: boolean; // inside a component's children: the ancestors outside do not count
}

interface Donor extends Harvested {
  slots: Slot[];
  tops: string[]; // elements reached from the root through blocks only
  slot: boolean;
  render: boolean;
  ts: boolean;
}

function slotsOf(root: Node, base: number): Slot[] {
  const slots: Slot[] = [];
  const walk = (node: Node, ancestors: string[], reset: boolean): void => {
    const element = node.type === 'RegularElement' ? (node.name as string) : undefined;
    if (element && (VOID.has(element) || NO_SLOTS.has(element))) return;
    const component = ['Component', 'SvelteComponent', 'SvelteSelf'].includes(node.type);
    const inner = component ? [] : element ? [...ancestors, element] : ancestors;
    const innerReset = reset || component;
    for (const key of FRAGMENT_KEYS) {
      const fragment = node[key];
      if (!isNode(fragment) || fragment.type !== 'Fragment') continue;
      const nodes = fragment.nodes as Node[];
      const at = new Set<number>();
      nodes.forEach((child, index) => {
        if (child.elseif) return;
        if (!nodes[index - 1]?.elseif) at.add(child.start - base);
        if (index === nodes.length - 1) at.add(child.end - base);
      });
      for (const offset of at) slots.push({at: offset, ancestors: inner, reset: innerReset});
      for (const child of nodes) walk(child, inner, innerReset);
    }
  };
  walk(root, [], false);
  return slots;
}

function topsOf(node: Node): string[] {
  if (node.type === 'RegularElement') return [node.name as string];
  if (!node.type.endsWith('Block') || node.type === 'SnippetBlock') return [];
  return FRAGMENT_KEYS.flatMap((key) => {
    const fragment = node[key];
    return isNode(fragment) && fragment.type === 'Fragment' ? (fragment.nodes as Node[]).flatMap(topsOf) : [];
  });
}

// `{html}` where `const html = '<div>'`: text that looks like markup, escaped on render.
const readsMarkupString = (name: string) =>
  STATEMENTS.some(({declares, text}) => declares.includes(name) && /['"`][^'"`]*</.test(text));

const DONOR_TYPES = new Set([
  'RegularElement',
  'SvelteElement',
  'Component',
  'SvelteComponent',
  'IfBlock',
  'EachBlock',
  'AwaitBlock',
  'KeyBlock',
  'SnippetBlock',
  'SvelteBoundary',
  'RenderTag',
  'SlotElement',
]);

const DONORS: Donor[] = [];
const TRICKY: Donor[] = [];
for (const parsed of PARSED) {
  eachNode(
    parsed.root.fragment,
    (node, bound) => {
      const tricky =
        node.type === 'Comment' ||
        (['Text', 'ExpressionTag'].includes(node.type) && /[<>]/.test(slice(parsed, node))) ||
        (node.type === 'ExpressionTag' && [...freeOf(node)].some(readsMarkupString));
      const donor = DONOR_TYPES.has(node.type) && !node.elseif;
      if (!tricky && !donor) return;
      if (node.type === 'SnippetBlock' && SNIPPETS.some(({name}) => name === (node.expression as Node).name)) return;
      const text = slice(parsed, node);
      const free = freeOf(node);
      // `{item}` inside `{#each empty as item}` must not read the header snippet `item` once moved out.
      if ([...free].some((name) => bound.has(name) || !available(name, false))) return;
      const types = new Set<string>();
      eachNode(node, (child) => void types.add(child.type));
      (tricky ? TRICKY : DONORS).push({
        text,
        free,
        slots: tricky ? [] : slotsOf(node, node.start),
        tops: topsOf(node),
        slot: types.has('SlotElement'),
        render: types.has('RenderTag'),
        ts: needsTypeScript(text),
      });
    },
    false
  );
}

// The shapes' class rules, the first one of each selector.
const STYLE = (() => {
  const rules = new Map<string, string>();
  for (const {styles} of PARSED)
    for (const style of styles)
      for (const rule of style.match(/\.[\w-]+\s*\{[^}]*\}/g) ?? []) {
        const selector = rule.slice(0, rule.indexOf('{')).trim();
        if (!rules.has(selector)) rules.set(selector, rule);
      }
  return [...rules.values()].join('\n');
})();

// --- the model ---------------------------------------------------------------------------------------------------

interface Piece {
  donor: Donor;
  ancestors: string[]; // of the place it was inserted at
  inserts: {slot: number; piece: Piece}[];
}

interface Model {
  legacy: boolean;
  top: Piece[];
  specials: Special[];
  moduleScript: boolean;
}

export interface SvelteCase {
  name: string;
  legacy: boolean;
  base: number; // index into DONORS
  actions: SvelteAction[];
  applied: ActionKind[];
  block: string; // the `<svelte>` content
  plain: string; // the same with the store header
  layout: ScriptLayout;
}

function piecesOf(model: Model): Piece[] {
  const all: Piece[] = [];
  const visit = (piece: Piece) => {
    all.push(piece);
    piece.inserts.forEach(({piece: inner}) => visit(inner));
  };
  model.top.forEach(visit);
  return all;
}

function fits(donor: Donor, ancestors: string[]): boolean {
  return donor.tops.every((tag) => {
    if (CLOSES_P.has(tag) && ancestors.includes('p')) return false;
    if (HEADINGS.test(tag) && HEADINGS.test(ancestors.at(-1) ?? '')) return false;
    if (tag === 'li' && ancestors.findLast((name) => ['li', 'ul', 'ol'].includes(name)) === 'li') return false;
    return !(['button', 'a', 'form'].includes(tag) && ancestors.includes(tag));
  });
}

function compatible(model: Model, donor: Donor): boolean {
  if (![...donor.free].every((name) => available(name, model.legacy))) return false;
  const pieces = piecesOf(model);
  if (donor.slot && pieces.some(({donor: other}) => other.render)) return false;
  return !(donor.render && pieces.some(({donor: other}) => other.slot));
}

interface Place {
  piece?: Piece;
  slot: number; // a slot of `piece`, or an index into `model.top`
  ancestors: string[];
}

function places(model: Model): Place[] {
  const found: Place[] = [{slot: model.top.length, ancestors: []}];
  for (const piece of piecesOf(model))
    piece.donor.slots.forEach((slot, index) =>
      found.push({piece, slot: index, ancestors: slot.reset ? slot.ancestors : [...piece.ancestors, ...slot.ancestors]})
    );
  return found;
}

function insert(model: Model, donor: Donor, random: Random): void {
  const place = random.pick(places(model).filter(({ancestors}) => fits(donor, ancestors)));
  const piece: Piece = {donor, ancestors: place.ancestors, inserts: []};
  if (place.piece) place.piece.inserts.push({slot: place.slot, piece});
  else model.top.splice(random.int(model.top.length + 1), 0, piece);
}

function applicable(model: Model): ActionKind[] {
  return ACTION_KINDS.filter((kind) => {
    if (kind === 'splice') return DONORS.some((donor) => compatible(model, donor));
    if (kind === 'tricky') return TRICKY.some((donor) => compatible(model, donor));
    if (kind === 'module-script') return !model.moduleScript;
    if (model.specials.includes(kind)) return false;
    if (kind === 'options-runes' && model.legacy) return false;
    return [...SPECIAL_TEXT[kind].free].every((name) => available(name, model.legacy));
  });
}

function apply(model: Model, kind: ActionKind, random: Random): void {
  if (kind === 'splice' || kind === 'tricky') {
    const pool = (kind === 'splice' ? DONORS : TRICKY).filter((donor) => compatible(model, donor));
    insert(model, random.pick(pool), random);
  } else if (kind === 'module-script') model.moduleScript = true;
  else model.specials.push(kind);
}

// Skips an action that no longer applies, so the shrinker can drop an action another one needed.
function replay(legacy: boolean, base: number, actions: SvelteAction[]): Pick<SvelteCase, 'applied'> & {model: Model} {
  const model: Model = {legacy, top: [{donor: DONORS[base]!, ancestors: [], inserts: []}], specials: [], moduleScript: false};
  const applied: ActionKind[] = [];
  for (const action of actions) {
    if (!applicable(model).includes(action.kind)) continue;
    apply(model, action.kind, createRandom(action.seed));
    applied.push(action.kind);
  }
  return {model, applied};
}

// --- writing -----------------------------------------------------------------------------------------------------

function renderPiece(piece: Piece): string {
  const {text, slots} = piece.donor;
  const inserts = [...piece.inserts].sort((first, second) => slots[first.slot]!.at - slots[second.slot]!.at);
  let out = '';
  let from = 0;
  for (const {slot, piece: inner} of inserts) {
    const at = slots[slot]!.at;
    out += text.slice(from, at) + renderPiece(inner);
    from = at;
  }
  return out + text.slice(from);
}

const script = (attributes: string, lines: string[]) =>
  `<script${attributes} lang="ts">\n${lines.map((line) => `  ${line}`).join('\n')}\n</script>`;

function writeBlock(model: Model, filename: string): Pick<SvelteCase, 'block' | 'plain' | 'layout'> {
  const pieces = model.top.map(renderPiece);
  const specials = SPECIALS.filter((special) => model.specials.includes(special));
  // The free names of the markup, then of what it needs, until nothing new comes in.
  const need = new Set<string>();
  const add = (names: Iterable<string>) => {
    for (const name of names) need.add(name);
  };
  for (const piece of piecesOf(model)) add(piece.donor.free);
  for (const special of specials) add(SPECIAL_TEXT[special].free);
  for (let size = -1; size !== need.size;) {
    size = need.size;
    for (const snippet of SNIPPETS) if (need.has(snippet.name)) add(snippet.free);
    for (const statement of [...STATEMENTS, ...MODULE_STATEMENTS])
      if (statement.declares.some((name) => need.has(name))) add(statement.free);
  }
  const props = PROPS.filter(({name}) => need.has(name));
  const statements = STATEMENTS.filter(({declares}) => declares.some((name) => need.has(name)));
  const moduleStatements = MODULE_STATEMENTS.filter(
    ({declares}) => model.moduleScript || declares.some((name) => need.has(name))
  );
  const imports = statements.filter(({text}) => text.startsWith('import '));
  const others = statements.filter(({text}) => !text.startsWith('import '));
  const propLines = !props.length
    ? []
    : model.legacy
      ? props.map(({text}) => `export let ${text}`)
      : [`let { ${props.map(({text}) => text).join(', ')} } = $props()`];
  const instance = [...imports.map(({text}) => text), ...propLines, ...others.map(({text}) => text)];
  const ts = piecesOf(model).some(({donor}) => donor.ts) || SNIPPETS.some(({name, ts}) => need.has(name) && ts);
  const hasInstance = instance.length > 0 || ts;
  const hasModule = moduleStatements.length > 0;
  const layout: ScriptLayout = hasInstance ? (hasModule ? 'both' : 'instance') : hasModule ? 'module' : 'none';

  const write = (header: string[]) => {
    const lines: string[] = [];
    if (specials.includes('options-runes')) lines.push(SPECIAL_TEXT['options-runes'].text);
    if (hasModule)
      lines.push(
        script(
          ' module',
          moduleStatements.map(({text}) => text)
        )
      );
    const body = [...header, ...instance];
    if (body.length || hasInstance) lines.push(script('', body));
    for (const snippet of SNIPPETS) if (need.has(snippet.name)) lines.push(snippet.text);
    for (const special of specials) if (special !== 'options-runes') lines.push(SPECIAL_TEXT[special].text);
    lines.push(...pieces);
    return `\n${lines.join('\n')}\n`;
  };
  // Svelte's own `$style`: a store of the `.ucf` file's class map, so only our stamps and rename differ.
  const header = [
    `import {readable} from 'svelte/store'`,
    `import __fuzzClasses from ${JSON.stringify(classMapId(filename, 0))}`,
    'const style = readable(__fuzzClasses)',
  ];
  return {block: write([]), plain: write(header), layout};
}

export function buildCase(
  {legacy, base}: Pick<SvelteCase, 'legacy' | 'base'>,
  actions: SvelteAction[],
  {name, dir}: {name: string; dir: string}
): SvelteCase {
  const {model, applied} = replay(legacy, base, actions);
  const {block, plain, layout} = writeBlock(model, join(dir, `${name}.ucf`));
  return {name, legacy, base, actions, applied, block, plain, layout};
}

const WEIGHTS: Partial<Record<ActionKind, number>> = {splice: 6, tricky: 2};

export function caseAt(seed: number, runIndex: number, dir: string): SvelteCase {
  const random = createRandom(mixSeed(seed, 'run', runIndex));
  const legacy = random.int(4) === 0;
  const pool = DONORS.flatMap((donor, index) => ([...donor.free].every((name) => available(name, legacy)) ? [index] : []));
  const base = random.pick(pool);
  const actions: SvelteAction[] = [];
  const count = 1 + random.int(10);
  while (actions.length < count) {
    // Splices make the depth: they get more draws than the one-off specials.
    const kinds = applicable(replay(legacy, base, actions).model).flatMap((kind) =>
      Array<ActionKind>(WEIGHTS[kind] ?? 1).fill(kind)
    );
    actions.push({kind: random.pick(kinds), seed: random.int(2 ** 32)});
  }
  return buildCase({legacy, base}, actions, {name: `Fuzz${runIndex}`, dir});
}

export function ucfSource(fuzzCase: SvelteCase): string {
  return `<svelte>${fuzzCase.block}</svelte>\n\n<style module scoped>\n${STYLE}\n</style>\n`;
}

/** Writes `<name>.ucf`, its plain `<name>.svelte` and the shapes' `Child.svelte` the cases render. */
export function writeCase(dir: string, fuzzCase: SvelteCase): {ucf: string; plain: string} {
  copyFileSync(componentPath(`${SHAPES_DIR}/${CHILD_FILE}`), join(dir, CHILD_FILE));
  const ucf = join(dir, `${fuzzCase.name}.ucf`);
  const plain = join(dir, `${fuzzCase.name}.svelte`);
  writeFileSync(ucf, ucfSource(fuzzCase));
  writeFileSync(plain, fuzzCase.plain);
  return {ucf, plain};
}

/** The shape facts the coverage test reads. */
export function shapeOf(fuzzCase: SvelteCase): string[] {
  const facts = [`mode:${fuzzCase.legacy ? 'legacy' : 'runes'}`, `script:${fuzzCase.layout}`];
  const root = parse(fuzzCase.block, {modern: true});
  if (root.options) facts.push('type:SvelteOptions');
  let deepest = 0;
  const visit = (value: unknown, depth: number): void => {
    if (Array.isArray(value)) return value.forEach((item) => visit(item, depth));
    if (!isNode(value)) return;
    facts.push(`type:${value.type}`);
    deepest = Math.max(deepest, depth);
    for (const key of FRAGMENT_KEYS) {
      const fragment = value[key];
      if (isNode(fragment) && fragment.type === 'Fragment') visit(fragment.nodes, depth + 1);
    }
  };
  visit(root.fragment.nodes, 1);
  facts.push(`depth:${deepest}`);
  return facts;
}
