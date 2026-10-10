import {describe, expect, it} from 'vitest';
import {BLOCK_KINDS, TARGETS, getBlockKind} from '@multifront/core';

describe('block kinds', () => {
  it('lists the shared kind first, then the targets in TARGETS order', () => {
    expect(BLOCK_KINDS.map((kind) => kind.tag)).toEqual(['style', ...TARGETS]);
    expect(BLOCK_KINDS.map((kind) => kind.role)).toEqual(['shared', 'target', 'target', 'target']);
  });

  it('finds each kind by its tag', () => {
    for (const kind of BLOCK_KINDS) expect(getBlockKind(kind.tag)).toBe(kind);
  });
});
