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
  SvelteCompiler,
  Target,
  TargetChoice,
  TargetErrorCode,
  TargetRule,
  UcfImport,
  VirtualFile,
  VueCompiler,
} from './types.ts';
export {BLOCK_KINDS, buildTarget, checkBlocks, getBlockKind} from './blocks/index.ts';
export {renameSvelteStyles} from './blocks/svelte.ts';
export {vueSfcCode} from './blocks/vue.ts';
export {loadSvelteCompiler, loadVueCompiler} from './compilers.ts';
export {createBuildContext} from './context.ts';
export {DiagnosticsError, locate} from './diagnostics.ts';
export {classMapId, styleId} from './ids.ts';
export {DEFAULT_IMPORTERS, importerFromId, missingTargetBlockMessage, resolveTarget} from './imports/resolveTarget.ts';
export {rewriteImportAttributes} from './imports/rewrite.ts';
export {SCOPE_HELPER_ID, scopeHelperCode} from './react/scopeHelper.ts';
export {needsUseClient} from './react/useClient.ts';
export {rootRelativePath, scopeId} from './scopeId.ts';
export {splitBlocks} from './split.ts';
export {compileStyles, moduleClassName, moduleName, stylePreprocessOptions} from './styles.ts';
export {TARGETS, isTarget} from './targets.ts';
