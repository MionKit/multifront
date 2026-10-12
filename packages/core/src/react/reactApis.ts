/** The one file naming React APIs: a new React version edits only this one. */

export const REACT_MODULE = 'react';

// React warns on any Fragment prop but `key`, `ref` and `children`.
export const FRAGMENT = 'Fragment';

// Unwrapped, nested in any order, to reach the default-exported component.
export const WRAPPERS = ['memo', 'forwardRef'] as const;

// Every root accepts and merges these (spec 3.5, item 5); `ref` is a prop since React 19.
export const ROOT_PROPS = ['className', 'style', 'ref'] as const;

// What makes a `<react>` block a Client Component (spec 8).
export const USE_CLIENT = 'use client';
// `use()` itself also runs in Server Components.
export const HOOK = /^use[A-Z]/;
export const CREATE_CONTEXT = 'createContext';
export const CLASS_COMPONENTS = ['Component', 'PureComponent'];
