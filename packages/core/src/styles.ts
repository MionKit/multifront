import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, isAbsolute, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {decode, encode} from '@jridgewell/sourcemap-codec';
import type {SFCStyleCompileOptions} from '@vue/compiler-sfc';
import {createDiagnostic} from './diagnostics.ts';
import {styleId} from './ids.ts';
import type {Block, CompiledStyle, Diagnostic, SourceMap, VueCompiler} from './types.ts';

interface CompileStylesOptions {
  id: string; // the scope id, without 'data-v-'
  filename: string; // absolute .ucf path
  source: string; // the whole .ucf source, for the input map
  compiler: VueCompiler;
  production: boolean;
}

const PREPROCESS_LANGS = ['scss', 'sass', 'less', 'styl', 'stylus'] as const;

interface SassError {
  sassMessage: string;
  span: {url?: URL; start: {offset: number}; end: {offset: number}};
}

interface PostcssError {
  reason: string;
  input: {source: string; offset: number; endOffset?: number};
}

// Vue's parser reads `module=""` as a bare `module`.
export function moduleName(block: Block): string | undefined {
  const {module} = block.attrs;
  if (module === undefined) return undefined;
  return module === true || module === '' ? '$style' : module;
}

/** The preprocessing plugin-vue leaves to Vite; the build and the editor pass the same. */
export function stylePreprocessOptions(block: Block): Pick<SFCStyleCompileOptions, 'preprocessLang' | 'preprocessOptions'> {
  return {
    preprocessLang: PREPROCESS_LANGS.find((lang) => lang === block.attrs.lang),
    // compiler-sfc asks sass for `indentedSyntax`, which sass's `compileString` ignores.
    preprocessOptions: block.attrs.lang === 'sass' ? {syntax: 'indented'} : undefined,
  };
}

/** Passes `compileStyleAsync` the options plugin-vue passes, plus the preprocessing plugin-vue leaves to Vite. */
export function compileStyles(blocks: Block[], options: CompileStylesOptions): Promise<CompiledStyle[]> {
  return Promise.all(blocks.map((block) => compileStyle(block, options)));
}

async function compileStyle(block: Block, options: CompileStylesOptions): Promise<CompiledStyle> {
  const {id, filename, source, compiler, production} = options;
  const module = moduleName(block);
  const scoped = 'scoped' in block.attrs;
  const style = {index: block.index, id: styleId(filename, block.index), scoped, module};
  try {
    const result = await compiler.compileStyleAsync({
      filename,
      id: `data-v-${id}`,
      isProd: production,
      scoped,
      source: block.content,
      ...stylePreprocessOptions(block),
      modules: module !== undefined,
      modulesOptions: modulesOptions(block, scoped, options),
      inMap: blockMap(block, options),
    });
    const errors = result.errors.map((err) => compileError(err, block, options));
    if (errors.length > 0) return {...style, code: '', map: undefined, classes: undefined, errors};
    return {
      ...style,
      code: result.code,
      map: result.map && onlyFile(result.map, filename, source),
      classes: result.modules,
      errors,
    };
  } catch (err) {
    // A missing preprocessor throws before compileStyleAsync can collect it.
    return {...style, code: '', map: undefined, classes: undefined, errors: [compileError(err as Error, block, options)]};
  }
}

