import {basename} from 'node:path';
import type MagicString from 'magic-string';
import type {
  ArrowFunctionExpression,
  Comment,
  Expression,
  Function as FunctionNode,
  JSXElementName,
  JSXOpeningElement,
  Node,
  Program,
} from 'oxc-parser';
import {children} from '../ast.ts';
import {keyName} from '../imports/rewrite.ts';
import type {Block, BuildContext} from '../types.ts';
import {FRAGMENT, REACT_MODULE, WRAPPERS} from './reactApis.ts';
import {SCOPE_ATTRS, WARN_FRAGMENT} from './scopeHelper.ts';

type Component = FunctionNode | ArrowFunctionExpression;

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

// Module-level `function X` and `const X = …`, also under `export`.
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

/** The default-exported function, through identifiers, `memo` and `forwardRef`; `forwardRef` says one was passed. */
function findComponent(program: Program): {component: Component; forwardRef: boolean} | undefined {
  const declarations = moduleDeclarations(program);
  const [memo, forwardRef] = WRAPPERS.map((api) => reactNames(program, api));
  const seen = new Set<Node>();
  let inForwardRef = false;
  let node = defaultExport(program);
  while (node && !seen.has(node)) {
    seen.add(node);
    switch (node.type) {
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        return {component: node, forwardRef: inForwardRef};
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
        const [first] = node.arguments;
        node = first?.type === 'SpreadElement' ? undefined : first;
        break;
      }
      default:
        return undefined;
    }
  }
  return undefined;
}

function isFunction(node: Node): boolean {
  return node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
}

// The `return` arguments and the `const` declarators of `component`'s own body, not of nested functions.
function ownBody(component: Component): {returns: Expression[]; consts: Map<string, Expression | undefined>} {
  const returns: Expression[] = [];
  const consts = new Map<string, Expression | undefined>();
  const visit = (node: Node): void => {
    if (isFunction(node)) return;
    if (node.type === 'ReturnStatement' && node.argument) returns.push(node.argument);
    if (node.type === 'VariableDeclaration' && node.kind === 'const') {
      // Two `const`s of one name: which one a return reads needs scopes, so neither is followed.
      for (const {id, init} of node.declarations)
        if (id.type === 'Identifier') consts.set(id.name, consts.has(id.name) ? undefined : (init ?? undefined));
    }
    for (const child of children(node)) visit(child);
  };
  const {body} = component;
  if (!body) return {returns, consts};
  if (body.type === 'BlockStatement') for (const child of children(body)) visit(child);
  else returns.push(body as Expression);
  return {returns, consts};
}

// Root JSX of each returned expression; `hop` allows one `const x = <jsx>` in the same function.
function jsxRoots(expression: Expression, consts: Map<string, Expression | undefined>, hop: boolean, found: Set<Node>): void {
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

function inComment(offset: number, comments: Comment[]): boolean {
  return comments.some(({start, end}) => start <= offset && offset < end);
}

/**
 * Stamps every JSX element but React's Fragment (with a scoped style), then forwards the incoming `data-v-*` props
 * on the default-exported component's roots (always). Returns the helper names the edits call.
 */
export function transformScope(
  text: MagicString,
  parsed: {program: Program; comments: Comment[]},
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
  const first = component.params[0];
  const param = first?.type === 'AssignmentPattern' ? first.left : first;
  // A destructured or rest first parameter leaves no name holding every prop.
  if (param && param.type !== 'Identifier') return [];
  const props = param?.name ?? '__props';

  const {returns, consts} = ownBody(component);
  const roots = new Set<Node>();
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

  if (!param && helpers.size > 0) {
    let at = component.typeParameters?.end ?? component.id?.end ?? component.start;
    while (block.content[at] !== '(' || inComment(at, comments)) at++;
    // React checks a `forwardRef` render function takes zero or two parameters.
    text.appendLeft(offset + at + 1, forwardRef ? '__props, __ref' : '__props');
  }
  return [SCOPE_ATTRS, WARN_FRAGMENT].filter((helper) => helpers.has(helper));
}
