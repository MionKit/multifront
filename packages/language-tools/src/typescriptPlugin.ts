import {loadSvelteCompiler, loadVueCompiler} from '@multifront/core';
import type * as ts from 'typescript';
import {createFrontLanguagePlugin} from './languagePlugin.ts';
import {createLanguageServicePlugin, freshDiagnostics} from './languageServicePlugin.ts';
import {withImportErrors} from './importErrors.ts';
import {entryOptions, withFrontResolution} from './resolve.ts';
import {serveTargetScripts} from './targetScripts.ts';
import type {EditorOptions, FrontImportOptions, FrontVirtualCode} from './types.ts';
import {serveVueRequests} from './vueRequests.ts';

/** `@vue/compiler-sfc` and `svelte` are optional: a React-only app has neither. */
function projectCompiler<Compiler>(
  info: ts.server.PluginCreateInfo,
  load: (root: string) => Compiler,
  without: string
): Compiler | undefined {
  try {
    return load(info.project.getCurrentDirectory());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    info.project.projectService.logger.info(`multifront: ${without} (${reason})`);
    return undefined;
  }
}

// Volar's proxy, wrapped once its callback ran: requests in a target's block go to that target's script.
const routers = new WeakMap<ts.server.PluginCreateInfo, (languageService: ts.LanguageService) => ts.LanguageService>();
const afterUpdates = new WeakMap<ts.server.Project, () => void>();

/** What a host bundling the plugin sets. */
type TypeScriptPluginOptions = Pick<EditorOptions, 'vueTypesRoot' | 'svelteTypesRoot'>;

const createVolarPlugin = ({vueTypesRoot, svelteTypesRoot}: TypeScriptPluginOptions) =>
  createLanguageServicePlugin((ts, info) => {
    const host = info.languageServiceHost;
    // tsserver's host is a Project instance: its methods need their `this`.
    const resolutionHost: ts.ModuleResolutionHost = {
      fileExists: (fileName) => host.fileExists(fileName),
      readFile: (fileName) => host.readFile(fileName),
      directoryExists: host.directoryExists && ((dir) => host.directoryExists!(dir)),
      realpath: host.realpath && ((path) => host.realpath!(path)),
      getCurrentDirectory: () => host.getCurrentDirectory(),
      getDirectories: host.getDirectories && ((path) => host.getDirectories!(path)),
      useCaseSensitiveFileNames: () => host.useCaseSensitiveFileNames?.() ?? ts.sys.useCaseSensitiveFileNames,
    };
    let getSplit: FrontImportOptions['getSplit'] = () => undefined;
    const importOptions = (compilerOptions: ts.CompilerOptions): FrontImportOptions => ({
      ...entryOptions(compilerOptions),
      compilerOptions,
      host: resolutionHost,
      getSplit,
    });

    // Wrapped before Volar's proxy, so Volar maps these positions into the `.front` file.
    // Fresh objects: a Volar plugin under ours (Vue's) on our `@volar/typescript` copy cached its transform of each.
    const languageService = info.languageService;
    info.languageService = freshDiagnostics({
      ...languageService,
      getSemanticDiagnostics(fileName) {
        const diagnostics = languageService.getSemanticDiagnostics(fileName);
        const program = languageService.getProgram();
        const sourceFile = program?.getSourceFile(fileName);
        if (!program || !sourceFile) return diagnostics;
        return withImportErrors(ts, sourceFile, diagnostics, importOptions(program.getCompilerOptions()));
      },
    });
    const base = info.languageService;
    const targetScripts = serveTargetScripts(ts, info, base);
    routers.set(info, targetScripts.route);
    afterUpdates.set(info.project, targetScripts.afterUpdate);

    const compilerOptions = host.getCompilationSettings();
    const editorOptions: EditorOptions = {
      compiler: projectCompiler(info, loadVueCompiler, 'no Vue compiler, $style reads plain CSS modules only'),
      ts,
      compilerOptions,
      vueTypesRoot,
      // Without it a svelte pick has no script, so TypeScript cannot find the module.
      svelteCompiler: projectCompiler(info, loadSvelteCompiler, 'no Svelte compiler, svelte picks have no types'),
      svelteTypesRoot,
    };
    return {
      languagePlugins: [createFrontLanguagePlugin(editorOptions)],
      setup(language) {
        targetScripts.setup(language);
        serveVueRequests(ts, info, language, base);
        getSplit = (fileName) => (language.scripts.get(fileName)?.generated?.root as FrontVirtualCode | undefined)?.split;
        const resolve = host.resolveModuleNameLiterals?.bind(host);
        if (!resolve) return;
        type Resolve = typeof resolve;
        const wrapResolve = (inner: Resolve): Resolve => withFrontResolution(ts, inner, importOptions);
        // Outermost in any order: a later Volar plugin (Vue's) resolves a batch with a `.vue` import itself, `.front` too.
        // The setter wraps ours over its wrapper again; inner copies of ours then see no `.front`.
        let current = wrapResolve(resolve);
        Object.defineProperty(host, 'resolveModuleNameLiterals', {
          configurable: true,
          enumerable: true,
          get: () => current,
          set: (next: Resolve) => {
            current = wrapResolve(next.bind(host));
          },
        });
      },
    };
  });

// Symbol.for: one key across module copies, so the extension's pack and a project's own install agree.
const SERVED = Symbol.for('multifront.typescript-plugin');
const MODULE_COPY = {};

/** A tsserver plugin with options a host sets; the default export takes none. */
export function createTypeScriptPlugin(options: TypeScriptPluginOptions = {}): ts.server.PluginModuleFactory {
  const volarPlugin = createVolarPlugin(options);
  return (modules) => {
    const volar = volarPlugin(modules);
    return {
      ...volar,
      // tsserver asks after every program it builds.
      getExternalFiles(project, updateLevel) {
        afterUpdates.get(project)?.();
        return volar.getExternalFiles?.(project, updateLevel) ?? [];
      },
      create(info) {
        // Owner is the module copy: a tsconfig reload calls `create` again but is not another copy.
        const project = info.project as ts.server.Project & {[SERVED]?: unknown};
        // First copy loaded serves; tsserver loads the project's own entry before global plugins.
        if (project[SERVED] && project[SERVED] !== MODULE_COPY) {
          info.project.projectService.logger.info(
            'multifront: another copy of the TypeScript plugin already serves this project; this one steps aside'
          );
          return info.languageService;
        }
        project[SERVED] = MODULE_COPY;
        const languageService = volar.create(info);
        return routers.get(info)?.(languageService) ?? languageService;
      },
    };
  };
}

/** tsserver plugin: serves `.front` files (hybrid mode) and resolves every `.front` import by spec 4.1 and 4.2. */
export default /* @__PURE__ */ createTypeScriptPlugin();
