import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';
import type {SourceMapInput} from '@jridgewell/trace-mapping';
import type {Plugin, Rolldown} from 'vite';
import type {AST} from 'svelte/compiler';
import {importerFromId, locate, resolveTarget, rewriteImportAttributes} from '@multifront/core';
import type {Importer, SvelteCompiler, VueCompiler} from '@multifront/core';
import {describeDiagnostic, importErrorMessage} from './diagnostics.ts';
import {JS_LIKE} from './ids.ts';
import type {MultifrontOptions} from './types.ts';

type Rewrite = ReturnType<typeof rewriteImportAttributes>;

/** `offset` is in the code `result` read. */
function importError(result: Rewrite, importer: Importer, options: MultifrontOptions) {
  // No readable framework there; its target rules would only add a second error.
  const [error] = result.errors;
  if (error) return {offset: error.start, code: error.code, message: describeDiagnostic(error), short: error.message};
  // Rolldown gives `resolveId` no position; here the error can point at the import.
  for (const entry of result.imports) {
    const choice = resolveTarget(importer, entry.framework, options);
    if ('error' in choice) {
      const message = importErrorMessage(entry.specifier, importer.fileName, describeDiagnostic(choice.error));
      return {offset: entry.start, code: choice.error.code, message, short: `${entry.specifier}: ${choice.error.message}`};
    }
  }
  return undefined;
}

type ImportError = NonNullable<ReturnType<typeof importError>>;

/** Spec 4.4: points the error into the importer's own source. */
function failAtImport(context: Rolldown.TransformPluginContext, code: string, id: string, error: ImportError): never {
  const {offset, message} = error;
  // Vite's dev server maps positions back itself; a `loc` would get mapped twice.
  if (context.environment.mode === 'dev') return context.error(message, offset);
  const at = locate(code, offset);
  const original = originalPositionFor(new TraceMap(context.getCombinedSourcemap() as SourceMapInput), at);
  const loc =
    original.line === null ? {file: id, ...at} : {file: original.source ?? id, line: original.line, column: original.column};
  // `mf-build` prints `short`: the code and importer are fields of its findings.
  return context.error({message, loc, meta: {code: error.code, message: error.short}});
}

interface RawScript {
  start: number; // of its content, in the component file
  content: string;
  lang: string | undefined;
}

/** A component file's own scripts, read before its compiler moves them around. */
function scriptsError(scripts: RawScript[], id: string, options: MultifrontOptions): ImportError | undefined {
  for (const script of scripts) {
    const result = rewriteImportAttributes(script.content, `${id}?lang.${script.lang ?? 'js'}`);
    const error = importError(result, importerFromId(id), options);
    if (error) return {...error, offset: script.start + error.offset};
  }
  return undefined;
}

function vueScripts(compiler: VueCompiler, code: string, id: string): RawScript[] {
  const {descriptor} = compiler.parse(code, {filename: id});
  return [descriptor.script, descriptor.scriptSetup].flatMap((script) =>
    script && !script.src ? [{start: script.loc.start.offset, content: script.content, lang: script.lang}] : []
  );
}

// Undefined when the file does not parse: plugin-svelte reports that.
function svelteScripts(compiler: SvelteCompiler, code: string): RawScript[] | undefined {
  // A preprocessor's style (`lang="scss"`) is no CSS Svelte parses; blanked, every offset stays.
  const unstyled = code.replace(
    /(<style\b[^>]*>)([^]*?)(?=<\/style>)/g,
    (_, tag: string, body: string) => tag + body.replace(/\S/g, ' ')
  );
  let root: AST.Root;
  try {
    root = compiler.parse(unstyled, {modern: true});
  } catch {
    return undefined;
  }
  const scripts = [root.module, root.instance]
    .flatMap((script) => (script ? [script] : []))
    .sort((first, second) => first.start - second.start);
  // Svelte reads every script in the language of the first `lang`.
  const lang = scripts.flatMap(({attributes}) => attributes).find(({name}) => name === 'lang')?.value;
  const text = Array.isArray(lang) && lang[0]?.type === 'Text' ? lang[0].data : undefined;
  return scripts.map(({content}) => {
    // Svelte sets `start` and `end` on the script's Program; its estree type leaves them out.
    const {start, end} = content as unknown as AST.BaseNode;
    return {start, content: code.slice(start, end), lang: text};
  });
}

// `X.ucf.svelte.svelte` is a target module, not an importer: `load` checks its block.
const IMPORTER = /(?:\.vue|(?<!\.ucf\.svelte)\.svelte)$/;

interface Compilers {
  vue: () => VueCompiler | undefined;
  svelte: () => SvelteCompiler;
}

/** Spec 4.4 on the raw file: plugin-vue's script maps nowhere without `build.sourcemap`, plugin-svelte's is relative. */
export function importersPlugin(options: MultifrontOptions, compilers: Compilers): Plugin {
  return {
    name: 'multifront:importers',
    enforce: 'pre',
    transform: {
      // Before plugin-svelte's preprocess, whose map would name the file relatively too.
      order: 'pre',
      filter: {id: IMPORTER, code: /\.ucf/},
      handler(code, id) {
        let scripts: RawScript[] | undefined;
        if (id.endsWith('.svelte')) scripts = svelteScripts(compilers.svelte(), code);
        else {
          const compiler = compilers.vue();
          scripts = compiler && vueScripts(compiler, code, id);
        }
        // A `.ucf` import in Svelte markup is left to the post rewrite.
        const error = scripts && scriptsError(scripts, id, options);
        if (error) failAtImport(this, code, id, error);
      },
    },
  };
}

/** Spec 4.4: moves `with { framework }` into the `.ucf` specifier before Vite's import analysis or Rolldown read it. */
export function attributesPlugin(options: MultifrontOptions): Plugin {
  return {
    name: 'multifront:attributes',
    enforce: 'post',
    transform: {
      filter: {id: JS_LIKE, code: /\.ucf/},
      handler(code, id) {
        const result = rewriteImportAttributes(code, id);
        const error = importError(result, importerFromId(id), options);
        // `offset` is in the compiled code, not the importer's own source.
        if (error) failAtImport(this, code, id, error);
        return result.map ? {code: result.code, map: result.map} : undefined;
      },
    },
  };
}
