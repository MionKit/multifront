import {extname} from 'node:path';
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

function fail(code: TargetErrorCode, message: string): TargetChoice {
  return {error: {code, message}};
}

/** First rule that applies wins (spec 4.1, 4.2). The caller adds the position. */
export function resolveTarget(
  importer: Importer,
  attribute: string | undefined,
  options: ResolveTargetOptions = {}
): TargetChoice {
  const {block} = importer;
  if (block) {
    if (attribute === undefined) return {target: block, rule: 'block'};
    return fail(
      'framework-in-block',
      `a framework attribute cannot sit inside the <${block}> block; imports there always get ${block}`
    );
  }
  if (attribute !== undefined) {
    if (isTarget(attribute)) return {target: attribute, rule: 'attribute'};
    return fail('unknown-framework', `unknown framework "${attribute}"; use ${orList(TARGETS)}`);
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
