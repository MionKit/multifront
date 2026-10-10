import type {BuildContext, SplitResult, Target} from '@multifront/core';

export interface MultifrontOptions {
  /** Frameworks this build may compile; defaults to all. */
  frameworks?: Target[];
  /** The framework a bare `import Card from './Card.ucf'` resolves to. */
  framework?: Target;
  /** Importer extension → framework, over the defaults (`.vue`, `.svelte`, `.jsx`, `.tsx`). */
  importers?: Record<string, Target>;
}

/** One `.ucf` file, split and with its shared kinds run. */
export interface UcfEntry {
  split: SplitResult;
  ctx: BuildContext;
}

export interface UcfCache {
  splitUcf(file: string): Promise<SplitResult>; // no style compile: for resolveId
  loadUcf(file: string): Promise<UcfEntry>;
}
