import {describe, expect, it} from 'vitest';
import {TARGETS, isTarget} from '@multifront/core';

describe('targets', () => {
  it('lists the three frameworks', () => {
    expect(TARGETS).toEqual(['vue', 'react', 'svelte']);
  });

  it('recognises a target name and rejects anything else', () => {
    expect(isTarget('react')).toBe(true);
    expect(isTarget('angular')).toBe(false);
  });
});
