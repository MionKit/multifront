import {readFile} from 'node:fs/promises';
import {createBuildContext, splitBlocks} from '@multifront/core';
import type {BuildContextOptions, SplitResult} from '@multifront/core';
import type {UcfCache, UcfEntry} from './types.ts';

interface Cached {
  source: string;
  split: SplitResult;
  entry?: Promise<UcfEntry>;
}

/** Splits once per file content; options are read on the first `loadUcf`, after plugin-vue lent its compiler. */
export function createUcfCache(contextOptions: () => BuildContextOptions): UcfCache {
  const files = new Map<string, Cached>();

  async function read(file: string): Promise<Cached> {
    const source = await readFile(file, 'utf8');
    let cached = files.get(file);
    if (cached?.source !== source) {
      cached = {source, split: splitBlocks(source, file)};
      files.set(file, cached);
    }
    return cached;
  }

  return {
    async splitUcf(file) {
      return (await read(file)).split;
    },
    async loadUcf(file) {
      const cached = await read(file);
      const {split} = cached;
      cached.entry ??= createBuildContext(split, contextOptions()).then((ctx) => ({split, ctx}));
      return cached.entry;
    },
  };
}
