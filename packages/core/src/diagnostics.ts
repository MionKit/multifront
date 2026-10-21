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

// Vue's grammar colors a root tag's content by its `lang`, so GitHub and Shiki color the block in its own language.
export function blockLang(block: Block, split: SplitResult, lang: string | undefined): Diagnostic[] {
  const written = block.attrs.lang;
  if (lang === undefined || written === lang) return [];
  const tag =
    written === undefined ? `<${block.type}>` : written === true ? `<${block.type} lang>` : `<${block.type} lang="${written}">`;
  const message = `${tag} needs lang="${lang}"; write <${block.type} lang="${lang}">`;
  return [createDiagnostic(split, 'block-lang', block.start, block.contentStart, message)];
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
