import type {Api, Options} from '@vitejs/plugin-vue';
import type {BuildContext, ResolveTargetOptions, SplitResult, Target} from '@multifront/core';
import type {InlineConfig, PluginOption} from 'vite';
import type {createUcfCache} from './cache.ts';

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
  sfc?: string; // the SFC code our transform made from `source`
  previous?: UcfSnapshot;
}

export type UcfCache = ReturnType<typeof createUcfCache>;

/** `compiler` stays null until plugin-vue's `buildStart`. */
export type VuePluginApi = Pick<Api, 'include' | 'exclude'> & {
  options: {compiler?: Options['compiler'] | null; root: string; features?: Options['features']; script?: Options['script']};
};

/** `buildLibrary()` options; paths are relative to `root`. */
export interface LibraryOptions {
  root?: string; // library folder, default process.cwd()
  src?: string; // default 'src'
  index?: string | false; // default 'src/index.ts' when it exists
  outDir?: string; // default 'dist'; each target writes <outDir>/<target>/
  frameworks?: Target[]; // default: every framework with a row and at least one block
  packages?: Partial<Record<Target, {name?: string; peers?: Record<string, string>}>>;
  vite?: InlineConfig; // merged into every target's build
  dts?: boolean; // default true, used from 6.6
}

/** What differs per framework in a library build. */
export interface LibraryTarget {
  plugin(): Promise<PluginOption>; // the framework's Vite plugin
  peers: Record<string, string>; // default peer ranges; also the build's externals
}

/** One target's build: `files` and `skipped` are relative to `outDir` and to `src`. */
export interface LibraryResult {
  target: Target;
  outDir: string;
  packageName: string;
  files: string[];
  skipped: string[];
}
