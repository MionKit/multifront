// The scope transform fuzz generator: real `.ucf` files recombined from the react shapes/ and scope/ fixtures.
import {writeFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {Visitor, parseSync, visitorKeys} from 'oxc-parser';
import type {Comment, JSXChild, JSXElement, JSXFragment, Node, Program} from 'oxc-parser';
import {splitBlocks} from '@multifront/core';
import {TMP_DIR, componentPath, listComponents, readComponent} from '../../fixtures/index.ts';
import {createRandom, mixSeed} from './fuzz.ts';
import type {Action, Random} from './fuzz.ts';

export const ACTION_KINDS = [
  'memo',
  'forwardRef',
  'arrow',
  'expression-body',
  'props',
  'export-style',
  'generic',
  'early-return',
  'ternary',
  'and',
  'parens',
  'const-root',
  'swap-tag',
  'splice-child',
  'comment',
  'less-than',
  'unicode',
  'use-client',
  'scoped',
] as const;
type ActionKind = (typeof ACTION_KINDS)[number];
export type ScopeAction = Action<ActionKind>;

export const OUTCOMES = ['host', 'forwarding-component', 'dropping-component', 'fragment', 'none'] as const;
type Outcome = (typeof OUTCOMES)[number];

/** What the generator built, so the checks never redo the transform. */
export interface ScopeCase {
  name: string;
  fixture: string;
  actions: ScopeAction[];
  applied: ActionKind[];
  source: string;
  // Rendered by rule 4; such a case never holds a namespace tag, which React's JSX transform rejects.
  render: boolean;
  props: 'props' | '__props';
  branches: {branch?: string; outcome: Outcome}[];
  model: Model;
}

// --- the model -------------------------------------------------------------------------------------------------

interface ElementNode {
  kind: 'element';
  tag: string;
  typeArgs: string;
  attrs: string[];
  children: Child[];
  selfClosing: boolean;
}
interface FragmentNode {
  kind: 'fragment';
  tag: string; // '' for `<>`
  attrs: string[];
  children: Child[];
}
type JsxNode = ElementNode | FragmentNode;
type Child = JsxNode | {kind: 'raw'; text: string};

interface Guard {
  value: string;
  constant: boolean; // its value when the component has no props to read a branch from
  less: boolean;
}

type Expr =
  | {kind: 'jsx'; tree: JsxNode}
  | {kind: 'null'}
  | {kind: 'text'}
  | {kind: 'parens'; inner: Expr}
  | {kind: 'ternary'; guard: Guard; yes: Expr; no: Expr}
  | {kind: 'and'; guard: Guard; right: Expr};

interface Return {
  guard?: Guard;
  expr: Expr;
  viaConst: boolean;
  comment?: string; // a comment statement before it
}

interface Wrapper {
  api: keyof typeof CALLEES;
  callee: string;
}

type Props = {kind: 'plain'} | {kind: 'destructured'; variant: number; comment?: string} | {kind: 'none'};

interface Model {
  wrappers: Wrapper[]; // innermost first
  refTypes: string; // forwardRef's type arguments
  arrow: boolean;
  expression: boolean;
  generic: boolean;
  nameComment?: string;
  props: Props;
  exportStyle: 'direct' | 'identifier' | 'as-default';
  returns: Return[]; // the last one has no guard
  useClient: boolean;
  unicodeHeader: boolean;
  scoped: boolean;
  guards: number;
}

// --- harvest from the fixtures ---------------------------------------------------------------------------------

// React's Fragment as the header names it: `<>`, `Fragment`, `Frag` (alias) and `React.Fragment`.
export const FRAGMENT_TAGS = ['', 'Fragment', 'Frag', 'React.Fragment'];
const STAMPED = 'react/scope/Stamped.ucf';
const NAMESPACED = 'react/scope/Namespaced.ucf';
const UNICODE = 'react/Unicode.ucf';
const ARROW_EXPRESSION = 'react/shapes/ArrowExpression.ucf';
const SOURCES = [...listComponents('react/shapes'), STAMPED, NAMESPACED];
// Each fuzz directory sits right under this one, so the import of ArrowExpression is the same from all of them.
export const FUZZ_DIR = join(TMP_DIR, 'fuzz');

interface Parsed {
  content: string;
  program: Program;
  comments: Comment[];
}

function parseBlock(fixture: string): Parsed {
  const {filename, source} = readComponent(fixture);
  const content = splitBlocks(source, filename).targets.react!.content;
  const {program, comments, errors} = parseSync('Block.tsx', content, {lang: 'tsx', sourceType: 'module'});
  if (errors.length) throw new Error(`${fixture} does not parse`);
  return {content, program, comments};
}

function bindings(node: Node | null): string[] {
  if (!node) return [];
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'ObjectPattern')
    return node.properties.flatMap((prop) => bindings(prop.type === 'RestElement' ? prop.argument : prop.value));
  if (node.type === 'ArrayPattern') return node.elements.flatMap(bindings);
  if (node.type === 'AssignmentPattern') return bindings(node.left);
  return node.type === 'RestElement' ? bindings(node.argument) : [];
}

