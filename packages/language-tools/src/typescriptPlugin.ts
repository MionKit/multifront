import {loadVueCompiler} from '@multifront/core';
import type {Target, VueCompiler} from '@multifront/core';
import {createLanguageServicePlugin} from '@volar/typescript/lib/quickstart/createLanguageServicePlugin.js';
import type * as ts from 'typescript';
import {createUcfLanguagePlugin} from './languagePlugin.ts';
import {entryOptions, resolveUcfImport} from './resolve.ts';
import {serveTargetScripts} from './targetScripts.ts';
import type {TypeScript, UcfImportOptions, UcfResolution, UcfVirtualCode} from './types.ts';

const isUcfSpecifier = (literal: ts.StringLiteralLike): boolean => literal.text.endsWith('.ucf');

function ucfLiterals(ts: TypeScript, sourceFile: ts.SourceFile): ts.StringLiteralLike[] {
  const literals: ts.StringLiteralLike[] = [];
  const visit = (node: ts.Node): void => {
    let specifier: ts.Node | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0];
    if (specifier && ts.isStringLiteralLike(specifier) && isUcfSpecifier(specifier)) literals.push(specifier);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return literals;
}

interface ImportError {
  diagnostic: ts.Diagnostic;
  node: ts.Node; // the import statement or `import()` call: TypeScript's own errors there are the same problem
}

function importErrors(ts: TypeScript, sourceFile: ts.SourceFile, options: UcfImportOptions): ImportError[] {
  const errors: ImportError[] = [];
  const report = (
    literal: ts.StringLiteralLike,
    {code, message, start = literal.getStart(sourceFile), end = literal.end}: NonNullable<UcfResolution['error']>,
    warning = false
  ): void => {
    const diagnostic: ts.Diagnostic = {
      file: sourceFile,
      start,
      length: end - start,
      category: warning ? ts.DiagnosticCategory.Warning : ts.DiagnosticCategory.Error,
      // Our string code, as the language server reports it; tsserver passes it on as is.
      code: code as unknown as number,
      source: 'multifront',
      messageText: message,
    };
    errors.push({diagnostic, node: literal.parent});
  };
  const targets = new Map<string, Target>();
  for (const literal of ucfLiterals(ts, sourceFile)) {
    const {target, error} = resolveUcfImport(ts, literal, sourceFile.fileName, options, sourceFile);
    if (error) report(literal, error);
    if (!target) continue;
    const first = targets.get(literal.text);
    if (!first) targets.set(literal.text, target);
    else if (first !== target) {
      // TypeScript keeps one resolution per (specifier, mode): the last import's wins for all (spike 1, answer 2).
      const message =
        `${literal.text} is imported as ${first} and as ${target} in this file; TypeScript keeps one resolution per ` +
        `specifier, so every import of it here gets the last one's types. Import each framework from its own small ` +
        `re-export file`;
      report(literal, {code: 'mixed-frameworks', message}, true);
    }
  }
  return errors;
}

/** `@vue/compiler-sfc` is optional: a React-only app has none. */
function projectCompiler(info: ts.server.PluginCreateInfo): VueCompiler | undefined {
  try {
    return loadVueCompiler(info.project.getCurrentDirectory());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    info.project.projectService.logger.info(`multifront: no Vue compiler, $style reads plain CSS modules only (${reason})`);
    return undefined;
  }
}

// Volar's proxy, wrapped once its callback ran: requests in a target's block go to that target's script.
const routers = new WeakMap<ts.server.PluginCreateInfo, (languageService: ts.LanguageService) => ts.LanguageService>();

const volarPlugin = createLanguageServicePlugin((ts, info) => {
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
  let getSplit: UcfImportOptions['getSplit'] = () => undefined;
  const importOptions = (compilerOptions: ts.CompilerOptions): UcfImportOptions => ({
    ...entryOptions(compilerOptions),
    compilerOptions,
    host: resolutionHost,
    getSplit,
  });

  // Wrapped before Volar's proxy, so Volar maps these positions into the `.ucf` file.
  const languageService = info.languageService;
  info.languageService = {
    ...languageService,
    getSemanticDiagnostics(fileName) {
      const diagnostics = languageService.getSemanticDiagnostics(fileName);
      const program = languageService.getProgram();
      const sourceFile = program?.getSourceFile(fileName);
      if (!program || !sourceFile) return diagnostics;
      const errors = importErrors(ts, sourceFile, importOptions(program.getCompilerOptions()));
      // "Cannot find module", "no default export": one problem, one error. A warning hides nothing.
      const covered = (start = -1) =>
        errors.some(
          ({diagnostic, node}) =>
            diagnostic.category === ts.DiagnosticCategory.Error && start >= node.getStart(sourceFile) && start < node.end
        );
      const kept = diagnostics.filter(({file, start}) => file !== sourceFile || !covered(start));
      return [...kept, ...errors.map(({diagnostic}) => diagnostic)];
    },
  };
  const targetScripts = serveTargetScripts(ts, info, info.languageService);
  routers.set(info, targetScripts.route);

  const compilerOptions = host.getCompilationSettings();
  return {
    languagePlugins: [createUcfLanguagePlugin({compiler: projectCompiler(info), ts, compilerOptions})],
    setup(language) {
      targetScripts.setup(language);
      getSplit = (fileName) => (language.scripts.get(fileName)?.generated?.root as UcfVirtualCode | undefined)?.split;
      // Volar has wrapped it already; ours runs first, so Volar never sees a `.ucf` specifier.
      const resolve = host.resolveModuleNameLiterals?.bind(host);
      if (!resolve) return;
      host.resolveModuleNameLiterals = (literals, containingFile, redirected, compilerOptions, sourceFile, reused) => {
        const others = literals.filter((literal) => !isUcfSpecifier(literal));
        if (others.length === literals.length) {
          return resolve(literals, containingFile, redirected, compilerOptions, sourceFile, reused);
        }
        const resolved =
          others.length > 0 ? resolve(others, containingFile, redirected, compilerOptions, sourceFile, reused) : [];
        const options = importOptions(compilerOptions);
        let next = 0;
        return literals.map((literal) =>
          isUcfSpecifier(literal) ? resolveUcfImport(ts, literal, containingFile, options, sourceFile) : resolved[next++]!
        );
      };
    },
  };
});

// Symbol.for: one key across module copies, so the extension's pack and a project's own install agree.
const SERVED = Symbol.for('multifront.typescript-plugin');

/** tsserver plugin: serves `.ucf` files (hybrid mode) and resolves every `.ucf` import by spec 4.1 and 4.2. */
const plugin: ts.server.PluginModuleFactory = (modules) => {
  const volar = volarPlugin(modules);
  return {
    ...volar,
    create(info) {
      // Owner is the module copy: a tsconfig reload calls `create` again but is not another copy.
      const project = info.project as ts.server.Project & {[SERVED]?: unknown};
      // First copy loaded serves; tsserver loads the project's own entry before global plugins.
      if (project[SERVED] && project[SERVED] !== plugin) {
        info.project.projectService.logger.info(
          'multifront: another copy of the TypeScript plugin already serves this project; this one steps aside'
        );
        return info.languageService;
      }
      project[SERVED] = plugin;
      const languageService = volar.create(info);
      return routers.get(info)?.(languageService) ?? languageService;
    },
  };
};

export default plugin;
