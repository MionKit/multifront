import type {Target} from './types.ts';

export type {Block, BlockKind, BlockRole, BlockTag, Diagnostic, DiagnosticCode, SplitResult, Target} from './types.ts';
export {BLOCK_KINDS, getBlockKind} from './blocks/index.ts';
export {checkBlocks} from './check.ts';
export {splitBlocks} from './split.ts';

/** Every target, in the order a library build emits them. */
export const TARGETS: readonly Target[] = ['vue', 'react', 'svelte'];

export function isTarget(value: string): value is Target {
  return (TARGETS as readonly string[]).includes(value);
}