function declared(statement: Node): string[] {
  if (statement.type === 'ImportDeclaration') return statement.specifiers.map(({local}) => local.name);
  if (statement.type === 'VariableDeclaration') return statement.declarations.flatMap(({id}) => bindings(id));
  return 'id' in statement && statement.id?.type === 'Identifier' ? [statement.id.name] : [];
}

const TYPE_KEYS = new Set(['typeAnnotation', 'typeArguments', 'typeParameters', 'returnType']);

// Names a donor reads from outside itself; types, keys and host tags are no reads.
function freeNames(node: Node, bound: ReadonlySet<string>, found: Set<string>): void {
  const visit = (child: Node | null | undefined, inner = bound): void => {
    if (child) freeNames(child, inner, found);
  };
  switch (node.type) {
    case 'Identifier':
      if (!bound.has(node.name)) found.add(node.name);
      return;
    case 'MemberExpression':
      visit(node.object);
      if (node.computed) visit(node.property);
      return;
    case 'Property':
      if (node.computed) visit(node.key);
      visit(node.value);
      return;
    case 'ArrowFunctionExpression':
    case 'FunctionExpression': {
      const inner = new Set([...bound, ...node.params.flatMap(bindings)]);
      visit(node.body, inner);
      return;
    }
    case 'JSXOpeningElement': {
      const {name} = node;
      const root = name.type === 'JSXMemberExpression' ? name.object : name;
      if (root.type === 'JSXIdentifier' && /^[A-Z]/.test(root.name) && !bound.has(root.name)) found.add(root.name);
      for (const attribute of node.attributes) visit(attribute.type === 'JSXAttribute' ? attribute.value : attribute.argument);
      return;
    }
    case 'JSXClosingElement':
      return;
    default:
      for (const key of visitorKeys[node.type] ?? []) {
        if (TYPE_KEYS.has(key)) continue;
        const child: unknown = (node as unknown as Record<string, unknown>)[key];
        for (const item of Array.isArray(child) ? child : [child])
          if (item && typeof item === 'object' && 'type' in item) visit(item as Node);
      }
  }
}

function toTree(node: JSXElement | JSXFragment, text: string): JsxNode {
  const slice = ({start, end}: {start: number; end: number}) => text.slice(start, end);
  const children = (list: JSXChild[]): Child[] =>
    list.map((child) =>
      child.type === 'JSXElement' || child.type === 'JSXFragment' ? toTree(child, text) : {kind: 'raw', text: slice(child)}
    );
  if (node.type === 'JSXFragment') return {kind: 'fragment', tag: '', attrs: [], children: children(node.children)};
  const opening = node.openingElement;
  const tag = slice(opening.name);
  const attrs = opening.attributes.map(slice);
  if (FRAGMENT_TAGS.includes(tag)) return {kind: 'fragment', tag, attrs, children: children(node.children)};
  return {
    kind: 'element',
    tag,
    typeArgs: opening.typeArguments ? slice(opening.typeArguments) : '',
    attrs,
    children: children(node.children),
    selfClosing: opening.selfClosing,
  };
}

function hasNamespace(tree: JsxNode): boolean {
  return (
    (tree.kind === 'element' && tree.tag.includes(':')) ||
    tree.children.some((child) => child.kind !== 'raw' && hasNamespace(child))
  );
}

