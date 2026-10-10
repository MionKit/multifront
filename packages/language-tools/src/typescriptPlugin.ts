import {createLanguageServicePlugin} from '@volar/typescript/lib/quickstart/createLanguageServicePlugin.js';
import type * as ts from 'typescript';
import {createUcfLanguagePlugin} from './languagePlugin.ts';
import {entryOptions, resolveUcfImport} from './resolve.ts';
import type {TypeScript, UcfImportOptions, UcfVirtualCode} from './types.ts';

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
  for (const literal of ucfLiterals(ts, sourceFile)) {
    const {error} = resolveUcfImport(ts, literal, sourceFile.fileName, options);
    if (!error) continue;
    const diagnostic: ts.Diagnostic = {
      file: sourceFile,
      start: literal.getStart(sourceFile),
      length: literal.getWidth(sourceFile),
      category: ts.DiagnosticCategory.Error,
      // Our string code, as the language server reports it; tsserver passes it on as is.
      code: error.code as unknown as number,
      source: 'multifront',
      messageText: error.message,
    };
    errors.push({diagnostic, node: literal.parent});
  }
  return errors;
}

/** tsserver plugin: serves `.ucf` files (hybrid mode) and resolves every `.ucf` import by spec 4.1 and 4.2. */
export default createLanguageServicePlugin((ts, info) => {
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
      // "Cannot find module", "no default export": one problem, one error.
      const covered = (start = -1) => errors.some(({node}) => start >= node.getStart(sourceFile) && start < node.end);
      const kept = diagnostics.filter(({file, start}) => file !== sourceFile || !covered(start));
      return [...kept, ...errors.map(({diagnostic}) => diagnostic)];
    },
  };

  return {
    languagePlugins: [createUcfLanguagePlugin()],
    setup(language) {
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
          isUcfSpecifier(literal) ? resolveUcfImport(ts, literal, containingFile, options) : resolved[next++]!
        );
      };
    },
  };
});
