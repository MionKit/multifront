import {parseSync} from 'oxc-parser';
import {createDiagnostic} from '../diagnostics.ts';
import type {Block, BlockKind, Diagnostic, SplitResult} from '../types.ts';

function check(block: Block, split: SplitResult): Diagnostic[] {
  const {program, errors} = parseSync(split.filename, block.content, {lang: 'tsx', sourceType: 'module'});
  // Syntax errors come from the TSX compiler and TypeScript, with better messages.
  if (errors.length > 0) return [];
  // `export default …`, `export {Card as default}` or `export {default} from './Card'`; a type export is no value.
  const hasDefault = program.body.some((node) => {
    if (node.type === 'ExportDefaultDeclaration') return node.declaration.type !== 'TSInterfaceDeclaration';
    if (node.type !== 'ExportNamedDeclaration' || node.exportKind === 'type') return false;
    return node.specifiers.some(
      ({exported, exportKind}) =>
        exportKind !== 'type' && (exported.type === 'Identifier' ? exported.name : exported.value) === 'default'
    );
  });
  if (hasDefault) return [];
  const message = '<react> has no default export; add export default to the component';
  return [createDiagnostic(split, 'react-no-default-export', block.start, block.contentStart, message)];
}

export const reactKind: BlockKind = {
  tag: 'react',
  role: 'target',
  grammar: {scopeName: 'source.tsx', languageId: 'typescriptreact'},
  check,
};
