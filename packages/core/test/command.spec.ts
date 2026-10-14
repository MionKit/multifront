import {describe, expect, it} from 'vitest';
import {checkBlocks, findingOf, splitBlocks} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {listComponents, readComponent} from '../../e2e/fixtures/index.ts';

// From the text alone, not through `locate`: 1-based line and column back to an offset.
function offsetOf(source: string, line: number, column: number): number {
  const lines = source.split('\n');
  return lines.slice(0, line - 1).reduce((offset, text) => offset + text.length + 1, 0) + column - 1;
}

describe('findingOf', () => {
  const fixtures = listComponents('invalid').map((name) => {
    const {filename, source} = readComponent(name);
    const split = splitBlocks(source, filename);
    return {name, split, diagnostics: [...split.errors, ...checkBlocks(split)]};
  });

  it('has invalid fixtures with diagnostics to check', () => {
    expect(fixtures.flatMap(({diagnostics}) => diagnostics).length).toBeGreaterThan(fixtures.length);
  });

  it.each(fixtures)(
    'points every diagnostic of $name at its own text, 1-based, in the block holding it',
    ({split, diagnostics}) => {
      for (const diagnostic of diagnostics) {
        const finding = findingOf(diagnostic, split);
        const {line, column, end} = finding;
        expect(offsetOf(split.source, line!, column!), diagnostic.message).toBe(diagnostic.start);
        expect(offsetOf(split.source, end!.line, end!.column), diagnostic.message).toBe(diagnostic.end);
        const holder = split.blocks.find((block) => block.start <= diagnostic.start && diagnostic.start < block.end);
        expect(finding).toEqual({
          file: diagnostic.filename,
          line: diagnostic.line,
          column: diagnostic.column + 1,
          end,
          code: diagnostic.code,
          severity: diagnostic.severity,
          message: diagnostic.message,
          ...(holder && {block: holder.type}),
        });
      }
    }
  );
});
