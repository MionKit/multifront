import MagicString from 'magic-string';
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
import type {Block, BlockKind, BuildContext, Diagnostic, SplitResult, VirtualFile} from '../types.ts';

// A module name the block cannot name (`module="my-theme"`) gets no import, as the editor declares none.
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

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

// Offset in the block content after its directives; `"use client"` must stay first.
function prologueEnd(block: Block, filename: string): number | undefined {
  const {program} = parseSync(filename, block.content, {lang: 'tsx', sourceType: 'module'});
  let end: number | undefined;
  for (const statement of program.body) {
    if (statement.type !== 'ExpressionStatement' || !statement.directive) break;
    end = statement.end;
  }
  return end;
}

// MagicString over the whole .ucf source, so the map points straight into the .ucf file.
function build(block: Block, ctx: BuildContext): VirtualFile {
  const text = new MagicString(ctx.source);
  text.remove(0, block.contentStart);
  text.remove(block.contentEnd, ctx.source.length);
  // JSON quoting keeps any path a valid string.
  const imports = [
    ...ctx.styles.map(({id}) => `import ${JSON.stringify(id)};`),
    ...Object.values(ctx.modules)
      .filter(({name}) => IDENTIFIER.test(name))
      .map(({name, id}) => `import ${name} from ${JSON.stringify(id)};`),
  ];
  const prologue = imports.length > 0 ? prologueEnd(block, ctx.filename) : undefined;
  if (prologue === undefined) text.prependRight(block.contentStart, imports.map((line) => `${line}\n`).join(''));
  else text.appendLeft(block.contentStart + prologue, imports.map((line) => `\n${line}`).join(''));
  const {sources, sourcesContent, names, mappings} = text.generateMap({source: ctx.filename, hires: true, includeContent: true});
  return {ext: '.tsx', code: text.toString(), map: {version: 3, sources, sourcesContent, names, mappings}};
}

export const reactKind: BlockKind = {
  tag: 'react',
  role: 'target',
  grammar: {scopeName: 'source.tsx', languageId: 'typescriptreact'},
  check,
  build,
};
