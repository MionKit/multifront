export type {
  Block,
  BlockGrammar,
  BlockKind,
  BlockRole,
  BlockTag,
  BuildContext,
  BuildContextOptions,
  CompiledStyle,
  Diagnostic,
  DiagnosticCode,
  GrammarScope,
  SourceMap,
  SplitResult,
  StyleModule,
  Target,
  VirtualFile,
  VueCompiler,
} from './types.ts';
export {BLOCK_KINDS, checkBlocks, getBlockKind} from './blocks/index.ts';
export {createBuildContext} from './context.ts';
export {classMapId, styleId} from './ids.ts';
export {scopeId} from './scopeId.ts';
export {splitBlocks} from './split.ts';
export {compileStyles, moduleName, stylePreprocessOptions} from './styles.ts';
export {TARGETS, isTarget} from './targets.ts';
export {loadVueCompiler} from './vueCompiler.ts';
