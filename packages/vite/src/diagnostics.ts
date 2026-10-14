import {findingOf} from '@multifront/core';
import type {Diagnostic, DiagnosticCode, Finding, Importer, SplitResult} from '@multifront/core';
import type {Rolldown} from 'vite';

export function describeDiagnostic({message, code}: Pick<Diagnostic, 'message' | 'code'>): string {
  return `${message} (${code})`;
}

/** An error on one `.ucf` import; no importer is a build entry. */
export function importErrorMessage(specifier: string, importerFile: string | undefined, message: string): string {
  return `${specifier} (imported by ${importerFile ?? 'a build entry'}): ${message}`;
}

/** For `this.error`: Rolldown keeps `meta`, where `mf-build` reads what to print. */
export function findingError(message: string, finding: Finding): Rolldown.RollupError {
  return {message, meta: {findings: [finding]}};
}

/** An error on a file, or on an import: on its importer and the block holding the import. */
export function importFinding(importer: Importer | undefined, code: DiagnosticCode, message: string): Finding {
  const block = importer?.block;
  return {...(importer && {file: importer.fileName}), code, severity: 'error', message, ...(block && {block})};
}

/** For `this.error`. */
export function rollupError(diagnostics: Diagnostic[], split: Pick<SplitResult, 'source' | 'blocks'>): Rolldown.RollupError {
  const [first, ...rest] = diagnostics;
  if (!first) return {message: 'multifront: no diagnostics'};
  const more = rest.map(
    (diagnostic) => `\n${diagnostic.filename}:${diagnostic.line}:${diagnostic.column} ${describeDiagnostic(diagnostic)}`
  );
  return {
    message: describeDiagnostic(first) + more.join(''),
    id: first.filename,
    loc: {file: first.filename, line: first.line, column: first.column},
    meta: {findings: diagnostics.map((diagnostic) => findingOf(diagnostic, split))},
  };
}
