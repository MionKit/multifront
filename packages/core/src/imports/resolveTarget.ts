import {basename, dirname, extname, isAbsolute, relative, sep} from 'node:path';
import {orList} from '../diagnostics.ts';
import {TARGETS, isTarget} from '../targets.ts';
import type {Importer, ResolveTargetOptions, Target, TargetChoice, TargetErrorCode} from '../types.ts';

/** Importer extension → framework, before the project's `importers` option (spec 4.2, rule 2). */
export const DEFAULT_IMPORTERS: Readonly<Record<string, Target>> = Object.freeze({
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.jsx': 'react',
  '.tsx': 'react',
});

// After `X.ucf`: the target module ids (spec 4.3) and the editor's virtual scripts (spec 5).
const BLOCK_SUFFIXES: readonly (readonly [string, Target])[] = [
  ['.react.tsx', 'react'],
  ['.svelte.svelte', 'svelte'],
  ['.vue.ts', 'vue'],
  ['.svelte.ts', 'svelte'],
];

/** Shared with `react.check`. */
export function frameworkInBlockMessage(block: Target): string {
  return `a framework attribute cannot sit inside the <${block}> block; imports there always get ${block}`;
}

/** `fileName` as the importer would write it. */
export function importPath(importerFile: string, fileName: string): string {
  const path = relative(dirname(importerFile), fileName).split(sep).join('/');
  return isAbsolute(path) || /^\.\.?\//.test(path) ? path : `./${path}`;
}

/** Shared by the build and the editor, so both name the two files the same way. */
export function missingTargetBlockMessage(importerFile: string, ucfFile: string, target: Target): string {
  return `${importPath(importerFile, ucfFile)} has no <${target}> block; ${basename(importerFile)} imports it as ${target}`;
}

function fail(code: TargetErrorCode, message: string): TargetChoice {
  return {error: {code, message}};
}

/** The importer a module id or virtual script name stands for, with the `.ucf` block it is (spec 4.1). */
export function importerFromId(id: string): Importer {
  const queryStart = id.indexOf('?');
  const path = queryStart === -1 ? id : id.slice(0, queryStart);
  // The Vue block keeps the real path (spec 4.3); our style and class map ids import no `.ucf` file.
  if (path.endsWith('.ucf')) return {fileName: path, block: 'vue'};
  for (const [suffix, block] of BLOCK_SUFFIXES) {
    if (path.endsWith(`.ucf${suffix}`)) return {fileName: path.slice(0, -suffix.length), block};
  }
  return {fileName: path};
}

function pickTarget(importer: Importer | undefined, attribute: string | undefined, options: ResolveTargetOptions): TargetChoice {
  const block = importer?.block;
  if (block) {
    if (attribute === undefined) return {target: block, rule: 'block'};
    return fail('framework-in-block', frameworkInBlockMessage(block));
  }
  if (attribute !== undefined) {
    if (isTarget(attribute)) return {target: attribute, rule: 'attribute'};
    return fail('unknown-framework', `unknown framework "${attribute}"; use ${orList(TARGETS)}`);
  }
  if (!importer) {
    if (options.framework) return {target: options.framework, rule: 'default'};
    return fail('no-target', 'no framework for this .ucf entry; set the framework option');
  }
  const importers = {...DEFAULT_IMPORTERS, ...options.importers};
  const ext = extname(importer.fileName);
  if (Object.hasOwn(importers, ext)) return {target: importers[ext]!, rule: 'importer'};
  if (options.framework) return {target: options.framework, rule: 'default'};
  return fail(
    'no-target',
    `no framework for this .ucf import; add with {framework: 'react'} (or vue, svelte), ` +
      `import it from a ${orList(Object.keys(importers))} file, or set the framework option`
  );
}

/** First rule that applies wins (spec 4.1, 4.2); no importer is a build entry. The caller adds the position. */
export function resolveTarget(
  importer: Importer | undefined,
  attribute: string | undefined,
  options: ResolveTargetOptions = {}
): TargetChoice {
  const choice = pickTarget(importer, attribute, options);
  const enabled = options.frameworks ?? TARGETS;
  if ('error' in choice || enabled.includes(choice.target)) return choice;
  const {target} = choice;
  const fix = enabled.length ? `use ${orList(enabled)}, or add ${target} to` : 'add it to';
  return fail('target-not-enabled', `framework "${target}" is not enabled; ${fix} the frameworks option`);
}
