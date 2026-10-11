import type {BuildContext, ResolveTargetOptions, SplitResult, VueCompiler} from '@multifront/core';

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

type FilterPattern = string | RegExp | (string | RegExp)[];

/** The part of plugin-vue's `api` we use; `include` and `exclude` lock once its `options` hook ran. */
export interface VuePluginApi {
  options: {compiler?: VueCompiler | null; root: string};
  include: FilterPattern | undefined;
  exclude: FilterPattern | undefined;
}
