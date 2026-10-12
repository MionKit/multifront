import {dirname} from 'node:path';
import {
  importerFromId,
  isTarget,
  missingTargetBlockMessage,
  resolveTarget,
  rewriteImportAttributes,
  splitBlocks,
} from '@multifront/core';
import type {Diagnostic, Importer, ResolveTargetOptions, Target} from '@multifront/core';
import type * as ts from 'typescript';
import {MAIN_SCRIPT_TARGET} from './languagePlugin.ts';
import {isServedTarget, targetScriptName} from './targetScripts.ts';
import type {TypeScript, UcfImportOptions, UcfResolution} from './types.ts';

const PLUGIN_NAME = '@multifront/language-tools/typescript-plugin';
// TypeScript looks for `Card.d.ucf.ts` when `./Card.ucf` has no TS extension; it stands for the `.ucf` file.
const UCF_DECLARATION = '.d.ucf.ts';

function propertyValue(ts: TypeScript, object: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const property of object.properties) {
    const {name} = property;
    if (!name || !(ts.isIdentifier(name) || ts.isStringLiteral(name)) || name.text !== key) continue;
    // A shorthand, method or accessor has no initializer; its name stands in as a non-literal value.
    return ts.isPropertyAssignment(property) ? property.initializer : name;
  }
  return undefined;
}

// During resolution only the literal's own parent link is set: read no positions here.
function frameworkValue(ts: TypeScript, literal: ts.StringLiteralLike): ts.Expression | undefined {
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
  return value;
}

// A new SourceFile per edit: one parse per file version.
const rewrites = new WeakMap<ts.SourceFile, Pick<ReturnType<typeof rewriteImportAttributes>, 'imports' | 'errors'>>();

/** The build's `framework-attribute-not-literal` error at this import (spec 4.4). */
function attributeError(literal: ts.StringLiteralLike, sourceFile: ts.SourceFile): Diagnostic | undefined {
  const {imports, errors} = rewrites.get(sourceFile) ?? rewriteImportAttributes(sourceFile.text, sourceFile.fileName);
  rewrites.set(sourceFile, {imports, errors});
  // An error sits in the options of the last `.ucf` import before it; mid-resolution only plain fields like `end` are safe.
  return errors.find(({start}) => imports.findLast(({end}) => end <= start)?.end === literal.end);
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
  options: UcfImportOptions,
  sourceFile: ts.SourceFile // the importer's parse; the build's rewrite reads its text
): UcfResolution {
  // In tsserver a `.ucf` file's own script is its main target's block; `Card.ucf.vue.ts` is its `<vue>` block.
  const importer: Importer = containingFile.endsWith('.ucf')
    ? {fileName: containingFile, block: MAIN_SCRIPT_TARGET}
    : importerFromId(containingFile);
  // Block imports never go through the rewrite; a file that does not parse gets no rewrite error.
  const notLiteral = importer.block ? undefined : attributeError(literal, sourceFile);
  // The build fails this import, so it stays unresolved.
  if (notLiteral) return {resolvedModule: undefined, error: notLiteral};
  const value = frameworkValue(ts, literal);
  const text = value && ts.isStringLiteralLike(value) ? value.text : undefined;
  // Inside a block the key itself is framework-in-block, whatever its value.
  const attribute = importer.block && value ? (text ?? '') : text;
  const choice = resolveTarget(importer, attribute, options);
  if ('error' in choice) return {resolvedModule: undefined, error: choice.error};
  const {target} = choice;
  // No shared cache: the same specifier gets another answer from another importer.
  const {resolvedModule} = ts.resolveModuleName(literal.text, containingFile, options.compilerOptions, ucfHost(options.host));
  if (!resolvedModule?.resolvedFileName.endsWith(UCF_DECLARATION)) return {resolvedModule, target};
  const fileName = resolvedModule.resolvedFileName.slice(0, -UCF_DECLARATION.length) + '.ucf';
  let split = options.getSplit(fileName);
  // No open buffer (a `tsc` host): the file as the host reads it.
  const source = split ? undefined : options.host.readFile(fileName);
  if (source !== undefined) split = splitBlocks(source, fileName);
  let error: UcfResolution['error'];
  if (split && !split.targets[target]) {
    error = {code: 'missing-target-block', message: missingTargetBlockMessage(importer.fileName, fileName, target)};
  }
  const {isExternalLibraryImport} = resolvedModule;
  // Another target's script, `Card.ucf.vue.ts`, is served beside the `.ucf` file's own; with no block it does not exist.
  if (isServedTarget(target)) {
    if (error) return {resolvedModule: undefined, target, error};
    const resolvedFileName = targetScriptName(fileName, target);
    return {resolvedModule: {resolvedFileName, extension: ts.Extension.Ts, isExternalLibraryImport}, target};
  }
  // Resolved even without the block, so adding it in an unsaved edit needs no new resolution.
  return {resolvedModule: {resolvedFileName: fileName, extension: ts.Extension.Tsx, isExternalLibraryImport}, target, error};
}

/** `frameworks`, `framework` and `importers` of our entry in `compilerOptions.plugins`. */
export function entryOptions(compilerOptions: ts.CompilerOptions): ResolveTargetOptions {
  const plugins = (compilerOptions.plugins ?? []) as (ts.PluginImport & Partial<Record<keyof ResolveTargetOptions, unknown>>)[];
  const entry = plugins.find(({name}) => name === PLUGIN_NAME);
  const options: ResolveTargetOptions = {};
  // A list with no valid value is dropped, so it never turns every framework off.
  const frameworks = Array.isArray(entry?.frameworks)
    ? entry.frameworks.filter((value) => typeof value === 'string' && isTarget(value))
    : [];
  if (frameworks.length) options.frameworks = [...new Set(frameworks as Target[])];
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
