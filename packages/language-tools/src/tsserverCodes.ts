import type {DiagnosticCode} from '@multifront/core';

/** Hybrid mode: tsserver with our plugin reports these inside `.ucf` files, so the language server leaves them out. */
export const TSSERVER_CODES: ReadonlySet<DiagnosticCode> = new Set(['react-syntax-error', 'framework-in-block']);
