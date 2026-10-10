import {basename, dirname, relative, sep} from 'node:path';
import {isTarget, resolveTarget} from '@multifront/core';
import type {Importer, ResolveTargetOptions, Target} from '@multifront/core';
import type * as ts from 'typescript';
import {EDITOR_BLOCK_KINDS} from './blocks/index.ts';
import {MAIN_SCRIPT_TARGET} from './languagePlugin.ts';
import type {TypeScript, UcfImportOptions, UcfResolution} from './types.ts';

export const PLUGIN_NAME = '@multifront/language-tools/typescript-plugin';
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

function missingBlock(fileName: string, containingFile: string, target: Target): string {
  let path = relative(dirname(containingFile), fileName).split(sep).join('/');
  if (!path.startsWith('.')) path = `./${path}`;
  return `${path} has no <${target}> block; ${basename(containingFile)} imports it as ${target}`;
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
  const {target, rule} = choice;
  // No shared cache: the same specifier gets another answer from another importer.
  const {resolvedModule} = ts.resolveModuleName(literal.text, containingFile, options.compilerOptions, ucfHost(options.host));
  if (!resolvedModule?.resolvedFileName.endsWith(UCF_DECLARATION)) return {resolvedModule, target, rule};
  const fileName = resolvedModule.resolvedFileName.slice(0, -UCF_DECLARATION.length) + '.ucf';
  const split = options.getSplit(fileName);
  if (!split) return {resolvedModule: undefined, target, rule};
  if (!split.targets[target]) {
    const message = missingBlock(fileName, containingFile, target);
    return {resolvedModule: undefined, target, rule, error: {code: 'missing-target-block', message}};
  }
  if (!EDITOR_BLOCK_KINDS.find(({tag}) => tag === target)?.types) return {resolvedModule: undefined, target, rule};
  const {isExternalLibraryImport} = resolvedModule;
  return {resolvedModule: {resolvedFileName: fileName, extension: ts.Extension.Tsx, isExternalLibraryImport}, target, rule};
}

/** `framework` and `importers` of our entry in `compilerOptions.plugins`; values that are not a framework are dropped. */
export function entryOptions(compilerOptions: ts.CompilerOptions): ResolveTargetOptions {
  const plugins = (compilerOptions.plugins ?? []) as unknown as Record<string, unknown>[];
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
  const {config} = ts.readConfigFile(configFileName, ts.sys.readFile);
  if (!config) return {};
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: () => [], // only the options are read, never the file list
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
  };
  return entryOptions(ts.parseJsonConfigFileContent(config, host, dirname(configFileName), undefined, configFileName).options);
}
