import type {DiagnosticCode} from '@multifront/core';

/** Hybrid mode: tsserver with our plugin reports these in `.ucf` files; the language server skips them. */
export const TSSERVER_CODES: ReadonlySet<DiagnosticCode> = new Set(['react-syntax-error', 'framework-in-block']);
