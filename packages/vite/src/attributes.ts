import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';
import type {SourceMapInput} from '@jridgewell/trace-mapping';
import type {Plugin, Rolldown} from 'vite';
import {importerFromId, locate, resolveTarget, rewriteImportAttributes} from '@multifront/core';
import type {Importer, VueCompiler} from '@multifront/core';
import {describeDiagnostic, importErrorMessage} from './diagnostics.ts';
import {JS_LIKE} from './ids.ts';
import type {MultifrontOptions} from './types.ts';

type Rewrite = ReturnType<typeof rewriteImportAttributes>;

/** `offset` is in the code `result` read. */
function importError(result: Rewrite, importer: Importer, options: MultifrontOptions) {
  // No readable framework there; its target rules would only add a second error.
  const [error] = result.errors;
  if (error) return {offset: error.start, message: describeDiagnostic(error)};
  // Rolldown gives `resolveId` no position; here the error can point at the import.
  for (const entry of result.imports) {
    const choice = resolveTarget(importer, entry.framework, options);
    if ('error' in choice) {
      const message = importErrorMessage(entry.specifier, importer.fileName, describeDiagnostic(choice.error));
      return {offset: entry.start, message};
    }
  }
  return undefined;
}

type ImportError = NonNullable<ReturnType<typeof importError>>;

/** Spec 4.4: the error sits at `offset` in `code`, mapped back into the importer's own source. */
function failAtImport(context: Rolldown.TransformPluginContext, code: string, id: string, {offset, message}: ImportError): never {
  // Vite's dev server maps positions back itself; a `loc` would get mapped twice.
  if (context.environment.mode === 'dev') return context.error(message, offset);
  const at = locate(code, offset);
  const original = originalPositionFor(new TraceMap(context.getCombinedSourcemap() as SourceMapInput), at);
  const loc =
    original.line === null ? {file: id, ...at} : {file: original.source ?? id, line: original.line, column: original.column};
  return context.error({message, loc});
}

interface RawScript {
  start: number; // of its content, in the component file
  content: string;
  lang: string | undefined;
}

/** The first import error of a component file's own scripts, before its compiler moves them around. */
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

interface Compilers {
  vue: () => VueCompiler | undefined;
}

/** Spec 4.4 on the raw `.vue` file: without `build.sourcemap` plugin-vue's script sub-module maps nowhere back. */
export function importersPlugin(options: MultifrontOptions, compilers: Compilers): Plugin {
  return {
    name: 'multifront:importers',
    enforce: 'pre',
    transform: {
      filter: {id: /\.vue$/, code: /\.ucf/},
      handler(code, id) {
        const compiler = compilers.vue();
        const error = compiler && scriptsError(vueScripts(compiler, code, id), id, options);
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
        // `offset` is in the compiled code; the error must point into the importer's own source.
        if (error) failAtImport(this, code, id, error);
        return result.map ? {code: result.code, map: result.map} : undefined;
      },
    },
  };
}