const stamped = parseBlock(STAMPED);
const stampedDefault = stamped.program.body.find((node) => node.type === 'ExportDefaultDeclaration')!;
const stampedBody = stampedDefault.declaration.type === 'FunctionDeclaration' ? stampedDefault.declaration.body!.body : [];
const stampedConsts = stampedBody.filter((node) => node.type === 'VariableDeclaration');
const sliceOf = (parsed: Parsed, node: Node) => parsed.content.slice(node.start, node.end);

const PARSED = new Map(SOURCES.map((fixture) => [fixture, fixture === STAMPED ? stamped : parseBlock(fixture)]));

const IMPORTS: string[] = [];
const STATEMENTS: string[] = [];
const ENV = new Set<string>();
function addHeader(parsed: Parsed, node: Node): void {
  const names = declared(node);
  if (names.some((name) => ENV.has(name))) return;
  for (const name of names) ENV.add(name);
  (node.type === 'ImportDeclaration' ? IMPORTS : STATEMENTS).push(sliceOf(parsed, node));
}
for (const node of stamped.program.body) if (node !== stampedDefault) addHeader(stamped, node);
for (const [, parsed] of PARSED)
  for (const node of parsed.program.body)
    if (node.type === 'ImportDeclaration' && node.source.value === 'react') addHeader(parsed, node);
for (const node of stampedConsts) addHeader(stamped, node);
ENV.add('ArrowExpression');

const ARROW_IMPORT = `import ArrowExpression from '${relative(join(FUZZ_DIR, 'run'), componentPath(ARROW_EXPRESSION)).split('\\').join('/')}'`;

interface Donor {
  fixture: string;
  tree: JsxNode;
  namespaced: boolean;
}

const DONORS: Donor[] = [];
for (const [fixture, parsed] of PARSED) {
  const collect = (node: JSXElement | JSXFragment): void => {
    const free = new Set<string>();
    freeNames(node, new Set(), free);
    if (![...free].every((name) => ENV.has(name) || name in globalThis)) return;
    const tree = toTree(node, parsed.content);
    DONORS.push({fixture, tree, namespaced: hasNamespace(tree)});
  };
  new Visitor({JSXElement: collect, JSXFragment: collect}).visit(parsed.program);
}

const HOST_TAGS = [...new Set(DONORS.flatMap(({tree}) => elementsOf(tree)).map(({tag}) => tag))]
  .filter((tag) => /^[a-z][\w-]*$/.test(tag))
  .sort();

const COMMENTS = [...listComponents('react/shapes'), ...listComponents('react/forwarding'), STAMPED, NAMESPACED, UNICODE]
  .flatMap((fixture) => parseBlock(fixture).comments)
  .map(({value}) => value)
  .filter((value) => !value.includes('*/'));

const unicode = parseBlock(UNICODE);
const UNICODE_HEADER = [
  `//${unicode.comments[0]!.value}`,
  ...unicode.program.body.filter((node) => node.type === 'VariableDeclaration').map((node) => sliceOf(unicode, node)),
];
const UNICODE_TEXT: string[] = [];
new Visitor({
  JSXText: (node) => {
    if (/[^\p{ASCII}]/u.test(node.value)) UNICODE_TEXT.push(node.value.trim());
  },
}).visit(unicode.program);

// The scoped style of Stamped.ucf: its classes are the ones the donors carry.
const STYLE = (() => {
  const {filename, source} = readComponent(STAMPED);
  const style = splitBlocks(source, filename).styles[0]!;
  return style.content;
})();

const FORWARD_REF_TYPES = [
  '',
  ...[...PARSED.values()].flatMap((parsed) => {
    const found: string[] = [];
    new Visitor({
      CallExpression: ({callee, typeArguments}) => {
        if (typeArguments && sliceOf(parsed, callee).endsWith('forwardRef')) found.push(sliceOf(parsed, typeArguments));
      },
    }).visit(parsed.program);
    return found;
  }),
];

const CALLEES = {memo: ['memo', 'memoized', 'React.memo'], forwardRef: ['forwardRef', 'React.forwardRef']} as const;
const COMPONENT_TAGS = ['ArrowExpression', 'Foo.Bar', 'Ui.Fragment', 'List'];

