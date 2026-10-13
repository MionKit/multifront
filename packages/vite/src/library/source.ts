import {posix} from 'node:path';
import MagicString from 'magic-string';
import {
  LIBRARY_SCOPE_HELPER,
  SCOPE_HELPER_ID,
  buildTarget,
  createBuildContext,
  loadSvelteCompiler,
  loadVueCompiler,
  scopeHelperCode,
} from '@multifront/core';
import type {SplitResult, Target, VirtualFile} from '@multifront/core';
import type {Plugin} from 'vite';
import type {LibraryComponent, LibraryPackageJob, LibraryTarget, LibraryTypesJob} from '../types.ts';
import {fileOf, isPeer, outputName, shownFile} from './names.ts';
import {rewriteSpecifiers} from './specifiers.ts';

// A plain Svelte component or runes module: compiled, it would ship pinned to the library's Svelte internals.
const PLAIN_SVELTE = /\.svelte(?:\.[jt]s)?$/;

/** What `librarySource()` gets; posix paths. */
interface LibrarySourceJob
  extends
    Pick<LibraryTypesJob, 'target' | 'root' | 'src'>,
    Required<Pick<LibraryTarget, 'sourceExt'>>,
    Pick<LibraryPackageJob, 'peers'> {
  components: LibraryComponent[]; // the `.ucf` files with that block
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

// A source file's runtime specifiers that are not relative: the Vite build resolved them, a consumer will not.
function bareImports(code: string, root: string): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    const node = value as {type?: unknown; source?: {type?: string; value?: unknown}; importKind?: string; exportKind?: string};
    const {source} = node;
    const typeOnly = node.importKind === 'type' || node.exportKind === 'type';
    if (node.type !== 'Literal' && !typeOnly && source?.type === 'Literal' && typeof source.value === 'string') {
      if (!/^\.\.?\//.test(source.value)) found.push(source.value);
    }
    for (const child of Object.values(node)) visit(child);
  };
  const {module, instance, fragment} = loadSvelteCompiler(root).parse(code, {modern: true});
  visit([module, instance, fragment]);
  return found;
}

/** Swaps each compiled component chunk for its uncompiled source (`Card.svelte`); the build still checks and compiles it. */
export function librarySource(job: LibrarySourceJob): Plugin {
  const {target, root, src, sourceExt, peers} = job;
  const names = job.components.map(({relative}) => outputName(`${src}/${relative}`, src));
  const chunks = new Set(names.map((name) => `${name}.js`));
  return {
    name: 'multifront:library-source',
    enforce: 'post',
    renderChunk(code, chunk) {
      if (compiledOnly(chunk.moduleIds)) return null;
      const text = new MagicString(code);
      rewriteSpecifiers(text, code, 0, 'js', chunk.fileName, (specifier) => {
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined;
        const file = posix.join(posix.dirname(chunk.fileName), specifier);
        return chunks.has(file) ? specifier.slice(0, -'.js'.length) + sourceExt : undefined;
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
        const file = await shippedSource(split, root, src, target);
        for (const specifier of bareImports(file.code, root)) {
          if (isPeer(peers, specifier)) continue;
          this.error(
            `buildLibrary: ${shownFile(root, split.filename)} imports "${specifier}" in its <${target}> block: ` +
              `a shipped ${target} file can import relative files and peers only`
          );
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
