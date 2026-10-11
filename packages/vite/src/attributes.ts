import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';
import type {SourceMapInput} from '@jridgewell/trace-mapping';
import type {Plugin} from 'vite';
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

/** Spec 4.4 on the raw `.vue` file: without `build.sourcemap` plugin-vue's script sub-module maps nowhere back. */
export function vueImportersPlugin(options: MultifrontOptions, vueCompiler: () => VueCompiler | undefined): Plugin {
  return {
    name: 'multifront:vue-importers',
    enforce: 'pre',
    transform: {
      filter: {id: /\.vue$/, code: /\.ucf/},
      handler(code, id) {
        const compiler = vueCompiler();
        if (!compiler) return;
        const {descriptor} = compiler.parse(code, {filename: id});
        for (const script of [descriptor.script, descriptor.scriptSetup]) {
          if (!script || script.src) continue;
          const result = rewriteImportAttributes(script.content, `${id}?lang.${script.lang ?? 'js'}`);
          const error = importError(result, importerFromId(id), options);
          if (!error) continue;
          const offset = script.loc.start.offset + error.offset;
          // Vite's dev server maps positions back itself.
          if (this.environment.mode === 'dev') return this.error(error.message, offset);
          return this.error({message: error.message, loc: {file: id, ...locate(code, offset)}});
        }
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
        if (error) {
          // Vite's dev server maps positions back itself; a `loc` would get mapped twice.
          if (this.environment.mode === 'dev') return this.error(error.message, error.offset);
          // `offset` is in the compiled code; the error must point into the importer's own source.
          const at = locate(code, error.offset);
          const original = originalPositionFor(new TraceMap(this.getCombinedSourcemap() as SourceMapInput), at);
          const loc =
            original.line === null
              ? {file: id, ...at}
              : {file: original.source ?? id, line: original.line, column: original.column};
          return this.error({message: error.message, loc});
        }
        return result.map ? {code: result.code, map: result.map} : undefined;
      },
    },
  };
}
