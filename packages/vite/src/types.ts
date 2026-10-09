import type {Target} from '@multifront/core';

export interface MultifrontOptions {
  /** The targets this build may compile. Defaults to every target. */
  targets?: Target[];
  /** The target a bare `import Card from './Card.uc'` resolves to. */
  target?: Target;
}

/** The part of @vue/compiler-sfc this package uses. */
export interface VueCompiler {
  compileStyleAsync: (...args: never[]) => Promise<unknown>;
  parse: (...args: never[]) => unknown;
}