function donorsFor(render: boolean): Donor[] {
  return DONORS.filter((donor) => !render || !donor.namespaced);
}

// --- trees -----------------------------------------------------------------------------------------------------

function elementsOf(tree: JsxNode): ElementNode[] {
  const own = tree.kind === 'element' ? [tree] : [];
  return [...own, ...tree.children.flatMap((child) => (child.kind === 'raw' ? [] : elementsOf(child)))];
}

function nodesOf(tree: JsxNode): JsxNode[] {
  return [tree, ...tree.children.flatMap((child) => (child.kind === 'raw' ? [] : nodesOf(child)))];
}

function treesOf(expr: Expr): JsxNode[] {
  if (expr.kind === 'jsx') return [expr.tree];
  if (expr.kind === 'parens') return treesOf(expr.inner);
  if (expr.kind === 'ternary') return [...treesOf(expr.yes), ...treesOf(expr.no)];
  return expr.kind === 'and' ? treesOf(expr.right) : [];
}

function guardsOf(expr: Expr): Guard[] {
  if (expr.kind === 'parens') return guardsOf(expr.inner);
  if (expr.kind === 'ternary') return [expr.guard, ...guardsOf(expr.yes), ...guardsOf(expr.no)];
  return expr.kind === 'and' ? [expr.guard, ...guardsOf(expr.right)] : [];
}

const allTrees = (model: Model) => model.returns.flatMap(({expr}) => treesOf(expr));
const allGuards = (model: Model) => model.returns.flatMap(({guard, expr}) => [...(guard ? [guard] : []), ...guardsOf(expr)]);

function renderTree(tree: JsxNode): string {
  const attrs = tree.attrs.map((attr) => ` ${attr}`).join('');
  const children = tree.children.map((child) => (child.kind === 'raw' ? child.text : renderTree(child))).join('');
  if (tree.kind === 'fragment') return `<${tree.tag}${tree.tag ? attrs : ''}>${children}</${tree.tag}>`;
  if (tree.selfClosing && !tree.children.length) return `<${tree.tag}${tree.typeArgs}${attrs} />`;
  return `<${tree.tag}${tree.typeArgs}${attrs}>${children}</${tree.tag}>`;
}

function swapTag(element: ElementNode, random: Random): void {
  element.attrs = element.attrs.filter((attr) => /^(className|key)=/.test(attr));
  if (/^[a-z]/.test(element.tag)) {
    element.tag = random.pick(COMPONENT_TAGS);
    element.typeArgs = '';
    if (element.tag === 'ArrowExpression' || element.tag === 'List') {
      element.children = [];
      element.selfClosing = true;
    }
    if (element.tag === 'List') {
      element.typeArgs = '<string>';
      element.attrs.push('items={ITEMS}');
    }
  } else {
    element.tag = random.pick(HOST_TAGS);
    element.typeArgs = '';
  }
}

// --- rendering -------------------------------------------------------------------------------------------------

function blockComment(value: string): string {
  return `/*${value.replace(/\n/g, ' ')}*/`;
}

function propsAccess(model: Model): string | undefined {
  if (model.props.kind === 'plain') return 'props.branch';
  return model.props.kind === 'destructured' ? 'branch' : undefined;
}

function renderGuard(model: Model, guard: Guard): string {
  const access = propsAccess(model);
  const test = access ? `${access} === '${guard.value}'` : guard.constant ? 'count < limit' : 'limit < count';
  return guard.less ? `${test} && count < limit` : test;
}

function renderExpr(model: Model, expr: Expr): string {
  switch (expr.kind) {
    case 'jsx':
      return renderTree(expr.tree);
    case 'null':
      return 'null';
    case 'text':
      return "'text'";
    case 'parens':
      return `(${renderExpr(model, expr.inner)})`;
    case 'ternary':
      return `${renderGuard(model, expr.guard)} ? (${renderExpr(model, expr.yes)}) : (${renderExpr(model, expr.no)})`;
    case 'and': {
      // A bare ternary there would take the guard into its condition.
      const right = renderExpr(model, expr.right);
      return `${renderGuard(model, expr.guard)} && ${expr.right.kind === 'ternary' ? `(${right})` : right}`;
    }
  }
}

