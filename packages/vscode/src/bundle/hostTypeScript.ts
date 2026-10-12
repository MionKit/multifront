// svelte2tsx imports `typescript`, which the pack does not ship: the bundle points that import here, at the copy
// tsserver hands our plugin (`typescriptPlugin.ts` stores it). The language server never runs svelte2tsx.
import type * as ts from 'typescript';

export const HOST_TYPESCRIPT = Symbol.for('multifront.host-typescript');

const host = (): typeof ts | undefined => (globalThis as {[HOST_TYPESCRIPT]?: typeof ts})[HOST_TYPESCRIPT];

export default new Proxy({} as typeof ts, {get: (_target, key) => host()?.[key as keyof typeof ts]});
