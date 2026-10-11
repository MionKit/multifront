import {Visitor} from 'oxc-parser';
import type {ArrowFunctionExpression, Expression, Function, ImportDeclaration, Node, Program} from 'oxc-parser';
import {SCOPE_HELPER_ID} from '@multifront/core';

// Style and class map ids both carry `?ucf&type=style&`.
export function isInjected(node: Node): node is ImportDeclaration {
  return node.type === 'ImportDeclaration' && /[?]ucf&type=style&/.test(node.source.value);
}

export function isHelperImport(node: Node): node is ImportDeclaration {
  return node.type === 'ImportDeclaration' && node.source.value === SCOPE_HELPER_ID;
}

export function isCallTo(node: Expression, name: string): boolean {
  return node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === name;
}

type Edit = [start: number, end: number, replacement: string];

const PROPS = /^__props\d*$/;
const REF = /^__ref\d*$/;

// `{const <pattern> = <props>;` opening the body, as the build writes it for a destructured first parameter.
function destructured(node: Function | ArrowFunctionExpression, code: string): Edit[] | undefined {
  const first = node.params[0];
  const param = first?.type === 'AssignmentPattern' ? first.left : first;
  const body = node.body;
  if (param?.type !== 'Identifier' || !PROPS.test(param.name) || body?.type !== 'BlockStatement') return undefined;
  // After the body's directives, or right after its `{`.
  const index = body.body.findIndex((node) => node.type !== 'ExpressionStatement' || !node.directive);
  const [statement, next] = body.body.slice(index);
  if (statement?.type !== 'VariableDeclaration' || (index === 0 && statement.start !== body.start + 1)) return undefined;
  const declarator = statement.declarations[0]!;
  if (declarator.init?.type !== 'Identifier' || declarator.init.name !== param.name) return undefined;
  const restore: Edit = [param.start, param.start + param.name.length, code.slice(declarator.id.start, declarator.id.end)];
  const expression =
    node.type === 'ArrowFunctionExpression' && body.body.length === 2 && index === 0 && next?.type === 'ReturnStatement';
  if (expression && next.argument && next.start === statement.end + 1 && body.end === next.end + 1)
    return [restore, [body.start, next.argument.start, ''], [next.argument.end, body.end, '']];
  return [restore, [statement.start, statement.end, '']];
}

function forwardingEdits(program: Program, code: string): Edit[] {
  const edits: Edit[] = [];
  const params = (node: Function | ArrowFunctionExpression) => {
    const undo = destructured(node, code);
    if (undo) return void edits.push(...undo);
    const names = node.params.map((param) => (param.type === 'Identifier' ? param.name : ''));
    if (PROPS.test(names[0] ?? '') && names.every((name, index) => (index === 0 ? PROPS : REF).test(name)))
      edits.push([node.params[0]!.start, node.params.at(-1)!.end, '']);
  };
  new Visitor({
    JSXSpreadAttribute: (node) => {
      if (isCallTo(node.argument, '__ucfScopeAttrs')) edits.push([node.start - 1, node.end, '']);
    },
    ParenthesizedExpression: (node) => {
      if (node.expression.type !== 'SequenceExpression') return;
      const [warn, root] = node.expression.expressions;
      if (warn && root && isCallTo(warn, '__ucfWarnFragment')) edits.push([node.start, root.start, ''], [root.end, node.end, '']);
    },
    FunctionDeclaration: params,
    FunctionExpression: params,
    ArrowFunctionExpression: params,
  }).visit(program);
  return edits;
}

/** `code` without what `react.build` adds, stamps aside, and with a moved props pattern put back. */
export function withoutInjected(code: string, program: Program): string {
  const imports = program.body.filter((node) => isInjected(node) || isHelperImport(node));
  const edits: Edit[] = imports.map(({start, end}) => (code[end] === '\n' ? [start, end + 1, ''] : [start - 1, end, '']));
  edits.push(...forwardingEdits(program, code));
  let rest = code;
  for (const [start, end, replacement] of edits.sort((first, second) => second[0] - first[0]))
    rest = rest.slice(0, start) + replacement + rest.slice(end);
  return rest;
}
