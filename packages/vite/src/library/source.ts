import {readFile} from 'node:fs/promises';
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
  shipUcfImports,
} from '@multifront/core';
import type {SplitResult, SvelteCompiler, Target, VirtualFile} from '@multifront/core';
import type {Preprocessor, PreprocessorGroup} from 'svelte/compiler';
import {parseAst, transformWithOxc} from 'vite';
import type {Plugin} from 'vite';
import type {LibraryComponent, LibraryPackageJob, LibraryTarget, LibraryTypesJob} from '../types.ts';
import {fileOf, isPeer, outputName, shownFile} from './names.ts';
import {rewriteScript, rewriteSpecifiers} from './specifiers.ts';

// A plain Svelte component or runes module of `src`: shipped as its source, like a component.
const PLAIN_SVELTE = /\.svelte(?:\.[jt]s)?$/;
const STYLE_BODY = /(<style\b[^>]*>)([\s\S]*?)(?=<\/style>)/g;

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

// Compiled components, plain Svelte files, their sub-modules and the virtual helpers: none of it ships.
function compiledOnly(moduleIds: string[]): boolean {
  return moduleIds.every((id) => id.startsWith('\0') || fileOf(id).endsWith('.ucf') || PLAIN_SVELTE.test(fileOf(id)));
}

// A shipped file's runtime specifiers that are not relative: the Vite build resolved them, a consumer will not.
function bareImports(code: string, file: string, svelte: boolean, compiler: SvelteCompiler): string[] {
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
  if (!svelte) visit(parseAst(code, {lang: 'js'}, file));
  else {
    const {module, instance, fragment} = compiler.parse(code, {modern: true});
    visit([module, instance, fragment]);
  }
  return found;
}

/** A plain `.svelte` file's code with its `.ucf` imports pointed at the shipped `.svelte` files. */
export function svelteShipped(code: string, compiler: SvelteCompiler): string {
  // Svelte parses every `<style>` as CSS: an unpreprocessed SCSS body would throw, so the parse sees it blanked.
  const blanked = code.replace(STYLE_BODY, (_, open: string, body: string) => open + body.replace(/[^\n]/g, ' '));
  const text = new MagicString(code);
  shipUcfImports(text, compiler.parse(blanked, {modern: true}), 0);
  return text.toString();
}

async function shippedSvelte(file: string, compiler: SvelteCompiler, preprocess: PreprocessorGroup[]): Promise<string> {
  const {code} = await compiler.preprocess(await readFile(file, 'utf8'), preprocess, {filename: file});
  return svelteShipped(code, compiler);
}

// Types stripped, not compiled: the consumer's Svelte compiles the runes.
async function shippedModule(file: string): Promise<string> {
  const source = await readFile(file, 'utf8');
  const code = file.endsWith('.ts')
    ? (await transformWithOxc(source, file, {lang: 'ts', target: 'esnext', sourcemap: false})).code
    : source;
  return rewriteScript(code, 'js', file, '.svelte');
}

// A tag a preprocessor rewrote holds plain JS or CSS now: its `lang` and `type` go, as svelte-package strips them.
function withoutLang(preprocessor: Preprocessor | undefined): Preprocessor | undefined {
  if (!preprocessor) return undefined;
  return async (options) => {
    const processed = await preprocessor(options);
    if (!processed) return processed;
    const {lang: _lang, type: _type, ...attributes} = processed.attributes ?? options.attributes;
    return {...processed, attributes};
  };
}

// The library's own `svelte.config.js` preprocessors, run over every shipped `.svelte` file as svelte-package does.
async function sveltePreprocess(root: string): Promise<PreprocessorGroup[]> {
  const {loadSvelteConfig} = await import('@sveltejs/vite-plugin-svelte');
  const preprocess = (await loadSvelteConfig({root}))?.preprocess;
  return [preprocess ?? []]
    .flat()
    .map(({name, markup, script, style}) => ({name, markup, script: withoutLang(script), style: withoutLang(style)}));
}

