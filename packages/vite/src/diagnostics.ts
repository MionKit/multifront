import type {Diagnostic} from '@multifront/core';
import type {Rolldown} from 'vite';

export function describeDiagnostic({message, code}: Pick<Diagnostic, 'message' | 'code'>): string {
  return `${message} (${code})`;
}

/** For `this.error`. */
export function rollupError(diagnostics: Diagnostic[]): Rolldown.RollupError {
  const [first, ...rest] = diagnostics;
  if (!first) return {message: 'multifront: no diagnostics'};
  const more = rest.map(
    (diagnostic) => `\n${diagnostic.filename}:${diagnostic.line}:${diagnostic.column} ${describeDiagnostic(diagnostic)}`
  );
  return {
    message: describeDiagnostic(first) + more.join(''),
    id: first.filename,
    loc: {file: first.filename, line: first.line, column: first.column},
  };
}
