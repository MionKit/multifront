import {readFile} from 'node:fs/promises';
import {createBuildContext, splitBlocks} from '@multifront/core';
import type {BuildContext, BuildContextOptions, SplitResult} from '@multifront/core';

/** One `.ucf` file, split and with its shared kinds run. */
export interface UcfEntry {
  split: SplitResult;
  ctx: BuildContext;
}

/** One content of a file; `previous` is the content it replaced, for `hotUpdate`. */
export interface UcfVersion {
  source: string;
  split: SplitResult;
  entry?: Promise<UcfEntry>;
  previous?: Pick<UcfVersion, 'split' | 'entry'>;
}

export type UcfCache = ReturnType<typeof createUcfCache>;

/** Splits once per file content; options are read on the first `loadUcf`, after plugin-vue lent its compiler. */
export function createUcfCache(contextOptions: () => BuildContextOptions) {
  const files = new Map<string, UcfVersion>();

  function store(file: string, source: string): UcfVersion {
    const cached = files.get(file);
    if (cached?.source === source) return cached;
    // Only the replaced split and context: an older `previous` would chain every version.
    const version: UcfVersion = {source, split: splitBlocks(source, file)};
    if (cached) version.previous = {split: cached.split, entry: cached.entry};
    files.set(file, version);
    return version;
  }

  function contextOf(version: UcfVersion): Promise<UcfEntry> {
    const {split} = version;
    version.entry ??= createBuildContext(split, contextOptions()).then((ctx) => ({split, ctx}));
    return version.entry;
  }

  return {
    // No style compile: for resolveId.
    async splitUcf(file: string): Promise<SplitResult> {
      return store(file, await readFile(file, 'utf8')).split;
    },
    async loadUcf(file: string): Promise<UcfEntry> {
      return contextOf(store(file, await readFile(file, 'utf8')));
    },
    // The source Vite's `hotUpdate` read; the same source again keeps `previous`, so every environment sees one diff.
    updateUcf: store,
    contextOf,
  };
}
