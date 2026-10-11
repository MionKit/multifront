import {vueSfcCode} from '@multifront/core';
import type {Block, SplitResult} from '@multifront/core';
import {forEachEmbeddedCode} from '@volar/language-core';
import type {LanguagePlugin, VirtualCode} from '@volar/language-core';
import {VueVirtualCode, createVueLanguagePlugin, getDefaultCompilerOptions} from '@vue/language-core';
import type * as ts from 'typescript';
import {stringSnapshot} from '../mappings.ts';
import type {
  EditorBlockKind,
  EditorContext,
  EditorFile,
  EditorOptions,
  TargetScript,
  TypeScript,
  VueRootFields,
} from '../types.ts';

const SERVICE_SCRIPT = /^script_(ts|tsx|js|jsx)$/;
const STYLE_CODE = /^style_\d+$/;
const SCRIPT_KINDS = {ts: 3, tsx: 4, js: 1, jsx: 2} as const satisfies Record<string, ts.ScriptKind>;
const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {};

const plugins = new WeakMap<ts.CompilerOptions, LanguagePlugin<string, VueVirtualCode>>();

function vuePlugin(typescript: TypeScript, compilerOptions: ts.CompilerOptions): LanguagePlugin<string, VueVirtualCode> {
  let plugin = plugins.get(compilerOptions);
  if (!plugin) {
    // Same strictness as the React target's `$style`: `$style.buton` is an error.
    const vueCompilerOptions = {...getDefaultCompilerOptions(), strictCssModules: true};
    plugin = createVueLanguagePlugin(typescript as typeof ts, compilerOptions, vueCompilerOptions, (id: string) => id);
    plugins.set(compilerOptions, plugin);
  }
  return plugin;
}

// Text the splitter read as no block (an unclosed block up to the next root tag, stray text) never reaches Vue.
function editorSfcCode(split: SplitResult): string {
  const code = vueSfcCode(split.source, split.blocks, split.filename).code;
  const blank = (start: number, end: number) => code.slice(start, end).replace(/[^\r\n]/g, ' ');
  let text = '';
  let pos = 0;
  for (const block of split.blocks) {
    text += blank(pos, block.start) + code.slice(block.start, block.end);
    pos = block.end;
  }
  return text + blank(pos, code.length);
}

// Ours serve the root `<style>` blocks; Vue's would share their ids, and the root keeps one code per id.
const withoutStyles = new WeakMap<VirtualCode[], VirtualCode[]>();

function stripStyles(codes: VirtualCode[]): VirtualCode[] {
  let kept = withoutStyles.get(codes);
  if (!kept) {
    kept = codes
      .filter(({id}) => !STYLE_CODE.test(id))
      .map((code) => (code.embeddedCodes?.length ? {...code, embeddedCodes: stripStyles(code.embeddedCodes)} : code));
    withoutStyles.set(codes, kept);
  }
  return kept;
}

const vueEmbeddedCodes = Object.getOwnPropertyDescriptor(VueVirtualCode.prototype, 'embeddedCodes')!.get!;

// Language-core keeps one code per file and updates it, so the getter goes on once.
function ownStylesOnly(code: VueVirtualCode): VueVirtualCode {
  if (!Object.hasOwn(code, 'embeddedCodes')) {
    Object.defineProperty(code, 'embeddedCodes', {get: () => stripStyles(vueEmbeddedCodes.call(code) as VirtualCode[])});
  }
  return code;
}

function vueCode({split, ts: typescript, compilerOptions = DEFAULT_COMPILER_OPTIONS}: EditorContext): VirtualCode | undefined {
  if (!typescript) return undefined;
  const snapshot = stringSnapshot(editorSfcCode(split));
  const code = vuePlugin(typescript, compilerOptions).createVirtualCode?.(split.filename, 'vue', snapshot, {
    getAssociatedScript: () => undefined,
  });
  return code && ownStylesOnly(code);
}

/** Language-core keeps every file's code in a module-wide registry until it is disposed. */
export function disposeVueCode(
  fileName: string,
  code: VirtualCode,
  {compilerOptions = DEFAULT_COMPILER_OPTIONS}: EditorOptions
): void {
  plugins.get(compilerOptions)?.disposeVirtualCode?.(fileName, code as VueVirtualCode);
}

const ROOT_FIELDS = ['fileName', 'ir', 'vueSfc', 'vueCompilerOptions'] as const satisfies (keyof VueRootFields)[];

/** Vue's service plugins read these from the root code, not from the code they serve (spike 2). */
export function forwardToVueCode(root: VirtualCode & VueRootFields, code: VirtualCode): void {
  for (const field of ROOT_FIELDS) {
    Object.defineProperty(root, field, {get: () => (code as VueVirtualCode)[field], enumerable: true});
  }
}

function serviceScript(code: VirtualCode): TargetScript | undefined {
  for (const child of forEachEmbeddedCode(code)) {
    const lang = SERVICE_SCRIPT.exec(child.id)?.[1] as keyof typeof SCRIPT_KINDS | undefined;
    if (lang) return {code: child, scriptKind: SCRIPT_KINDS[lang]};
  }
  return undefined;
}

function editor(_block: Block, ctx: EditorContext): VirtualCode[] {
  const code = vueCode(ctx);
  return code ? [code] : [];
}

// Its mappings are already in `.ucf` offsets: the SFC code has the same length.
function types(_block: Block, ctx: EditorContext): EditorFile | undefined {
  const code = vueCode(ctx);
  const script = code && serviceScript(code);
  if (!script) return undefined;
  const {snapshot, mappings} = script.code;
  return {ext: '.ts', code: snapshot.getText(0, snapshot.getLength()), map: undefined, mappings};
}

export const vueEditorKind: EditorBlockKind = {tag: 'vue', editor, types, serviceScript};
