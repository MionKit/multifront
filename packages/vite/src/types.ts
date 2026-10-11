import type {BuildContext, ResolveTargetOptions, SplitResult} from '@multifront/core';

/** `frameworks` (default all), `framework` (the default of spec 4.2) and `importers` (extension → framework). */
export type MultifrontOptions = ResolveTargetOptions;

/** One `.ucf` file, split and with its shared kinds run. */
export interface UcfEntry {
  split: SplitResult;
  ctx: BuildContext;
}

/** `entry` is set once something compiled the split. */
export interface UcfSnapshot {
  split: SplitResult;
  entry?: Promise<UcfEntry>;
}

/** One content of a file; `previous` is the one it replaced. */
export interface UcfVersion extends UcfSnapshot {
  source: string;
  previous?: UcfSnapshot;
}
