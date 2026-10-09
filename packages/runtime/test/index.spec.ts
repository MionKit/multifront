import {describe, expect, it} from 'vitest';
import {scopeAttrs} from '@multifront/runtime';

describe('scopeAttrs', () => {
  it('keeps only the scope attributes', () => {
    expect(scopeAttrs({'data-v-1a2b': '', title: 'x', 'data-testid': 'card'})).toEqual({'data-v-1a2b': ''});
  });

  it('returns an empty object when there is none', () => {
    expect(scopeAttrs({})).toEqual({});
  });
});
