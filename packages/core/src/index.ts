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
  Importer,
  ResolveTargetOptions,
  SourceMap,
  SplitResult,
  StyleModule,
  Target,
  TargetChoice,
  TargetErrorCode,
  TargetRule,
  UcfImport,
  VirtualFile,
  VueCompiler,
} from './types.ts';
export {BLOCK_KINDS, buildTarget, checkBlocks, getBlockKind} from './blocks/index.ts';
export {createBuildContext} from './context.ts';
export {DiagnosticsError, locate} from './diagnostics.ts';
export {classMapId, styleId} from './ids.ts';
export {
  DEFAULT_IMPORTERS,
  importPath,
  importerFromId,
  missingTargetBlockMessage,
  resolveTarget,
} from './imports/resolveTarget.ts';
export {rewriteImportAttributes} from './imports/rewrite.ts';
export {scopeId} from './scopeId.ts';
export {splitBlocks} from './split.ts';
export {compileStyles, moduleName, stylePreprocessOptions} from './styles.ts';
export {TARGETS, isTarget} from './targets.ts';
export {loadVueCompiler} from './vueCompiler.ts';
