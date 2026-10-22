import MagicString from 'magic-string';
import {parseSync} from 'oxc-parser';
import type {OxcError, ParseResult, Program} from 'oxc-parser';
import {createDiagnostic} from '../diagnostics.ts';
import {frameworkInBlockMessage} from '../imports/resolveTarget.ts';
import {frameworkAttributes} from '../imports/rewrite.ts';
import {rootPropsOf, transformScope} from '../react/scope.ts';
import {SCOPE_HELPER_ID} from '../react/scopeHelper.ts';
import type {Block, BlockKind, BuildContext, Diagnostic, ReactRootProps, SplitResult, VirtualFile} from '../types.ts';

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

// buildTarget checks then builds the same Block: one parse serves both.
const parses = new WeakMap<Block, ParseResult>();

function parseBlock(block: Block, filename: string): ParseResult {
  let parsed = parses.get(block);
  if (!parsed) {
    parsed = parseSync(filename, block.content, {lang: 'tsx', sourceType: 'module'});
    parses.set(block, parsed);
  }
  return parsed;
}

/** The roots the build hands `className`, `style` and `ref` to, and where the default export's props type is written. */
export function reactRootProps(block: Block, filename: string): ReactRootProps | undefined {
  return rootPropsOf(parseBlock(block, filename), block.content);
}

// Vue's grammar ends a `lang="tsx"` block only at end of file, coloring every later block as TSX.
function notLast(block: Block, split: SplitResult): Diagnostic[] {
  // A later <react> already gets duplicate-target; only other kinds are colored wrong.
  if (split.blocks.slice(split.blocks.indexOf(block) + 1).every(({type}) => type === 'react')) return [];
  const message = "<react> must be the last block, or Vue's highlighter colors the blocks after it as TSX; move it to the end";
  return [createDiagnostic(split, 'react-not-last', block.start, block.contentStart, message)];
}

function check(block: Block, split: SplitResult): Diagnostic[] {
  return [...notLast(block, split), ...codeRules(block, split)];
}

function codeRules(block: Block, split: SplitResult): Diagnostic[] {
  const {program, errors} = parseBlock(block, split.filename);
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
function prologueEnd(program: Program): number | undefined {
  let end: number | undefined;
  for (const statement of program.body) {
    if (statement.type !== 'ExpressionStatement' || !statement.directive) break;
    end = statement.end;
  }
  return end;
}

// MagicString over the whole .front source, so the map points straight into the .front file.
function build(block: Block, ctx: BuildContext): VirtualFile {
  const text = new MagicString(ctx.source);
  text.remove(0, block.contentStart);
  text.remove(block.contentEnd, ctx.source.length);
  const parsed = parseBlock(block, ctx.filename);
  const helpers = transformScope(text, parsed, block, ctx);
  // JSON quoting keeps any path a valid string.
  const imports = [
    ...ctx.styles.map(({id}) => `import ${JSON.stringify(id)};`),
    ...Object.values(ctx.modules)
      .filter(({name}) => IDENTIFIER.test(name))
      .map(({name, id}) => `import ${name} from ${JSON.stringify(id)};`),
    ...(helpers.length > 0 ? [`import {${helpers.join(', ')}} from ${JSON.stringify(SCOPE_HELPER_ID)};`] : []),
  ];
  if (imports.length > 0) {
    const prologue = prologueEnd(parsed.program);
    if (prologue === undefined) text.prependRight(block.contentStart, imports.map((line) => `${line}\n`).join(''));
    else text.appendLeft(block.contentStart + prologue, imports.map((line) => `\n${line}`).join(''));
  }
  const {sources, sourcesContent, names, mappings} = text.generateMap({source: ctx.filename, hires: true, includeContent: true});
  return {ext: '.tsx', code: text.toString(), map: {version: 3, sources, sourcesContent, names, mappings}};
}

export const reactKind: BlockKind = {
  tag: 'react',
  role: 'target',
  grammar: {scopeName: 'source.tsx', languageId: 'typescriptreact'},
  lang: 'tsx',
  check,
  build,
};