const PROPS_TYPE = '{ branch?: string }';

function renderParams(model: Model): string {
  const ref = model.wrappers.some(({api}) => api === 'forwardRef');
  const {props} = model;
  if (props.kind === 'none') return '()';
  if (props.kind === 'plain') return ref ? '(props, ref)' : `(props: ${PROPS_TYPE})`;
  const inner = props.comment ? `${blockComment(props.comment)} branch` : 'branch';
  const pattern = [`{ ${inner} }`, `{ ${inner}, ...rest }`, `{ ${inner} }`, `{ ${inner} }`][props.variant]!;
  const typed = `${pattern}: ${PROPS_TYPE}${props.variant === 3 ? ' = {}' : ''}`;
  return ref ? `(${typed}, ref)` : `(${typed})`;
}

function renderBody(model: Model): {text: string; expression: boolean} {
  const only = model.returns.length === 1 ? model.returns[0]! : undefined;
  if (model.arrow && model.expression && only && !only.viaConst && !only.comment)
    return {text: renderExpr(model, only.expr), expression: true};
  const lines: string[] = [];
  model.returns.forEach((ret, index) => {
    if (ret.comment !== undefined) lines.push(`// ${ret.comment.replace(/\n/g, ' ').trim()}`);
    let value = renderExpr(model, ret.expr);
    if (ret.viaConst) {
      lines.push(`const root${index} = ${value}`);
      value = `root${index}`;
    }
    lines.push(ret.guard ? `if (${renderGuard(model, ret.guard)}) return ${value}` : `return ${value}`);
  });
  return {text: `{\n${lines.map((line) => `    ${line}`).join('\n')}\n  }`, expression: false};
}

function renderComponent(model: Model, name: string): string {
  const params = renderParams(model);
  const body = renderBody(model);
  const generic = model.arrow ? '<T,>' : '<T>';
  const typeParams = model.generic ? generic : '';
  const nameComment = model.nameComment !== undefined ? ` ${blockComment(model.nameComment)} ` : '';
  let fn = model.arrow
    ? `${typeParams}${params} => ${body.text}`
    : `function ${name}${typeParams}${nameComment}${params} ${body.text}`;
  for (const {api, callee} of model.wrappers) {
    const typeArgs = api === 'forwardRef' ? model.refTypes : '';
    fn = `${callee}${typeArgs}(${fn})`;
  }
  const declaration = !model.arrow && model.wrappers.length === 0;
  if (model.exportStyle === 'direct') return `export default ${fn}`;
  const decl = declaration ? fn : `const ${name} = ${fn}`;
  return `${decl}\n\n  ${model.exportStyle === 'identifier' ? `export default ${name}` : `export { ${name} as default }`}`;
}

function renderSource(model: Model, name: string): string {
  const lines = [
    ...(model.useClient ? ['"use client"'] : []),
    ...IMPORTS,
    ARROW_IMPORT,
    ...(model.unicodeHeader ? UNICODE_HEADER : []),
    ...STATEMENTS,
    renderComponent(model, name),
  ];
  const react = `<react>\n${lines.map((line) => `  ${line}`).join('\n')}\n</react>\n`;
  return `${react}\n<style${model.scoped ? ' scoped' : ''}>${STYLE}</style>\n`;
}

// --- evaluation: what each branch renders ----------------------------------------------------------------------

function test(model: Model, guard: Guard, branch: string | undefined): boolean {
  return propsAccess(model) ? branch === guard.value : guard.constant;
}

function evaluate(model: Model, expr: Expr, branch: string | undefined): JsxNode | undefined {
  if (expr.kind === 'jsx') return expr.tree;
  if (expr.kind === 'parens') return evaluate(model, expr.inner, branch);
  if (expr.kind === 'ternary') return evaluate(model, test(model, expr.guard, branch) ? expr.yes : expr.no, branch);
  if (expr.kind === 'and') return test(model, expr.guard, branch) ? evaluate(model, expr.right, branch) : undefined;
  return undefined;
}

