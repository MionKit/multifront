import {basename, dirname, isAbsolute, relative, sep} from 'node:path';
import {isTarget, resolveTarget} from '@multifront/core';
import type {Importer, ResolveTargetOptions, Target} from '@multifront/core';
import type * as ts from 'typescript';
import {MAIN_SCRIPT_TARGET} from './languagePlugin.ts';
import type {TypeScript, UcfImportOptions, UcfResolution} from './types.ts';

const PLUGIN_NAME = '@multifront/language-tools/typescript-plugin';
// TypeScript looks for `Card.d.ucf.ts` when `./Card.ucf` has no TS extension; it stands for the `.ucf` file.
const UCF_DECLARATION = '.d.ucf.ts';

function propertyValue(ts: TypeScript, object: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if ((ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === key) {
      return property.initializer;
    }
  }
  return undefined;
}

// Only the literal's own parent link is set during resolution, so nothing here reads a position.
function frameworkAttribute(ts: TypeScript, literal: ts.StringLiteralLike): string | undefined {
  const node = literal.parent as ts.Node | undefined;
  if (!node) return undefined;
  let value: ts.Expression | undefined;
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    value = node.attributes?.elements.find((attribute) => attribute.name.text === 'framework')?.value;
  } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const options = node.arguments[1];
    const withClause = options && ts.isObjectLiteralExpression(options) ? propertyValue(ts, options, 'with') : undefined;
    if (withClause && ts.isObjectLiteralExpression(withClause)) value = propertyValue(ts, withClause, 'framework');
  }
  return value && ts.isStringLiteralLike(value) ? value.text : undefined;
}

function ucfHost(host: ts.ModuleResolutionHost): ts.ModuleResolutionHost {
  return {
    ...host,
    fileExists: (fileName) =>
      host.fileExists(fileName.endsWith(UCF_DECLARATION) ? fileName.slice(0, -UCF_DECLARATION.length) + '.ucf' : fileName),
  };
}

/** The framework of one `.ucf` import (spec 4.1, 4.2), and the file TypeScript reads for it. */
export function resolveUcfImport(
  ts: TypeScript,
  literal: ts.StringLiteralLike,
  containingFile: string,
  options: UcfImportOptions
): UcfResolution {
  // In tsserver a `.ucf` file's own script is its main target's block, so its imports sit in that block.
  const importer: Importer = {fileName: containingFile};
  if (containingFile.endsWith('.ucf')) importer.block = MAIN_SCRIPT_TARGET;
  const choice = resolveTarget(importer, frameworkAttribute(ts, literal), options);
  if ('error' in choice) return {resolvedModule: undefined, error: choice.error};
  const {target} = choice;
  // No shared cache: the same specifier gets another answer from another importer.
  const {resolvedModule} = ts.resolveModuleName(literal.text, containingFile, options.compilerOptions, ucfHost(options.host));
  if (!resolvedModule?.resolvedFileName.endsWith(UCF_DECLARATION)) return {resolvedModule};
  const fileName = resolvedModule.resolvedFileName.slice(0, -UCF_DECLARATION.length) + '.ucf';
  const split = options.getSplit(fileName);
  let error: UcfResolution['error'];
  if (split && !split.targets[target]) {
    let path = relative(dirname(containingFile), fileName).split(sep).join('/');
    if (!isAbsolute(path) && !/^\.\.?\//.test(path)) path = `./${path}`;
    const message = `${path} has no <${target}> block; ${basename(containingFile)} imports it as ${target}`;
    error = {code: 'missing-target-block', message};
  }
  // tsserver serves only the main target's script; vue and svelte get theirs in M4 and M6.
  if (target !== MAIN_SCRIPT_TARGET) return {resolvedModule: undefined, error};
  // Resolved even without the block, so adding it in an unsaved edit needs no new resolution.
  const {isExternalLibraryImport} = resolvedModule;
  return {resolvedModule: {resolvedFileName: fileName, extension: ts.Extension.Tsx, isExternalLibraryImport}, error};
}

/** `framework` and `importers` of our entry in `compilerOptions.plugins`. */
export function entryOptions(compilerOptions: ts.CompilerOptions): ResolveTargetOptions {
  const plugins = (compilerOptions.plugins ?? []) as (ts.PluginImport & {framework?: unknown; importers?: unknown})[];
  const entry = plugins.find(({name}) => name === PLUGIN_NAME);
  const options: ResolveTargetOptions = {};
  if (typeof entry?.framework === 'string' && isTarget(entry.framework)) options.framework = entry.framework;
  if (entry?.importers && typeof entry.importers === 'object') {
    const importers: Record<string, Target> = {};
    for (const [ext, value] of Object.entries(entry.importers)) {
      if (typeof value === 'string' && isTarget(value)) importers[ext] = value;
    }
    options.importers = importers;
  }
  return options;
}

/** Our plugin entry in a `tsconfig.json`, `extends` followed: one place for every editor and `tsc` host. */
export function readMultifrontOptions(ts: TypeScript, configFileName: string): ResolveTargetOptions {
  const {config, error} = ts.readConfigFile(configFileName, ts.sys.readFile);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: () => [], // only the options are read, never the file list
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
  };
  const parsed = ts.parseJsonConfigFileContent(config, host, dirname(configFileName), undefined, configFileName);
  // 18003 "No inputs were found": the file list is skipped on purpose.
  const [failure] = parsed.errors.filter(({code}) => code !== 18003);
  if (failure) throw new Error(ts.flattenDiagnosticMessageText(failure.messageText, '\n'));
  return entryOptions(parsed.options);
}
