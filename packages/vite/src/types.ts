import type {Target} from '@multifront/core';

export interface MultifrontOptions {
  /** The frameworks this build may compile. Defaults to every framework. */
  frameworks?: Target[];
  /** The framework a bare `import Card from './Card.ucf'` resolves to. */
  framework?: Target;
}

/** The part of @vue/compiler-sfc this package uses. */
export interface VueCompiler {
  compileStyleAsync: (...args: never[]) => Promise<unknown>;
  parse: (...args: never[]) => unknown;
}
