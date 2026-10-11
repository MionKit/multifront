import {BLOCK_KINDS} from './blocks/index.ts';
import {rootRelativePath, scopeId} from './scopeId.ts';
import type {BuildContext, BuildContextOptions, SplitResult} from './types.ts';

/** Runs no checks: hosts call `checkBlocks` first. */
export async function createBuildContext(split: SplitResult, options: BuildContextOptions): Promise<BuildContext> {
  const {root, compiler, production} = options;
  const {filename, source} = split;
  const relativePath = rootRelativePath(root, filename);
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
  // Sequential, in registry order: a later shared kind may read what an earlier one filled.
  for (const kind of BLOCK_KINDS) {
    if (kind.role !== 'shared') continue;
    await kind.fillContext?.(
      split.blocks.filter((block) => block.type === kind.tag),
      ctx
    );
  }
  return ctx;
}
