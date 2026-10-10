import ts from 'typescript';

/** Syntax errors the real TypeScript parser finds in `code` as a `.tsx` module. */
export function tsxSyntaxErrors(code: string): string[] {
  const file = ts.createSourceFile('Block.tsx', code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const host = ts.createCompilerHost({});
  host.getSourceFile = (name) => (name === file.fileName ? file : undefined);
  const program = ts.createProgram([file.fileName], {noLib: true, noResolve: true}, host);
  return program.getSyntacticDiagnostics(file).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}
