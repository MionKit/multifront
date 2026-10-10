import {parseSync} from 'oxc-parser';
import type {Program} from 'oxc-parser';
import {createDiagnostic} from '../diagnostics.ts';
import type {Block, BlockKind, Diagnostic, SplitResult} from '../types.ts';

// Names the block binds only as types; a same-name value wins.
function typeOnlyNames(program: Program): Set<string> {
  const types = new Set<string>();
  const values = new Set<string>();
  for (const statement of program.body) {
    const node = statement.type === 'ExportNamedDeclaration' && statement.declaration ? statement.declaration : statement;
    if (node.type === 'TSInterfaceDeclaration' || node.type === 'TSTypeAliasDeclaration') types.add(node.id.name);
    else if (node.type === 'VariableDeclaration') {
      for (const {id} of node.declarations) if (id.type === 'Identifier') values.add(id.name);
    } else if (node.type === 'ImportDeclaration') {
      for (const spec of node.specifiers) {
        const typeOnly = node.importKind === 'type' || (spec.type === 'ImportSpecifier' && spec.importKind === 'type');
        (typeOnly ? types : values).add(spec.local.name);
      }
    } else if ('id' in node && node.id?.type === 'Identifier') values.add(node.id.name); // function, class, enum, namespace
  }
  return new Set([...types].filter((name) => !values.has(name)));
}

function check(block: Block, split: SplitResult): Diagnostic[] {
  const {program, errors} = parseSync(split.filename, block.content, {lang: 'tsx', sourceType: 'module'});
  // Syntax errors come from the TSX compiler and TypeScript, with better messages.
  if (errors.length > 0) return [];
  const types = typeOnlyNames(program);
  // `export default …`, `export {Card as default}` or `export {default} from './Card'`, when it exports a value.
  const hasDefault = program.body.some((node) => {
    if (node.type === 'ExportDefaultDeclaration') {
      const {declaration} = node;
      return declaration.type !== 'TSInterfaceDeclaration' && !(declaration.type === 'Identifier' && types.has(declaration.name));
    }
    if (node.type !== 'ExportNamedDeclaration' || node.exportKind === 'type') return false;
    return node.specifiers.some(
      ({local, exported, exportKind}) =>
        exportKind !== 'type' &&
        (exported.type === 'Identifier' ? exported.name : exported.value) === 'default' &&
        (node.source !== null || local.type !== 'Identifier' || !types.has(local.name))
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
