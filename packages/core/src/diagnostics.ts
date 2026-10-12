import {topLevelTags} from './scan.ts';
import type {Block, Diagnostic, DiagnosticCode, SplitResult} from './types.ts';

// Lines break on '\n' only, like Rollup's locator; columns are 0-based UTF-16 offsets.
export function locate(source: string, offset: number): Pick<Diagnostic, 'line' | 'column'> {
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

export function orList(items: readonly string[]): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}

export function styleInsideTarget(
  block: Block,
  split: SplitResult,
  nests: (name: string) => boolean,
  rawAtTop?: (name: string) => boolean
): Diagnostic[] {
  const message = `<style> cannot sit inside the <${block.type}> block; move it to the root of the file`;
  return topLevelTags(block.content, nests, rawAtTop)
    .filter((tag) => tag.name === 'style')
    .map((tag) =>
      createDiagnostic(split, 'style-inside-target', block.contentStart + tag.start, block.contentStart + tag.end, message)
    );
}

/** A file's errors, thrown by host functions such as `buildTarget`. */
export class DiagnosticsError extends Error {
  readonly diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics[0]?.message ?? 'no diagnostics');
    this.name = 'DiagnosticsError';
    this.diagnostics = diagnostics;
  }
}
