import type {ImportDeclaration, Node, Program} from 'oxc-parser';

// Style and class map ids both carry `?ucf&type=style&`.
export function isInjected(node: Node): node is ImportDeclaration {
  return node.type === 'ImportDeclaration' && /[?]ucf&type=style&/.test(node.source.value);
}

/** `code` without the imports `react.build` adds, each with the newline it brought. */
export function withoutInjected(code: string, program: Program): string {
  let rest = code;
  for (const {start, end} of program.body.filter(isInjected).reverse()) {
    const newlineAfter = rest[end] === '\n';
    rest = rest.slice(0, newlineAfter ? start : start - 1) + rest.slice(newlineAfter ? end + 1 : end);
  }
  return rest;
}
