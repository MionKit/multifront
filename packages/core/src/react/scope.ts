import {basename} from 'node:path';
import type MagicString from 'magic-string';
import type {
  ArrayPattern,
  ArrowFunctionExpression,
  CallExpression,
  Comment,
  Expression,
  Function as FunctionNode,
  IdentifierReference,
  JSXElement,
  JSXElementName,
  JSXFragment,
  JSXOpeningElement,
  Node,
  ObjectPattern,
  ParseResult,
  Program,
  TSType,
} from 'oxc-parser';
import {children, declaredIn, freshName, patternNames, scopeNames, walk} from '../ast.ts';
import {keyName} from '../imports/rewrite.ts';
import type {Block, BuildContext, ReactPropsSite, ReactRootProps} from '../types.ts';
import {FRAGMENT, REACT_MODULE, WRAPPERS} from './reactApis.ts';
import {addRootProps, handledRootProps, rootPropEdits} from './rootProps.ts';
import {MERGE_CLASS, MERGE_REF, MERGE_STYLE, SCOPE_ATTRS, WARN_FRAGMENT} from './scopeHelper.ts';

type Component = FunctionNode | ArrowFunctionExpression;
type Root = JSXElement | JSXFragment;

// `F` of `import {api as F} from 'react'`; `R.api` for its default or namespace import `R`.
function reactNames(program: Program, api: string): Set<string> {
  const names = new Set<string>();
  for (const node of program.body) {
    if (node.type !== 'ImportDeclaration' || node.source.value !== REACT_MODULE || node.importKind === 'type') continue;
    for (const spec of node.specifiers) {
      if (spec.type === 'ImportSpecifier' && spec.importKind === 'type') continue;
      // A namespace import reads like the default one: both give `R.api`.
      const imported = spec.type === 'ImportSpecifier' ? keyName(spec.imported) : 'default';
      if (imported === api) names.add(spec.local.name);
      else if (imported === 'default') names.add(`${spec.local.name}.${api}`);
    }
  }
  return names;
}

function isFragment(name: JSXElementName, fragments: Set<string>, shadowed: ReadonlySet<string>): boolean {
  if (name.type === 'JSXIdentifier') return fragments.has(name.name) && !shadowed.has(name.name);
  if (name.type !== 'JSXMemberExpression' || name.object.type !== 'JSXIdentifier') return false;
  return fragments.has(`${name.object.name}.${name.property.name}`) && !shadowed.has(name.object.name);
}

/** Every opening element, and whether it is React's Fragment where it stands. */
function openingElements(program: Program): Map<JSXOpeningElement, boolean> {
  const fragments = reactNames(program, FRAGMENT);
  const imported = new Set([...fragments].map((name) => name.split('.')[0]!));
  const found = new Map<JSXOpeningElement, boolean>();
  // `shadowed`: imported names a local binding hides here, so they no longer mean React's.
  const visit = (node: Node, outer: ReadonlySet<string>): void => {
    const own = scopeNames(node).filter((name) => imported.has(name));
    const shadowed = own.length > 0 ? new Set([...outer, ...own]) : outer;
    if (node.type === 'JSXOpeningElement') found.set(node, isFragment(node.name, fragments, shadowed));
    for (const child of children(node)) visit(child, shadowed);
  };
  visit(program, new Set());
  return found;
}

// After `<List<string>`: between the name and its type arguments the code no longer parses.
function afterName(node: JSXOpeningElement): number {
  return (node.typeArguments ?? node.name).end;
}

function calleeName(callee: Expression): string | undefined {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type !== 'MemberExpression' || callee.computed || callee.object.type !== 'Identifier') return undefined;
  return callee.property.type === 'Identifier' ? `${callee.object.name}.${callee.property.name}` : undefined;
}

function moduleDeclarations(program: Program): Map<string, Node> {
  const found = new Map<string, Node>();
  for (const statement of program.body) {
    const node = statement.type === 'ExportNamedDeclaration' && statement.declaration ? statement.declaration : statement;
    if (node.type === 'FunctionDeclaration' && node.id) found.set(node.id.name, node);
    if (node.type !== 'VariableDeclaration' || node.kind !== 'const') continue;
    for (const {id, init} of node.declarations) if (id.type === 'Identifier' && init) found.set(id.name, init);
  }
  return found;
}

function defaultExport(program: Program): Node | undefined {
  for (const node of program.body) {
    if (node.type === 'ExportDefaultDeclaration') return node.declaration;
    if (node.type !== 'ExportNamedDeclaration' || node.source || node.exportKind === 'type') continue;
    for (const {local, exported} of node.specifiers)
      if (keyName(exported) === 'default' && local.type === 'Identifier') return local;
  }
  return undefined;
}

