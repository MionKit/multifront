import {parseSync} from 'oxc-parser';
import {createDiagnostic} from '../diagnostics.ts';
import type {Block, BlockKind, Diagnostic, SplitResult} from '../types.ts';

type Program = ReturnType<typeof parseSync>['program'];

// `export default …`, `export {Card as default}` or `export {default} from './Card'`.
function hasDefaultExport(program: Program): boolean {
  return program.body.some(
    (node) =>
      node.type === 'ExportDefaultDeclaration' ||
      (node.type === 'ExportNamedDeclaration' &&
        node.specifiers.some(({exported}) => (exported.type === 'Identifier' ? exported.name : exported.value) === 'default'))
  );
}

function check(block: Block, split: SplitResult): Diagnostic[] {
  const {program, errors} = parseSync(split.filename, block.content, {lang: 'tsx', sourceType: 'module'});
  // A block that does not parse gets its syntax errors from the TSX compiler and TypeScript, with better messages.
  if (errors.length > 0 || hasDefaultExport(program)) return [];
  const message = '<react> has no default export; add export default to the component';
  return [createDiagnostic(split, 'react-no-default-export', block.start, block.contentStart, message)];
}

export const reactKind: BlockKind = {tag: 'react', role: 'target', check};
