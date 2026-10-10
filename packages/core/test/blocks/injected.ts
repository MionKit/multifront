import {Visitor} from 'oxc-parser';
import type {ArrowFunctionExpression, Expression, Function, ImportDeclaration, Node, Program} from 'oxc-parser';
import {SCOPE_HELPER_ID} from '@multifront/core';

// Style and class map ids both carry `?ucf&type=style&`.
export function isInjected(node: Node): node is ImportDeclaration {
  return node.type === 'ImportDeclaration' && /[?]ucf&type=style&/.test(node.source.value);
}

function isHelperImport(node: Node): node is ImportDeclaration {
  return node.type === 'ImportDeclaration' && node.source.value === SCOPE_HELPER_ID;
}

function calls(node: Expression, name: string): boolean {
  return node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === name;
}

// The [start, end) ranges root forwarding inserted: spreads, the dev fragment warning, `__props` / `__ref`.
function forwardingRanges(program: Program): [number, number][] {
  const ranges: [number, number][] = [];
  const params = (node: Function | ArrowFunctionExpression) => {
    const names = node.params.map((param) => (param.type === 'Identifier' ? param.name : ''));
    if (names[0] === '__props' && names.every((name) => name === '__props' || name === '__ref'))
      ranges.push([node.params[0]!.start, node.params.at(-1)!.end]);
  };
  new Visitor({
    JSXSpreadAttribute: (node) => {
      if (calls(node.argument, '__ucfScopeAttrs')) ranges.push([node.start - 1, node.end]);
    },
    ParenthesizedExpression: (node) => {
      if (node.expression.type !== 'SequenceExpression') return;
      const [warn, root] = node.expression.expressions;
      if (warn && root && calls(warn, '__ucfWarnFragment')) ranges.push([node.start, root.start], [root.end, node.end]);
    },
    FunctionDeclaration: params,
    FunctionExpression: params,
    ArrowFunctionExpression: params,
  }).visit(program);
  return ranges;
}

/** `code` without everything `react.build` adds but stamps: header imports with their newline, and forwarding. */
export function withoutInjected(code: string, program: Program): string {
  const imports = program.body.filter((node) => isInjected(node) || isHelperImport(node));
  const ranges: [number, number][] = imports.map(({start, end}) => (code[end] === '\n' ? [start, end + 1] : [start - 1, end]));
  ranges.push(...forwardingRanges(program));
  let rest = code;
  for (const [start, end] of ranges.sort((first, second) => second[0] - first[0])) rest = rest.slice(0, start) + rest.slice(end);
  return rest;
}