function outcomeOf(model: Model, branch: string | undefined): Outcome {
  const ret = model.returns.find(({guard}) => !guard || test(model, guard, branch))!;
  const tree = evaluate(model, ret.expr, branch);
  if (!tree) return 'none';
  if (tree.kind === 'fragment') return 'fragment';
  if (/^[a-z]/.test(tree.tag)) return 'host';
  return tree.tag === 'ArrowExpression' ? 'forwarding-component' : 'dropping-component';
}

// --- actions ---------------------------------------------------------------------------------------------------

function newGuard(model: Model, random: Random): Guard {
  return {value: `b${++model.guards}`, constant: random.int(2) === 1, less: false};
}

function donorExpr(random: Random, render: boolean): Expr {
  return {kind: 'jsx', tree: structuredClone(random.pick(donorsFor(render)).tree)};
}

function containers(model: Model): JsxNode[] {
  return allTrees(model).flatMap(nodesOf);
}

function applicable(model: Model): ActionKind[] {
  const has = (api: Wrapper['api']) => model.wrappers.some((wrapper) => wrapper.api === api);
  return ACTION_KINDS.filter((kind) => {
    if (kind === 'memo' || kind === 'forwardRef') return !has(kind);
    if (kind === 'generic') return !model.generic;
    if (kind === 'const-root') return model.returns.some(({viaConst}) => !viaConst);
    if (kind === 'swap-tag') return allTrees(model).some((tree) => elementsOf(tree).length > 0);
    if (kind === 'splice-child') return containers(model).length > 0;
    if (kind === 'less-than') return allGuards(model).some(({less}) => !less);
    if (kind === 'use-client') return !model.useClient;
    return true;
  });
}

function apply(model: Model, kind: ActionKind, random: Random, render: boolean): void {
  switch (kind) {
    case 'memo':
      model.wrappers.push({api: 'memo', callee: random.pick(CALLEES.memo)});
      return;
    case 'forwardRef':
      // forwardRef(memo(...)) makes React warn: forwardRef always goes innermost.
      model.wrappers.unshift({api: 'forwardRef', callee: random.pick(CALLEES.forwardRef)});
      model.refTypes = random.pick(FORWARD_REF_TYPES);
      return;
    case 'arrow':
      model.arrow = !model.arrow;
      return;
    case 'expression-body':
      model.expression = !model.expression;
      return;
    case 'props': {
      const choice = random.int(3);
      if (choice === 0) model.props = {kind: 'plain'};
      else if (choice === 1) model.props = {kind: 'destructured', variant: random.int(4)};
      else model.props = {kind: 'none'};
      if (model.props.kind === 'destructured' && model.props.variant === 2) model.props.comment = random.pick(COMMENTS);
      return;
    }
    case 'export-style':
      model.exportStyle = random.pick(['direct', 'identifier', 'as-default'] as const);
      return;
    case 'generic':
      model.generic = true;
      return;
    case 'early-return': {
      const roll = random.int(4);
      const expr: Expr = roll === 0 ? {kind: 'null'} : roll === 1 ? {kind: 'text'} : donorExpr(random, render);
      model.returns.splice(random.int(model.returns.length), 0, {guard: newGuard(model, random), expr, viaConst: false});
      return;
    }
    case 'ternary': {
      const slot = random.pick(model.returns);
      const yes: Expr = random.int(4) === 0 ? {kind: 'null'} : donorExpr(random, render);
      slot.expr = {kind: 'ternary', guard: newGuard(model, random), yes, no: slot.expr};
      return;
    }
    case 'and': {
      const slot = random.pick(model.returns);
      slot.expr = {kind: 'and', guard: newGuard(model, random), right: slot.expr};
      return;
    }
    case 'parens': {
      const slot = random.pick(model.returns);
      slot.expr = {kind: 'parens', inner: slot.expr};
      return;
    }
    case 'const-root':
      random.pick(model.returns.filter(({viaConst}) => !viaConst)).viaConst = true;
      return;
    case 'swap-tag':
      swapTag(random.pick(allTrees(model).flatMap(elementsOf)), random);
      return;
    case 'splice-child': {
      const target = random.pick(containers(model));
      target.children.splice(random.int(target.children.length + 1), 0, structuredClone(random.pick(donorsFor(render)).tree));
      return;
    }
    case 'comment': {
      const text = random.pick(COMMENTS);
      const site = random.int(4);
      if (site === 0) random.pick(model.returns).comment = text;
      else if (site === 1) model.nameComment = text;
      else if (site === 2 && model.props.kind === 'destructured') model.props.comment = text;
      else {
        const target = random.pick(containers(model));
        target.children.splice(random.int(target.children.length + 1), 0, {kind: 'raw', text: `{${blockComment(text)}}`});
      }
      return;
    }
    case 'less-than':
      random.pick(allGuards(model).filter(({less}) => !less)).less = true;
      return;
    case 'unicode':
      if (random.int(2) === 0 || model.unicodeHeader) {
        const target = random.pick(containers(model));
        target.children.splice(random.int(target.children.length + 1), 0, {kind: 'raw', text: random.pick(UNICODE_TEXT)});
      } else model.unicodeHeader = true;
      return;
    case 'use-client':
      model.useClient = true;
      return;
    case 'scoped':
      model.scoped = !model.scoped;
      return;
  }
}