// A `memo` or `forwardRef` call the default export goes through, outermost first.
interface Wrapper {
  api: (typeof WRAPPERS)[number];
  call: CallExpression;
}

/** The default-exported function through identifiers, `memo` and `forwardRef`; `forwardRef`: one wrapped it. */
function findComponent(program: Program): {component: Component; forwardRef: boolean; wrappers: Wrapper[]} | undefined {
  const declarations = moduleDeclarations(program);
  const [memo, forwardRef] = WRAPPERS.map((api) => reactNames(program, api));
  const seen = new Set<Node>();
  const wrappers: Wrapper[] = [];
  let node = defaultExport(program);
  while (node && !seen.has(node)) {
    seen.add(node);
    if (isFunction(node)) return {component: node, forwardRef: wrappers.some(({api}) => api === 'forwardRef'), wrappers};
    switch (node.type) {
      case 'Identifier':
        node = declarations.get(node.name);
        break;
      case 'ParenthesizedExpression':
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
        node = node.expression;
        break;
      case 'CallExpression': {
        const name = calleeName(node.callee);
        if (name === undefined || !(memo!.has(name) || forwardRef!.has(name))) return undefined;
        wrappers.push({api: memo!.has(name) ? 'memo' : 'forwardRef', call: node});
        node = node.arguments[0];
        break;
      }
      default:
        return undefined;
    }
  }
  return undefined;
}

function isFunction(node: Node): node is Component {
  return node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
}

// `consts` holds top-level `const`s only: the only ones every `return` can see.
function ownBody(component: Component): {returns: Expression[]; consts: Map<string, Expression>; bound: Set<string>} {
  const returns: Expression[] = [];
  const consts = new Map<string, Expression>();
  const bound = new Set<string>();
  const {body} = component;
  if (!body) return {returns, consts, bound};
  if (body.type !== 'BlockStatement') return {returns: [body], consts, bound};
  for (const statement of body.body) {
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') continue;
    for (const {id, init} of statement.declarations) if (id.type === 'Identifier' && init) consts.set(id.name, init);
  }
  for (const name of declaredIn(body.body)) bound.add(name);
  const visit = (node: Node): void => {
    if (isFunction(node)) return;
    for (const name of scopeNames(node)) bound.add(name);
    if (node.type === 'ReturnStatement' && node.argument) returns.push(node.argument);
    for (const child of children(node)) visit(child);
  };
  for (const child of children(body)) visit(child);
  return {returns, consts, bound};
}

// A root reached through `const x = …`: `via` is the `x` a return names; `whole`: the root is the const's whole value.
interface FoundRoot {
  root: Root;
  hop?: {via: IdentifierReference; whole: boolean};
}

// `hop` set: a const was already followed, so a second one is not.
function jsxRoots(expression: Expression, consts: Map<string, Expression>, hop: FoundRoot['hop'], found: FoundRoot[]): void {
  switch (expression.type) {
    case 'JSXElement':
    case 'JSXFragment':
      found.push({root: expression, hop});
      return;
    case 'ParenthesizedExpression':
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
      return jsxRoots(expression.expression, consts, hop, found);
    case 'ConditionalExpression': {
      const part = hop && {...hop, whole: false};
      jsxRoots(expression.consequent, consts, part, found);
      return jsxRoots(expression.alternate, consts, part, found);
    }
    case 'LogicalExpression':
      return jsxRoots(expression.right, consts, hop && {...hop, whole: false}, found);
    case 'Identifier': {
      const init = hop ? undefined : consts.get(expression.name);
      if (init) jsxRoots(init, consts, {via: expression, whole: true}, found);
      return;
    }
    default:
      return;
  }
}

function identifierNames(root: Node): string[] {
  const names: string[] = [];
  walk(root, (node) => {
    if (node.type === 'Identifier' || node.type === 'JSXIdentifier') names.push(node.name);
  });
  return names;
}

// Names a moved pattern binds or reads; a plain key or type annotation is neither.
function patternReads(node: Node | null): string[] {
  if (!node) return [];
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'AssignmentPattern') return [...patternReads(node.left), ...identifierNames(node.right)];
  if (node.type === 'RestElement') return patternReads(node.argument);
  if (node.type === 'ArrayPattern') return node.elements.flatMap(patternReads);
  if (node.type !== 'ObjectPattern') return [];
  return node.properties.flatMap((prop) => {
    if (prop.type === 'RestElement') return patternReads(prop.argument);
    return [...(prop.computed ? identifierNames(prop.key) : []), ...patternReads(prop.value)];
  });
}

