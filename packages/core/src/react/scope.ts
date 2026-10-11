import {basename} from 'node:path';
import type MagicString from 'magic-string';
import type {
  ArrowFunctionExpression,
  Comment,
  Expression,
  Function as FunctionNode,
  JSXElement,
  JSXElementName,
  JSXFragment,
  JSXOpeningElement,
  Node,
  ParseResult,
  Program,
} from 'oxc-parser';
import {children, walk} from '../ast.ts';
import {keyName} from '../imports/rewrite.ts';
import type {Block, BuildContext} from '../types.ts';
import {FRAGMENT, REACT_MODULE, WRAPPERS} from './reactApis.ts';
import {SCOPE_ATTRS, WARN_FRAGMENT} from './scopeHelper.ts';

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

function patternNames(node: Node | null): string[] {
  if (!node) return [];
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'ObjectPattern')
    return node.properties.flatMap((prop) => patternNames(prop.type === 'RestElement' ? prop.argument : prop.value));
  if (node.type === 'ArrayPattern') return node.elements.flatMap(patternNames);
  if (node.type === 'AssignmentPattern') return patternNames(node.left);
  if (node.type === 'RestElement') return patternNames(node.argument);
  return node.type === 'TSParameterProperty' ? patternNames(node.parameter) : [];
}

// A `var` counts in its own block only.
function declaredIn(statements: Node[]): string[] {
  return statements.flatMap((node) => {
    if (node.type === 'VariableDeclaration') return node.declarations.flatMap(({id}) => patternNames(id));
    return (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id ? [node.id.name] : [];
  });
}

// The names a node binds for its own subtree.
function scopeNames(node: Node): string[] {
  switch (node.type) {
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return [...(node.type === 'FunctionExpression' && node.id ? [node.id.name] : []), ...node.params.flatMap(patternNames)];
    case 'BlockStatement':
    case 'StaticBlock':
      return declaredIn(node.body);
    case 'SwitchStatement':
      return declaredIn(node.cases.flatMap(({consequent}) => consequent));
    case 'CatchClause':
      return patternNames(node.param);
    case 'ForStatement':
      return node.init ? declaredIn([node.init]) : [];
    case 'ForInStatement':
    case 'ForOfStatement':
      return declaredIn([node.left]);
    default:
      return [];
  }
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

/** The default-exported function through identifiers, `memo` and `forwardRef`; `forwardRef`: one wrapped it. */
function findComponent(program: Program): {component: Component; forwardRef: boolean} | undefined {
  const declarations = moduleDeclarations(program);
  const [memo, forwardRef] = WRAPPERS.map((api) => reactNames(program, api));
  const seen = new Set<Node>();
  let inForwardRef = false;
  let node = defaultExport(program);
  while (node && !seen.has(node)) {
    seen.add(node);
    if (isFunction(node)) return {component: node, forwardRef: inForwardRef};
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
        inForwardRef ||= forwardRef!.has(name);
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

// `hop` follows one `const x = <jsx>` of the same function.
function jsxRoots(expression: Expression, consts: Map<string, Expression>, hop: boolean, found: Set<Root>): void {
  switch (expression.type) {
    case 'JSXElement':
    case 'JSXFragment':
      found.add(expression);
      return;
    case 'ParenthesizedExpression':
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
      return jsxRoots(expression.expression, consts, hop, found);
    case 'ConditionalExpression':
      jsxRoots(expression.consequent, consts, hop, found);
      return jsxRoots(expression.alternate, consts, hop, found);
    case 'LogicalExpression':
      return jsxRoots(expression.right, consts, hop, found);
    case 'Identifier': {
      const init = hop ? consts.get(expression.name) : undefined;
      if (init) jsxRoots(init, consts, false, found);
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

// Unused anywhere in the block, so it neither shadows nor is shadowed.
function freshName(used: Set<string>, base: string): string {
  let name = base;
  for (let index = 1; used.has(name); index++) name = `${base}${index}`;
  return name;
}

function inComment(comments: Comment[], at: number): boolean {
  return comments.some(({start, end}) => start <= at && at < end);
}

/** Stamps all but Fragments when scoped; always forwards `data-v-*` props on the default export's roots. */
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

  const found = findComponent(program);
  if (!found) return [];
  const {component, forwardRef} = found;
  // oxc lists a TypeScript `this` parameter first; it is no prop.
  const hasThis = component.params[0]?.type === 'Identifier' && component.params[0].name === 'this';
  const params = hasThis ? component.params.slice(1) : component.params;
  if (hasThis && params.length === 0) return [];
  const first = params[0];
  const param = first?.type === 'AssignmentPattern' ? first.left : first;
  if (param?.type === 'RestElement') return [];
  const pattern = param?.type === 'ObjectPattern' || param?.type === 'ArrayPattern' ? param : undefined;
  const used = new Set(param?.type === 'Identifier' ? [] : identifierNames(program));
  const props = param?.type === 'Identifier' ? param.name : freshName(used, '__props');

  const {returns, consts, bound} = ownBody(component);
  // A body redeclaring the props name could hide it from a root; telling which needs scope analysis.
  if (bound.has(props)) return [];
  if (pattern) {
    const names = patternNames(pattern);
    // Moved into the body, the pattern would meet body names, and later parameters would lose its bindings.
    if (patternReads(pattern).some((name) => bound.has(name))) return [];
    if (params.slice(1).some((later) => identifierNames(later).some((name) => names.includes(name)))) return [];
  }
  const roots = new Set<Root>();
  for (const expression of returns) jsxRoots(expression, consts, true, roots);
  const dev = !ctx.production;
  const helpers = new Set<string>();
  const name = basename(ctx.filename, '.ucf');
  for (const root of roots) {
    const isElement = root.type === 'JSXElement' && !elements.get(root.openingElement);
    if (isElement) {
      text.appendLeft(offset + afterName(root.openingElement), ` {...${SCOPE_ATTRS}(${props})}`);
      helpers.add(SCOPE_ATTRS);
    } else if (dev) {
      text.prependRight(offset + root.start, `(${WARN_FRAGMENT}(${props}, ${JSON.stringify(name)}), `);
      text.appendLeft(offset + root.end, ')');
      helpers.add(WARN_FRAGMENT);
    }
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
    let at = component.typeParameters?.end ?? component.id?.end ?? component.start;
    while (block.content[at] !== '(' || inComment(comments, at)) at++;
    // React checks a `forwardRef` render function takes zero or two parameters.
    text.appendLeft(offset + at + 1, forwardRef ? `${props}, ${freshName(used, '__ref')}` : props);
  }
  return [SCOPE_ATTRS, WARN_FRAGMENT].filter((helper) => helpers.has(helper));
}
