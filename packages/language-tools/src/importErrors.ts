import type {Target} from '@multifront/core';
import type * as ts from 'typescript';
import {resolveUcfImport} from './resolve.ts';
import type {TypeScript, UcfImportOptions, UcfResolution} from './types.ts';

export const isUcfSpecifier = (literal: ts.StringLiteralLike): boolean => literal.text.endsWith('.ucf');

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

/** Our errors at each `.ucf` import of `sourceFile`, as the build reports them, in place of TypeScript's own there. */
export function withImportErrors(
  ts: TypeScript,
  sourceFile: ts.SourceFile,
  diagnostics: readonly ts.Diagnostic[],
  options: UcfImportOptions
): ts.Diagnostic[] {
  const errors = importErrors(ts, sourceFile, options);
  // "Cannot find module", "no default export": one problem, one error. A warning hides nothing.
  const covered = (start = -1) =>
    errors.some(
      ({diagnostic, node}) =>
        diagnostic.category === ts.DiagnosticCategory.Error && start >= node.getStart(sourceFile) && start < node.end
    );
  const kept = diagnostics.filter(({file, start}) => file !== sourceFile || !covered(start));
  return [...kept, ...errors.map(({diagnostic}) => diagnostic)];
}