function inComment(comments: Comment[], at: number): boolean {
  return comments.some(({start, end}) => start <= at && at < end);
}

interface ComponentAnalysis extends NonNullable<ReturnType<typeof findComponent>> {
  param: Node | undefined; // the props parameter, without its default
  pattern: ObjectPattern | ArrayPattern | undefined; // when the props parameter destructures
  props: string; // its name, or the one the build adds
  used: Set<string>;
  handled: ReturnType<typeof handledRootProps>;
  roots: FoundRoot[];
}

/** What the build forwards to: undefined when it forwards nothing (spec 3.5, items 3 and 4). */
function analyzeComponent(program: Program): ComponentAnalysis | undefined {
  const found = findComponent(program);
  if (!found) return undefined;
  const {component, forwardRef} = found;
  // oxc lists a TypeScript `this` parameter first; it is no prop.
  const hasThis = component.params[0]?.type === 'Identifier' && component.params[0].name === 'this';
  const params = hasThis ? component.params.slice(1) : component.params;
  if (hasThis && params.length === 0) return undefined;
  const first = params[0];
  const param = first?.type === 'AssignmentPattern' ? first.left : first;
  if (param?.type === 'RestElement') return undefined;
  const pattern = param?.type === 'ObjectPattern' || param?.type === 'ArrayPattern' ? param : undefined;
  const used = new Set(identifierNames(program));
  const props = param?.type === 'Identifier' ? param.name : freshName(used, '__props');

  const {returns, consts, bound} = ownBody(component);
  // A body redeclaring the props name could hide it from a root; telling which needs scope analysis.
  if (bound.has(props)) return undefined;
  if (pattern) {
    const names = patternNames(pattern);
    // Moved into the body, the pattern would meet body names, and later parameters would lose its bindings.
    if (patternReads(pattern).some((name) => bound.has(name))) return undefined;
    if (params.slice(1).some((later) => identifierNames(later).some((name) => names.includes(name)))) return undefined;
  }
  const handled = handledRootProps(component, props, pattern, forwardRef);
  const roots: FoundRoot[] = [];
  for (const expression of returns) jsxRoots(expression, consts, undefined, roots);
  return {...found, param, pattern, props, used, handled, roots};
}

// Right after the `(` of a component's parameter list.
function paramsStart(component: Component, content: string, comments: Comment[]): number {
  let at = component.typeParameters?.end ?? component.id?.end ?? component.start;
  while (content[at] !== '(' || inComment(comments, at)) at++;
  return at + 1;
}

// `A | B & X` would join X to `B` alone.
const LOOSE_TYPES = new Set(['TSUnionType', 'TSFunctionType', 'TSConstructorType', 'TSConditionalType']);

function typeSite(type: TSType): ReactPropsSite {
  return {kind: 'type', start: type.start, end: type.end, wrap: LOOSE_TYPES.has(type.type)};
}

// Every wrapper's explicit props type argument, and the parameter's annotation: each one can decide the export's props.
function propsSites(analysis: ComponentAnalysis, content: string, comments: Comment[]): ReactPropsSite[] {
  const sites: ReactPropsSite[] = [];
  for (const {api, call} of analysis.wrappers) {
    const types = call.typeArguments?.params;
    if (!types) continue;
    const props = types[api === 'forwardRef' ? 1 : 0];
    if (props) sites.push(typeSite(props));
    else if (api === 'forwardRef' && types[0]) sites.push({kind: 'argument', at: types[0].end});
  }
  const {param, component, props} = analysis;
  const typed = param?.type === 'Identifier' || param?.type === 'ObjectPattern' || param?.type === 'ArrayPattern';
  const annotation = typed ? param.typeAnnotation?.typeAnnotation : undefined;
  if (annotation) sites.push(typeSite(annotation));
  else if (!param) sites.push({kind: 'parameter', at: paramsStart(component, content, comments), name: props});
  return sites;
}

/** `reactRootProps` over a block's parse: the content's own roots and props type sites. */
export function rootPropsOf(parsed: Pick<ParseResult, 'program' | 'comments'>, content: string): ReactRootProps | undefined {
  const {program, comments} = parsed;
  const analysis = analyzeComponent(program);
  if (!analysis) return undefined;
  const elements = openingElements(program);
  // Each element root once, in source order.
  const openings = new Set<JSXOpeningElement>();
  for (const {root} of analysis.roots)
    if (root.type === 'JSXElement' && !elements.get(root.openingElement)) openings.add(root.openingElement);
  const roots = [...openings].map((opening) => ({
    tag: content.slice(opening.name.start, opening.name.end),
    props: rootPropEdits(opening, analysis.handled).map(({prop}) => prop),
  }));
  return {roots, sites: propsSites(analysis, content, comments)};
}

