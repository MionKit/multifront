import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';
import type {SourceMapInput} from '@jridgewell/trace-mapping';
import type {Plugin} from 'vite';
import {importerFromId, locate, resolveTarget, rewriteImportAttributes} from '@multifront/core';
import {describeDiagnostic, importErrorMessage} from './diagnostics.ts';
import type {MultifrontOptions} from './types.ts';

// With a query too: `C.vue?vue&type=script&setup=true&lang.ts`.
const JS_LIKE = /\.(?:[cm]?[jt]sx?|vue|svelte)(?:\?|$)/;

/** Spec 4.4: moves `with { framework }` into the `.ucf` specifier before Vite's import analysis or Rolldown read it. */
export function attributesPlugin(options: MultifrontOptions): Plugin {
  return {
    name: 'multifront:attributes',
    enforce: 'post',
    transform: {
      filter: {id: JS_LIKE, code: /\.ucf/},
      handler(code, id) {
        // `offset` is in the compiled code; the error must point into the importer's own source.
        const fail = (offset: number, message: string): never => {
          // Vite's dev server maps positions back itself; a `loc` would get mapped twice.
          if (this.environment.mode === 'dev') return this.error(message, offset);
          const at = locate(code, offset);
          const original = originalPositionFor(new TraceMap(this.getCombinedSourcemap() as SourceMapInput), at);
          const loc =
            original.line === null
              ? {file: id, ...at}
              : {file: original.source ?? id, line: original.line, column: original.column};
          return this.error({message, loc});
        };
        const result = rewriteImportAttributes(code, id);
        // No readable framework there; its target rules would only add a second error.
        const [error] = result.errors;
        if (error) fail(error.start, describeDiagnostic(error));
        const importer = importerFromId(id);
        // Rolldown gives `resolveId` no position; here the error can point at the import.
        for (const entry of result.imports) {
          const choice = resolveTarget(importer, entry.framework, options);
          if ('error' in choice) fail(entry.start, importErrorMessage(entry.specifier, importer.fileName, choice.error));
        }
        return result.map ? {code: result.code, map: result.map} : undefined;
      },
    },
  };
}
