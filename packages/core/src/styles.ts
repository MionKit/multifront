import {decode, encode} from '@jridgewell/sourcemap-codec';
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

type PreprocessLang = 'scss' | 'sass' | 'less' | 'styl' | 'stylus';
const PREPROCESS_LANGS: readonly string[] = ['scss', 'sass', 'less', 'styl', 'stylus'] satisfies PreprocessLang[];

interface SassError {
  sassMessage: string;
  span: {start: {offset: number}; end: {offset: number}};
}

interface PostcssError {
  name: 'CssSyntaxError';
  reason: string;
  input: {offset: number; endOffset?: number};
}

// Vue's parser reads `module=""` as a bare `module`.
export function moduleName(block: Block): string | undefined {
  const {module} = block.attrs;
  if (module === undefined) return undefined;
  return module === true || module === '' ? '$style' : module;
}

/** One `compileStyleAsync` call per block, with the options plugin-vue passes. */
export function compileStyles(blocks: Block[], options: CompileStylesOptions): Promise<CompiledStyle[]> {
  return Promise.all(blocks.map((block) => compileStyle(block, options)));
}

async function compileStyle(block: Block, options: CompileStylesOptions): Promise<CompiledStyle> {
  const {id, filename, source, compiler, production} = options;
  const lang = typeof block.attrs.lang === 'string' ? block.attrs.lang : undefined;
  const preprocessLang = lang !== undefined && PREPROCESS_LANGS.includes(lang) ? (lang as PreprocessLang) : undefined;
  const module = moduleName(block);
  const scoped = 'scoped' in block.attrs;
  const result = await compiler.compileStyleAsync({
    filename,
    id: `data-v-${id}`,
    isProd: production,
    scoped,
    source: block.content,
    preprocessLang,
    modules: module !== undefined,
    modulesOptions: {generateScopedName: (local: string) => `${local}_${id}_${block.index}`},
    inMap: blockMap(block, options),
  });
  const errors = result.errors.map((err) => compileError(err, block, options, preprocessLang !== undefined));
  return {
    index: block.index,
    id: styleId(filename, block.index),
    code: result.code,
    map: result.map && onlyFile(result.map, filename, source),
    scoped,
    module,
    classes: result.modules,
    errors,
  };
}

// Maps the block content to its place in the .ucf file, so every map after it points into the .ucf file.
function blockMap(block: Block, {filename, source, compiler}: CompileStylesOptions) {
  const text = new compiler.MagicString(source);
  text.remove(0, block.contentStart);
  text.remove(block.contentEnd, source.length);
  const map = text.generateMap({source: filename, hires: true, includeContent: true});
  return {...map, version: String(map.version)};
}

// After a preprocessor, PostCSS keeps segments it cannot follow through the input map: they point at the
// preprocessor's output under a second source name, so they go.
function onlyFile(
  map: {mappings: string; sources: string[]; names: string[]; file?: string},
  filename: string,
  source: string
): SourceMap {
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

function compileError(err: Error, block: Block, {filename, source}: CompileStylesOptions, preprocessed: boolean): Diagnostic {
  const tag = typeof block.attrs.lang === 'string' ? `<style lang="${block.attrs.lang}">` : '<style>';
  const report = (start: number, end: number, reason: string) =>
    createDiagnostic({filename, source}, 'style-compile-error', start, end, `${tag} does not compile: ${reason}`);
  if (isSassError(err)) {
    return report(block.contentStart + err.span.start.offset, block.contentStart + err.span.end.offset, err.sassMessage);
  }
  // PostCSS offsets are into what it read, which is the block content only when nothing preprocessed it.
  if (isPostcssError(err) && !preprocessed) {
    const {offset, endOffset = offset} = err.input;
    return report(block.contentStart + offset, block.contentStart + endOffset, err.reason);
  }
  return report(block.start, block.contentStart, err.message.split('\n')[0]!);
}

function isSassError(err: Error): err is Error & SassError {
  return typeof (err as Partial<SassError>).span?.start?.offset === 'number';
}

function isPostcssError(err: Error): err is Error & PostcssError {
  return err.name === 'CssSyntaxError' && typeof (err as Partial<PostcssError>).input?.offset === 'number';
}
