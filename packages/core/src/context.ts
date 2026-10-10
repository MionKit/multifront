import {relative, sep} from 'node:path';
import {BLOCK_KINDS} from './blocks/index.ts';
import {scopeId} from './scopeId.ts';
import type {BuildContext, BuildContextOptions, SplitResult} from './types.ts';

/** Runs no checks: hosts call `checkBlocks` first. */
export async function createBuildContext(split: SplitResult, options: BuildContextOptions): Promise<BuildContext> {
  const {root, compiler, production} = options;
  const {filename, source} = split;
  // plugin-vue hashes `normalizePath(relative(root, filename))`.
  const relativePath = relative(root, filename).split(sep).join('/');
  const ctx: BuildContext = {
    filename,
    split,
    relativePath,
    source,
    production,
    compiler,
    scopeId: scopeId(relativePath, source, production),
    hasScoped: false,
    styles: [],
    modules: {},
  };
  // One after another, in registry order: a later shared kind may read what an earlier one filled.
  for (const kind of BLOCK_KINDS) {
    if (kind.role !== 'shared') continue;
    await kind.fillContext?.(
      split.blocks.filter((block) => block.type === kind.tag),
      ctx
    );
  }
  return ctx;
}