/** Swaps each compiled component and plain Svelte file for its source (`Card.svelte`, `count.svelte.js`); the build still checks and compiles it. */
export function librarySource(job: LibrarySourceJob): Plugin {
  const {target, root, src, sourceExt, peers} = job;
  const names = job.components.map(({relative}) => outputName(`${src}/${relative}`, src));
  // Each chunk that ships as source → the extension its importers name instead of `.js`.
  const shipped = new Map<string, string>();
  // The plain Svelte files of `src` the build reached.
  const plain = new Set<string>();
  return {
    name: 'multifront:library-source',
    enforce: 'post',
    renderStart() {
      shipped.clear();
      plain.clear();
      for (const name of names) shipped.set(`${name}.js`, sourceExt);
      for (const id of this.getModuleIds()) {
        const file = id.startsWith('\0') ? undefined : fileOf(id);
        if (!file || !PLAIN_SVELTE.test(file)) continue;
        plain.add(file);
        // `Child.svelte` is written as the chunk `Child.svelte.js`; `count.svelte.ts` ships as that chunk's name.
        if (file.endsWith('.svelte')) shipped.set(`${outputName(file, src)}.js`, '');
      }
    },
    renderChunk(code, chunk) {
      if (compiledOnly(chunk.moduleIds)) return null;
      const text = new MagicString(code);
      rewriteSpecifiers(text, code, 0, 'js', chunk.fileName, (specifier) => {
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined;
        const ext = shipped.get(posix.join(posix.dirname(chunk.fileName), specifier));
        return ext === undefined ? undefined : specifier.slice(0, -'.js'.length) + ext;
      });
      return {code: text.toString(), map: text.generateMap({hires: 'boundary'})};
    },
    async generateBundle(_options, bundle) {
      let helper = false;
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'chunk') continue;
        if (output.moduleIds.includes(`\0${SCOPE_HELPER_ID}`)) helper = true;
        if (!compiledOnly(output.moduleIds)) continue;
        delete bundle[fileName];
        delete bundle[`${fileName}.map`];
      }
      const compiler = loadSvelteCompiler(root);
      const checkImports = (file: string, code: string, svelte: boolean, where = '') => {
        for (const specifier of bareImports(code, file, svelte, compiler)) {
          if (isPeer(peers, specifier)) continue;
          this.error(
            `buildLibrary: ${shownFile(root, file)} imports "${specifier}"${where}: ` +
              `a shipped ${target} file can import relative files and peers only`
          );
        }
      };
      const preprocess = await sveltePreprocess(root);
      const written = new Map<string, string>();
      for (const [index, {split}] of job.components.entries()) {
        const file = await shippedSource(split, root, src, target);
        const fileName = `${names[index]}${file.ext}`;
        const {code} = await compiler.preprocess(file.code, preprocess, {filename: `${src}/${fileName}`});
        checkImports(split.filename, code, true, ` in its <${target}> block`);
        written.set(fileName, split.filename);
        this.emitFile({type: 'asset', fileName, source: code});
      }
      for (const file of [...plain].sort()) {
        const component = file.endsWith('.svelte');
        const fileName = component ? outputName(file, src) : `${outputName(file, src)}.js`;
        const owner = written.get(fileName);
        if (owner !== undefined) {
          this.error(`buildLibrary: ${shownFile(root, owner)} and ${shownFile(root, file)} would both be written as ${fileName}`);
        }
        const code = component ? await shippedSvelte(file, compiler, preprocess) : await shippedModule(file);
        checkImports(file, code, component);
        this.emitFile({type: 'asset', fileName, source: code});
      }
      if (!helper) return;
      if (bundle[LIBRARY_SCOPE_HELPER]) {
        this.error(`buildLibrary: ${LIBRARY_SCOPE_HELPER} is the name of the shipped scope helper; rename that file in src`);
      }
      this.emitFile({type: 'asset', fileName: LIBRARY_SCOPE_HELPER, source: scopeHelperCode(false)});
    },
  };
}
