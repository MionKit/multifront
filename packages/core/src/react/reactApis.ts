/** The one file naming React APIs: a new React version edits only this one. */

export const REACT_MODULE = 'react';

// React warns on any Fragment prop but `key`, `ref` and `children`.
export const FRAGMENT = 'Fragment';

// Unwrapped, nested in any order, to reach the default-exported component.
export const WRAPPERS = ['memo', 'forwardRef'] as const;
