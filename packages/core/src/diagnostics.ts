import type {Diagnostic, DiagnosticCode, SplitResult} from './types.ts';

// Lines break on '\n' only, like Rollup's locator; columns are 0-based UTF-16 offsets.
function locate(source: string, offset: number): Pick<Diagnostic, 'line' | 'column'> {
  const lines = source.slice(0, offset).split('\n');
  return {line: lines.length, column: lines.at(-1)!.length};
}

/** `start` and `end` are offsets into the whole `.ucf` source. */
export function createDiagnostic(
  file: Pick<SplitResult, 'filename' | 'source'>,
  code: DiagnosticCode,
  start: number,
  end: number,
  message: string
): Diagnostic {
  return {code, severity: 'error', message, filename: file.filename, start, end, ...locate(file.source, start)};
}
