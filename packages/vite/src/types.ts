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

/** Our part of a module's meta, under `multifront`. */
export interface UcfModuleMeta {
  useClient: boolean; // the React target: its block needs `"use client"`
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
  dts?: boolean; // default true: a .d.ts beside every JS file
}

/** What differs per framework in a library build. */
export interface LibraryTarget {
  plugin(): Promise<PluginOption>; // the framework's Vite plugin
  peers: Record<string, string>; // default peer ranges; also the build's externals
  conditions?: string[]; // export conditions naming each file, after `types`; default ['default']
  useClient?: boolean; // `"use client"` atop the output files that need it (React Server Components)
  sourceExt?: '.svelte'; // components ship uncompiled (`Card.svelte`); the build still compiles them for its checks
  emitTypes(job: LibraryTypesJob): Promise<void>; // writes the `.d.ts` files beside the JS build's output
}

/** What a row's `emitTypes()` gets; posix paths, `modules` relative to `src`. */
export interface LibraryTypesJob extends Pick<LibraryResult, 'target' | 'outDir'> {
  root: string; // library folder
  src: string;
  modules: string[]; // the .ucf files and plain modules the JS build wrote: 'Card.ucf', 'utils/cx.ts'
}

/** What `writePackageJson()` gets; posix paths, output names without their extension. */
export interface LibraryPackageJob extends Pick<LibraryResult, 'outDir' | 'packageName'> {
  root: string; // library folder: its README.md and LICENSE
  manifest: Record<string, unknown>; // the library's package.json, {} when it has none
  peers: Record<string, string>;
  index?: string; // 'index'
  components: string[]; // 'Card', 'forms/Field'
  componentExt: '.js' | NonNullable<LibraryTarget['sourceExt']>;
  conditions: string[];
}

/** A `.ucf` file of the library, split once. */
export interface LibraryComponent {
  relative: string; // from src, posix
  split: SplitResult;
}

/** A language Vite's `parseAst` reads. */
export type Lang = 'js' | 'jsx' | 'ts' | 'tsx' | 'dts';

/** `files` are relative to `outDir`, `skipped` to `src`. */
export interface LibraryResult {
  target: Target;
  outDir: string;
  packageName: string;
  files: string[];
  skipped: string[];
}