// postcss-modules' loader throws outside its promise on a missing or broken `composes … from` file: this one rejects.
function modulesOptions(block: Block, scoped: boolean, {id, filename: root, compiler, production}: CompileStylesOptions) {
  const generateScopedName = (local: string) => `${local}_${id}_${block.index}`;
  // Shared across every composed file, however deep, so each is compiled and emitted once.
  const imports = new Map<string, string[]>();
  const tokens = new Map<string, Promise<Record<string, string>>>();
  const codes = new Map<string, string>();
  const reaches = (from: string, to: string): boolean =>
    from === to || (imports.get(from) ?? []).some((next) => reaches(next, to));

  async function compile(filename: string): Promise<Record<string, string>> {
    const composedOptions = {generateScopedName, Loader: loader(false)};
    const result = await compiler.compileStyleAsync({
      filename,
      id: `data-v-${id}`,
      isProd: production,
      scoped,
      source: await readFile(filename, 'utf8'),
      modules: true,
      modulesOptions: composedOptions,
    });
    if (result.errors[0]) throw result.errors[0];
    codes.set(filename, result.code);
    return result.modules ?? {};
  }

  // Dependencies before the files that compose from them, in `composes` order, like postcss-modules.
  function emit(filename: string, done: Set<string>): string {
    if (done.has(filename)) return '';
    done.add(filename);
    return (imports.get(filename) ?? []).map((next) => emit(next, done)).join('') + (codes.get(filename) ?? '');
  }

  function loader(emits: boolean) {
    return class ComposesLoader {
      async fetch(file: string, importer: string): Promise<Record<string, string>> {
        const filename = composedPath(file, importer);
        if (reaches(filename, importer)) throw new Error(`composes cycle: ${importer} composes from ${filename}`);
        // Recorded before any await: postcss-modules fetches in source order, all at once.
        imports.set(importer, [...(imports.get(importer) ?? []), filename]);
        if (!tokens.has(filename)) tokens.set(filename, compile(filename));
        return tokens.get(filename)!;
      }

      get finalSource(): string {
        return emits ? emit(root, new Set()) : '';
      }
    };
  }

  return {generateScopedName, Loader: loader(true)};
}

// Like postcss-modules: a bare name is a package resolved from the importer, else a relative path.
function composedPath(file: string, importer: string): string {
  const relative = resolve(dirname(importer), file);
  if (file.startsWith('.') || isAbsolute(file)) return relative;
  try {
    return createRequire(importer).resolve(file);
  } catch (err) {
    // Neither a package nor a file: the package error names what the user wrote.
    if (existsSync(relative)) return relative;
    throw err;
  }
}

// So every map chained after it points into the .ucf file, not the bare block.
function blockMap(block: Block, {filename, source, compiler}: CompileStylesOptions) {
  const text = new compiler.MagicString(source);
  text.remove(0, block.contentStart);
  text.remove(block.contentEnd, source.length);
  const map = text.generateMap({source: filename, hires: true, includeContent: true});
  return {...map, version: String(map.version)};
}

// After a preprocessor, PostCSS keeps segments into its output under a second source name: drop them.
function onlyFile(map: Pick<SourceMap, 'file' | 'sources' | 'names' | 'mappings'>, filename: string, source: string): SourceMap {
  const fileIndex = map.sources.indexOf(filename);
  const mappings = decode(map.mappings).map((line) => line.filter((segment) => segment.length === 1 || segment[1] === fileIndex));
  for (const segment of mappings.flat()) if (segment.length !== 1) segment[1] = 0;
  return {
    version: 3,
    file: map.file,
    sources: [filename],
    sourcesContent: [source],
    names: map.names,
    mappings: encode(mappings),
  };
}

function compileError(err: Error, block: Block, {filename, source}: CompileStylesOptions): Diagnostic {
  const tag = typeof block.attrs.lang === 'string' ? `<style lang="${block.attrs.lang}">` : '<style>';
  const report = (start: number, end: number, reason: string) =>
    createDiagnostic({filename, source}, 'style-compile-error', start, end, `${tag} does not compile: ${reason}`);
  const {span, sassMessage} = err as Partial<SassError>;
  // A sass error in an imported file has offsets into that file.
  if (span && sassMessage && span.url?.href === pathToFileURL(filename).href) {
    return report(block.contentStart + span.start.offset, block.contentStart + span.end.offset, sassMessage);
  }
  const {input, reason} = err as Partial<PostcssError>;
  // PostCSS offsets are into what it read: only the raw block content maps onto the .ucf file.
  if (input && reason && input.source === block.content) {
    return report(block.contentStart + input.offset, block.contentStart + (input.endOffset ?? input.offset), reason);
  }
  return report(block.start, block.contentStart, err.message.split('\n')[0]!);
}
