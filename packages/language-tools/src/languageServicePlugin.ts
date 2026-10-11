// Volar's tsserver quickstart, minus its module-level records. Volar lets one plugin per `@volar/typescript` copy
// decorate a host and keeps one external-file list per project. Vue's plugin shares that copy when both come from one
// install, so whichever loaded second never ran. This one keeps its records per plugin.
import {searchExternalFiles} from '@volar/typescript/lib/node/decorateLanguageServiceHost.js';
import {createProxyLanguageService} from '@volar/typescript/lib/node/proxyLanguageService.js';
import {createLanguageCommon} from '@volar/typescript/lib/quickstart/languageServicePluginCommon.js';
import type {createPluginCallbackSync} from '@volar/typescript/lib/quickstart/languageServicePluginCommon.js';
import type * as ts from 'typescript';

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
        info.languageService = proxy;
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
