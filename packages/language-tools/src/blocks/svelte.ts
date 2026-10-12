import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {renameSvelteStyles} from '@multifront/core';
import type {Block} from '@multifront/core';
import type {CodeMapping, VirtualCode} from '@volar/language-core';
import {svelte2tsx} from 'svelte2tsx';
import type * as ts from 'typescript';
import {stringSnapshot} from '../mappings.ts';
import {declareModule} from '../moduleTypes.ts';
import type {EditorBlockKind, EditorContext, EditorFile, TargetScript} from '../types.ts';

// svelte2tsx's global types; their `import('svelte')` needs no install beside them: Svelte's types declare it globally.
const SHIMS = ['svelte-shims-v4.d.ts', 'svelte-jsx-v4.d.ts'];

let installedTypesRoot: string | undefined;

type SvelteTypes = Pick<EditorFile, 'code' | 'mappings'> & Pick<ReturnType<typeof renameSvelteStyles>, 'lang'>;

// svelte2tsx's script, then `declare const __ucfStyle: {readonly card: string};` per class map the block uses.
function svelteTypes(block: Block, ctx: EditorContext): SvelteTypes | undefined {
  const compiler = ctx.svelteCompiler;
  if (!compiler) return undefined;
  const {code: svelte, locals, lang} = renameSvelteStyles(block, ctx.split, compiler, ctx.modules);
  let script: string;
  try {
    script = svelte2tsx(svelte, {
      filename: `${ctx.split.filename}.svelte.svelte`, // the build's id (spec 4.3)
      isTsFile: lang === 'ts',
      mode: 'ts',
      parse: compiler.parse,
      version: compiler.VERSION,
      emitOnTemplateError: true,
    }).code;
  } catch (err) {
    // Markup even Svelte's loose parser cannot read (a CompileError): no script until it parses. Else a crash.
    const {code, position} = (err ?? {}) as {code?: unknown; position?: unknown};
    if (typeof code !== 'string' || !position) throw err;
    return undefined;
  }
  // Resolved only when needed: the VS Code bundle passes its copy and ships no svelte2tsx folder.
  const root =
    ctx.svelteTypesRoot ?? (installedTypesRoot ??= dirname(createRequire(import.meta.url).resolve('svelte2tsx/package.json')));
  const mappings: CodeMapping[] = [];
  let code = SHIMS.map((name) => `/// <reference path="${join(root, name).replaceAll('\\', '/')}" />\n`).join('') + script;
  for (const [module, local] of locals) code = declareModule(code, local, module.classes, mappings);
  return {code, mappings, lang};
}

function types(block: Block, ctx: EditorContext): EditorFile | undefined {
  const script = svelteTypes(block, ctx);
  return script && {ext: '.ts', code: script.code, map: undefined, mappings: script.mappings};
}

function editor(block: Block, ctx: EditorContext): VirtualCode[] {
  const script = svelteTypes(block, ctx);
  if (!script) return [];
  const languageId = script.lang === 'ts' ? 'typescript' : 'javascript';
  return [{id: 'svelte', languageId, snapshot: stringSnapshot(script.code), mappings: script.mappings}];
}

function serviceScript(code: VirtualCode): TargetScript {
  const scriptKind = code.languageId === 'typescript' ? (3 satisfies ts.ScriptKind.TS) : (1 satisfies ts.ScriptKind.JS);
  return {code, scriptKind};
}

export const svelteEditorKind: EditorBlockKind = {tag: 'svelte', types, editor, serviceScript};
