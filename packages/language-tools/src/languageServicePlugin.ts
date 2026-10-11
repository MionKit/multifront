// Volar's tsserver quickstart, records kept per plugin. Volar keeps them per `@volar/typescript` copy (host decorated,
// external files per project, transform cache by diagnostic object), shared with Vue's plugin from one install: the
// second loaded never ran, and a diagnostic one proxy left as is came out of the other untransformed.
import {searchExternalFiles} from '@volar/typescript/lib/node/decorateLanguageServiceHost.js';
import {createProxyLanguageService} from '@volar/typescript/lib/node/proxyLanguageService.js';
import {createLanguageCommon} from '@volar/typescript/lib/quickstart/languageServicePluginCommon.js';
import type {createPluginCallbackSync} from '@volar/typescript/lib/quickstart/languageServicePluginCommon.js';
import type * as ts from 'typescript';

const DIAGNOSTIC_METHODS = new Set<string | symbol>([
  'getSyntacticDiagnostics',
  'getSemanticDiagnostics',
  'getSuggestionDiagnostics',
]);

const copy = (diagnostic: ts.Diagnostic): ts.Diagnostic => ({
  ...diagnostic,
  relatedInformation: diagnostic.relatedInformation?.map((related) => ({...related})),
});

/** Every diagnostic a new object, so no other plugin's transform cache holds it. */
export function freshDiagnostics(languageService: ts.LanguageService): ts.LanguageService {
  return new Proxy(languageService, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (!DIAGNOSTIC_METHODS.has(key) || typeof value !== 'function') return value;
      return (fileName: string) => (value as (fileName: string) => ts.Diagnostic[])(fileName).map(copy);
    },
  });
}

/** `createLanguageServicePlugin` of `@volar/typescript`, its records kept per plugin, not per module copy. */
export function createLanguageServicePlugin(callback: createPluginCallbackSync): ts.server.PluginModuleFactory {
  // Per plugin, not per factory call: tsserver calls the factory again on each reload.
  const decorated = new WeakSet<ts.LanguageServiceHost>();
  const extensions = new WeakMap<ts.server.Project, string[]>();
  const externalFiles = new WeakMap<ts.server.Project, string[]>();
  return ({typescript: ts}) => {
    return {
      create(info) {
        // A tsconfig reload calls `create` again on the same host.
        if (decorated.has(info.languageServiceHost)) return info.languageService;
        decorated.add(info.languageServiceHost);
        const result = callback(ts, info);
        const fileExtensions = result.languagePlugins.flatMap(
          (plugin) => plugin.typescript?.extraFileExtensions.map(({extension}) => `.${extension}`) ?? []
        );
        extensions.set(info.project, fileExtensions);
        const {proxy, initialize} = createProxyLanguageService(info.languageService);
        info.languageService = freshDiagnostics(proxy);
        createLanguageCommon(result, ts, info, initialize);
        return info.languageService;
      },
      getExternalFiles(project, updateLevel = 0) {
        const old = externalFiles.get(project);
        if (old && updateLevel < 1) return old;
        const fileExtensions = extensions.get(project) ?? [];
        const files = fileExtensions.length > 0 ? searchExternalFiles(ts, project, fileExtensions) : [];
        externalFiles.set(project, files);
        if (old && (old.length !== files.length || files.some((file) => !old.includes(file)))) project.refreshDiagnostics();
        return files;
      },
    };
  };
}
