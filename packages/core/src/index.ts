import type {Target} from './types.ts';

export type {
  Block,
  BlockGrammar,
  BlockKind,
  BlockRole,
  BlockTag,
  CompiledStyle,
  Diagnostic,
  DiagnosticCode,
  GrammarScope,
  SourceMap,
  SplitResult,
  Target,
  VueCompiler,
} from './types.ts';
export {BLOCK_KINDS, checkBlocks, getBlockKind} from './blocks/index.ts';
export {styleId} from './ids.ts';
export {scopeId} from './scopeId.ts';
export {splitBlocks} from './split.ts';
export {compileStyles} from './styles.ts';

/** Every target, in the order a library build emits them. */
export const TARGETS: readonly Target[] = ['vue', 'react', 'svelte'];

export function isTarget(value: string): value is Target {
  return (TARGETS as readonly string[]).includes(value);
}
