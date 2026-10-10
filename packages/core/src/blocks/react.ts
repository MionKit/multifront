import {parseSync} from 'oxc-parser';
import type {
  ExportAllDeclaration,
  ExportNamedDeclaration,
  Expression,
  ImportDeclaration,
  ImportExpression,
  OxcError,
  Program,
  Span,
} from 'oxc-parser';
import {walk} from '../ast.ts';
import {createDiagnostic} from '../diagnostics.ts';
import {frameworkInBlockMessage} from '../imports/resolveTarget.ts';
import {keyName, literalValue} from '../imports/rewrite.ts';
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

function syntaxError(block: Block, split: SplitResult, error: OxcError): Diagnostic {
  // Every oxc syntax error seen so far has a label.
  const {start, end} = error.labels[0] ?? {start: 0, end: 0};
  const message = `<react> does not parse: ${error.message}`;
  return createDiagnostic(split, 'react-syntax-error', block.contentStart + start, block.contentStart + end, message);
}

// `export default …`, `export {Card as default}` or `export {default} from './Card'`, when it exports a value.
function hasDefaultExport(program: Program): boolean {
  const types = typeOnlyNames(program);
  return program.body.some((node) => {
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
}

// The `.ucf` imports `rewriteImportAttributes` reads; the attribute is an error whatever its value.
function frameworkAttributes(program: Program): Span[] {
  const found: Span[] = [];
  const isUcf = (source: Expression) => literalValue(source)?.endsWith('.ucf') ?? false;
  const fromStatic = (node: ImportDeclaration | ExportNamedDeclaration | ExportAllDeclaration) => {
    if (node.source && isUcf(node.source)) found.push(...node.attributes.filter(({key}) => keyName(key) === 'framework'));
  };
  const fromDynamic = ({source, options}: ImportExpression) => {
    if (!isUcf(source) || options?.type !== 'ObjectExpression') return;
    for (const option of options.properties) {
      if (option.type !== 'Property' || option.computed || keyName(option.key) !== 'with') continue;
      if (option.value.type !== 'ObjectExpression') continue;
      for (const attribute of option.value.properties) {
        if (attribute.type === 'Property' && !attribute.computed && keyName(attribute.key) === 'framework') found.push(attribute);
      }
    }
  };
  walk(program, (node) => {
    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration')
      fromStatic(node);
    else if (node.type === 'ImportExpression') fromDynamic(node);
  });
  return found;
}

function check(block: Block, split: SplitResult): Diagnostic[] {
  const {program, errors} = parseSync(split.filename, block.content, {lang: 'tsx', sourceType: 'module'});
  // A recovered program says nothing sure about exports or imports.
  if (errors.length > 0) return errors.map((error) => syntaxError(block, split, error));
  const diagnostics = frameworkAttributes(program).map(({start, end}) =>
    createDiagnostic(
      split,
      'framework-in-block',
      block.contentStart + start,
      block.contentStart + end,
      frameworkInBlockMessage('react')
    )
  );
  if (hasDefaultExport(program)) return diagnostics;
  const message = '<react> has no default export; add export default to the component';
  return [createDiagnostic(split, 'react-no-default-export', block.start, block.contentStart, message), ...diagnostics];
}

export const reactKind: BlockKind = {
  tag: 'react',
  role: 'target',
  grammar: {scopeName: 'source.tsx', languageId: 'typescriptreact'},
  check,
};
