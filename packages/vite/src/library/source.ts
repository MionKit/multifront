import {posix} from 'node:path';
import MagicString from 'magic-string';
import {
  DiagnosticsError,
  LIBRARY_SCOPE_HELPER,
  SCOPE_HELPER_ID,
  buildTarget,
  createBuildContext,
  loadVueCompiler,
  scopeHelperCode,
} from '@multifront/core';
import type {SplitResult, Target, VirtualFile} from '@multifront/core';
import type {Plugin} from 'vite';
import {rollupError} from '../diagnostics.ts';
import {fileOf, outputName, shownFile} from './names.ts';
import {rewriteSpecifiers} from './specifiers.ts';

// A plain Svelte component or runes module: compiled, it would ship pinned to the library's Svelte internals.
const PLAIN_SVELTE = /\.svelte(?:\.[jt]s)?$/;

/** What `librarySource()` gets; posix paths. */
export interface LibrarySourceJob {
  target: Target;
  root: string;
  src: string;
  ext: string; // the shipped file's extension: '.svelte'
  components: {relative: string; split: SplitResult}[]; // the `.ucf` files with that block, relative to `src`
}

/** A component as its package ships it: the target's own source, importing real files beside it. */
export async function shippedSource(split: SplitResult, root: string, src: string, target: Target): Promise<VirtualFile> {
  const ctx = await createBuildContext(split, {root, compiler: loadVueCompiler(root), production: true, library: {src}});
  return buildTarget(split, ctx, target);
}

// Compiled components, their sub-modules and the virtual helpers: none of it ships.
function compiledOnly(moduleIds: string[]): boolean {
  return moduleIds.every((id) => id.startsWith('\0') || fileOf(id).endsWith('.ucf'));
}

/** Swaps each compiled component chunk for its uncompiled source (`Card.svelte`); the build still checks and compiles it. */
export function librarySource(job: LibrarySourceJob): Plugin {
  const {target, root, src, ext} = job;
  const names = job.components.map(({relative}) => outputName(`${src}/${relative}`, src));
  const chunks = new Set(names.map((name) => `${name}.js`));
  return {
    name: 'multifront:library-source',
    enforce: 'post',
    renderChunk(code, chunk) {
      if (compiledOnly(chunk.moduleIds) || !chunk.imports.some((name) => chunks.has(name))) return null;
      const text = new MagicString(code);
      rewriteSpecifiers(text, code, 0, 'js', chunk.fileName, (specifier) => {
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined;
        const file = posix.join(posix.dirname(chunk.fileName), specifier);
        return chunks.has(file) ? specifier.slice(0, -'.js'.length) + ext : undefined;
      });
      return {code: text.toString(), map: text.generateMap({hires: 'boundary'})};
    },
    async generateBundle(_options, bundle) {
      let helper = false;
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const id of output.moduleIds) {
          if (id === `\0${SCOPE_HELPER_ID}`) helper = true;
          const file = id.startsWith('\0') ? undefined : fileOf(id);
          if (file && !file.endsWith('.ucf') && PLAIN_SVELTE.test(file)) {
            this.error(
              `buildLibrary: ${shownFile(root, file)}: a library package ships ${target} code from .ucf <${target}> blocks only`
            );
          }
        }
        if (!compiledOnly(output.moduleIds)) continue;
        delete bundle[fileName];
        delete bundle[`${fileName}.map`];
      }
      for (const [index, {split}] of job.components.entries()) {
        let file: VirtualFile;
        try {
          file = await shippedSource(split, root, src, target);
        } catch (err) {
          if (err instanceof DiagnosticsError) this.error(rollupError(err.diagnostics));
          throw err;
        }
        this.emitFile({type: 'asset', fileName: `${names[index]}${file.ext}`, source: file.code});
      }
      if (!helper) return;
      if (bundle[LIBRARY_SCOPE_HELPER]) {
        this.error(`buildLibrary: ${LIBRARY_SCOPE_HELPER} is the name of the shipped scope helper; rename that file in src`);
      }
      this.emitFile({type: 'asset', fileName: LIBRARY_SCOPE_HELPER, source: scopeHelperCode(false)});
    },
  };
}