function baseModel(fixture: string, render: boolean): Model {
  const donor = donorsFor(render).find((candidate) => candidate.fixture === fixture)!;
  return {
    wrappers: [],
    refTypes: '',
    arrow: false,
    expression: false,
    generic: false,
    props: {kind: 'plain'},
    exportStyle: 'direct',
    returns: [{expr: {kind: 'jsx', tree: structuredClone(donor.tree)}, viaConst: false}],
    useClient: false,
    unicodeHeader: false,
    scoped: true,
    guards: 0,
  };
}

// Skips an action that no longer applies, so the shrinker can drop an action another one needed.
function replay(fixture: string, actions: ScopeAction[], render: boolean): {model: Model; applied: ActionKind[]} {
  const model = baseModel(fixture, render);
  const applied: ActionKind[] = [];
  for (const action of actions) {
    if (!applicable(model).includes(action.kind)) continue;
    apply(model, action.kind, createRandom(action.seed), render);
    applied.push(action.kind);
  }
  return {model, applied};
}

export function buildCase(fixture: string, actions: ScopeAction[], {name, render}: {name: string; render: boolean}): ScopeCase {
  const {model, applied} = replay(fixture, actions, render);
  const values = [...new Set(allGuards(model).map(({value}) => value)), 'other'];
  const branches = propsAccess(model)
    ? values.map((branch) => ({branch, outcome: outcomeOf(model, branch)}))
    : [{outcome: outcomeOf(model, undefined)}];
  return {
    name,
    fixture,
    actions,
    applied,
    source: renderSource(model, name),
    render,
    props: model.props.kind === 'plain' ? 'props' : '__props',
    branches,
    model,
  };
}

/** Every 20th case is rendered by rule 4. */
export function caseAt(seed: number, runIndex: number): ScopeCase {
  const random = createRandom(mixSeed(seed, 'run', runIndex));
  const render = runIndex % 20 === 0;
  const fixture = random.pick(SOURCES.filter((source) => donorsFor(render).some((donor) => donor.fixture === source)));
  const actions: ScopeAction[] = [];
  const count = 1 + random.int(8);
  while (actions.length < count)
    actions.push({kind: random.pick(applicable(replay(fixture, actions, render).model)), seed: random.int(2 ** 32)});
  return buildCase(fixture, actions, {name: `Fuzz${runIndex}`, render});
}

export function writeCase(dir: string, fuzzCase: ScopeCase): string {
  const filename = join(dir, `${fuzzCase.name}.ucf`);
  writeFileSync(filename, fuzzCase.source);
  return filename;
}

/** The shape facts the coverage test reads. */
export function shapeOf(fuzzCase: ScopeCase): string[] {
  const {model} = fuzzCase;
  const wrappers = model.wrappers.map(({api}) => api).join('+') || 'unwrapped';
  const body = renderBody(model).expression ? 'expression' : 'block';
  return [
    `wrappers:${wrappers}`,
    `${model.arrow ? 'arrow' : 'function'}:${body}`,
    `props:${model.props.kind}`,
    `export:${model.exportStyle}`,
    `style:${model.scoped ? 'scoped' : 'plain'}`,
  ];
}
