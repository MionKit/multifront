import type {Target} from '@multifront/core';

export interface MultifrontOptions {
  /** Frameworks this build may compile; defaults to all. */
  frameworks?: Target[];
  /** The framework a bare `import Card from './Card.ucf'` resolves to. */
  framework?: Target;
}
