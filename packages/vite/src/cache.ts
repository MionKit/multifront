import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createBuildContext, splitBlocks} from '@multifront/core';
import type {BuildContextOptions, SplitResult} from '@multifront/core';
import type {FrontEntry, FrontVersion} from './types.ts';

/** Splits once per file content; options are read on the first compile, after plugin-vue lent its compiler. */
export function createFrontCache(contextOptions: () => BuildContextOptions) {
  const files = new Map<string, FrontVersion>();

  function store(file: string, source: string): FrontVersion {
    const cached = files.get(file);
    if (cached?.source === source) return cached;
    // Only the replaced split and context: an older `previous` would chain every version.
    const version: FrontVersion = {source, split: splitBlocks(source, file)};
    if (cached) version.previous = {split: cached.split, entry: cached.entry};
    files.set(file, version);
    return version;
  }

  function contextOf(version: FrontVersion): Promise<FrontEntry> {
    const {split} = version;
    version.entry ??= createBuildContext(split, contextOptions()).then((ctx) => ({split, ctx}));
    return version.entry;
  }

  return {
    // No style compile: for resolveId.
    async splitFront(file: string): Promise<SplitResult> {
      return store(file, await readFile(file, 'utf8')).split;
    },
    async loadFront(file: string): Promise<FrontEntry> {
      return contextOf(store(file, await readFile(file, 'utf8')));
    },
    // Synchronous, for plugin-vue's component id generator.
    sourceOf(file: string): string {
      return (files.get(file) ?? store(file, readFileSync(file, 'utf8'))).source;
    },
    // The source Vite's `hotUpdate` read.
    updateFront: store,
    // For plugin-vue's source maps.
    sourceBehind(file: string, code: string): string | undefined {
      const latest = files.get(file);
      return latest?.sfc === code ? latest.source : undefined;
    },
    contextOf,
  };
}