/** The text that types one site: `type` intersected into a props type, or written where there is none. */
export function propsTypeInserts(site: ReactPropsSite, type: string): {at: number; text: string}[] {
  if (site.kind === 'argument') return [{at: site.at, text: `, ${type}`}];
  if (site.kind === 'parameter') return [{at: site.at, text: `${site.name}: ${type}`}];
  if (!site.wrap) return [{at: site.end, text: ` & ${type}`}];
  return [
    {at: site.start, text: '('},
    {at: site.end, text: `) & ${type}`},
  ];
}

/** Stamps all but Fragments when scoped; always forwards `data-v-*` and root props on the default export's roots. */
export function transformScope(
  text: MagicString,
  parsed: Pick<ParseResult, 'program' | 'comments'>,
  block: Block,
  ctx: BuildContext
): string[] {
  const {program, comments} = parsed;
  const offset = block.contentStart;
  const elements = openingElements(program);
  if (ctx.hasScoped) {
    const stamp = ` data-v-${ctx.scopeId}=""`;
    for (const [node, fragment] of elements) if (!fragment) text.appendLeft(offset + afterName(node), stamp);
  }

  const analysis = analyzeComponent(program);
  if (!analysis) return [];
  const {component, forwardRef, param, pattern, props, used, handled, roots} = analysis;
  // A helper takes another local name when the block uses its own.
  const local = (helper: string) => freshName(used, helper);
  const spread = new Set<Root>();
  const dev = !ctx.production;
  const helpers = new Set<string>();
  const name = basename(ctx.filename, '.front');
  for (const {root, hop} of roots) {
    const isElement = root.type === 'JSXElement' && !elements.get(root.openingElement);
    if (isElement) {
      if (spread.has(root)) continue;
      spread.add(root);
      const at = afterName(root.openingElement);
      text.appendLeft(offset + at, ` {...${local(SCOPE_ATTRS)}(${props})}`);
      helpers.add(SCOPE_ATTRS);
      for (const helper of addRootProps(text, offset, root.openingElement, at, props, handled, local)) helpers.add(helper);
      continue;
    }
    // A const's value runs on every render: warned there, it would fire when another root is returned.
    const at = hop ? (hop.whole ? hop.via : undefined) : root;
    if (!dev || !at) continue;
    text.prependRight(offset + at.start, `(${local(WARN_FRAGMENT)}(${props}, ${JSON.stringify(name)}), `);
    text.appendLeft(offset + at.end, ')');
    helpers.add(WARN_FRAGMENT);
  }
  if (helpers.size === 0) return [];

  if (pattern) {
    const body = component.body!;
    // oxc's pattern span takes in its type annotation and `?`; the pattern text ends at its closing bracket.
    const closing = pattern.type === 'ObjectPattern' ? '}' : ']';
    let end = pattern.typeAnnotation?.start ?? pattern.end;
    while (block.content[end - 1] !== closing || inComment(comments, end - 1)) end--;
    const inBlock = body.type === 'BlockStatement';
    // After a directive prologue (`'use no memo'`), which only works first; a root means a statement follows it.
    const prologue = inBlock && body.body[0]?.type === 'ExpressionStatement' && !!body.body[0].directive;
    const statement = inBlock ? body.body.find((node) => node.type !== 'ExpressionStatement' || !node.directive) : undefined;
    const at = offset + (!inBlock ? body.start : prologue ? statement!.start : body.start + 1);
    // Moved, never re-printed: defaults, rest, comments and mappings stay as written.
    text.appendLeft(offset + pattern.start, props);
    text.move(offset + pattern.start, offset + end, at);
    text.appendLeft(at, inBlock ? 'const ' : '{const ');
    text.appendLeft(offset + end, inBlock ? ` = ${props};` : ` = ${props}; return `);
    // After the root edits, so a fragment warning's `)` closes first.
    if (!inBlock) text.appendLeft(offset + body.end, '}');
  } else if (!param) {
    const at = paramsStart(component, block.content, comments);
    // React checks a `forwardRef` render function takes zero or two parameters.
    text.appendLeft(offset + at, forwardRef ? `${props}, ${freshName(used, '__ref')}` : props);
  }
  return [SCOPE_ATTRS, WARN_FRAGMENT, MERGE_CLASS, MERGE_STYLE, MERGE_REF]
    .filter((helper) => helpers.has(helper))
    .map((helper) => (local(helper) === helper ? helper : `${helper} as ${local(helper)}`));
}
