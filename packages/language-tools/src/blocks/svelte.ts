import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {svelteEditorSource} from '@multifront/core';
import type {Block} from '@multifront/core';
import type {CodeInformation, CodeMapping, VirtualCode} from '@volar/language-core';
import {svelte2tsx} from 'svelte2tsx';
import type * as ts from 'typescript';
import {declareModule} from '../moduleTypes.ts';
import {composeMappings, sourceMapMappings, stringSnapshot} from '../mappings.ts';
import {SVELTE_MARKUP_LANGUAGE, isComponent, scanMarkup} from '../svelteMarkup.ts';
import type {EditorBlockKind, EditorContext, EditorFile, TargetScript} from '../types.ts';

// svelte2tsx's global types; their `import('svelte')` needs no install beside them: Svelte's types declare it globally.
const SHIMS = ['svelte-shims-v4.d.ts', 'svelte-jsx-v4.d.ts'];

// TypeScript features only: `mf-fmt` formats the block, and generated wrappers have no outline of the user's.
const SVELTE_FEATURES: CodeInformation = {verification: true, completion: true, semantic: true, navigation: true};
// Completion only: no HTML diagnostics, formatting, hover or links in Svelte markup.
const MARKUP_FEATURES: CodeInformation = {completion: true};
const PROPS_OBJECT = 'props: {';

let installedTypesRoot: string | undefined;

type SvelteTypes = Pick<EditorFile, 'code' | 'mappings'> & Pick<ReturnType<typeof svelteEditorSource>, 'lang'>;

// A renamed use ends the gap between two mapped runs: its local in the renamed code, its `$name` in the `.ucf` file.
function renamedUses(mappings: CodeMapping[], source: string, renamed: string, locals: Set<string>): CodeMapping[] {
  const uses: CodeMapping[] = [];
  for (const [index, before] of mappings.entries()) {
    const after = mappings[index + 1];
    if (!after) break;
    const sourceEnd = before.sourceOffsets[0]! + before.lengths[0]!;
    // An attribute shorthand's gap also holds its added `$name={`.
    const [local] =
      /[\w$]+$/.exec(renamed.slice(before.generatedOffsets[0]! + before.lengths[0]!, after.generatedOffsets[0])) ?? [];
    if (!local || !locals.has(local)) continue;
    const gap = source.slice(sourceEnd, after.sourceOffsets[0]);
    // An object shorthand's `$name` stays as its key (`{$style: __ucfStyle}`), mapped 1:1: the value takes it over.
    const [name] = /\$[\w$]+$/.exec(gap || source.slice(before.sourceOffsets[0], sourceEnd)) ?? [];
    if (!name) continue;
    if (!gap) before.lengths[0]! -= name.length;
    uses.push({
      sourceOffsets: [after.sourceOffsets[0]! - name.length],
      generatedOffsets: [after.generatedOffsets[0]! - local.length],
      lengths: [name.length],
      generatedLengths: [local.length],
      data: SVELTE_FEATURES,
    });
  }
  return uses;
}

// Component start-tag whitespace onto svelte2tsx's props object, so `<Icon |` completes Icon's props.
// A gap's first character stays with the name or attribute before it.
function propsMappings(block: Block, code: string, mappings: CodeMapping[]): CodeMapping[] {
  const found: CodeMapping[] = [];
  for (const {name, start, gaps} of scanMarkup(block.content).tags) {
    if (!isComponent(name) || gaps.length === 0) continue;
    const nameAt = block.contentStart + start + 1;
    const named = mappings.find(
      ({sourceOffsets, lengths, generatedLengths}) =>
        !generatedLengths && sourceOffsets[0]! <= nameAt && nameAt < sourceOffsets[0]! + lengths[0]!
    );
    if (!named) continue;
    const generatedName = named.generatedOffsets[0]! + nameAt - named.sourceOffsets[0]!;
    // svelte2tsx writes the props object right after the name: `ensureComponent(Icon); new $$_C({…, props: {`.
    const props = code.indexOf(PROPS_OBJECT, generatedName);
    if (props === -1) continue;
    for (const gap of gaps) {
      found.push({
        sourceOffsets: [block.contentStart + gap.start + 1],
        generatedOffsets: [props + PROPS_OBJECT.length],
        lengths: [gap.end - gap.start - 1],
        generatedLengths: [0],
        data: MARKUP_FEATURES,
      });
    }
  }
  return found;
}

// svelte2tsx's script, then `declare const __ucfStyle: {readonly card: string};` per class map the block uses.
export function svelteTypes(block: Block, ctx: EditorContext): SvelteTypes | undefined {
  const compiler = ctx.svelteCompiler;
  if (!compiler) return undefined;
  const {code: svelte, locals, lang, mappings: renameMappings} = svelteEditorSource(block, ctx.split, compiler, ctx.modules);
  let script: ReturnType<typeof svelte2tsx>;
  try {
    script = svelte2tsx(svelte, {
      filename: `${ctx.split.filename}.svelte.svelte`, // the build's id (spec 4.3)
      isTsFile: lang === 'ts',
      mode: 'ts',
      parse: compiler.parse,
      version: compiler.VERSION,
      emitOnTemplateError: true,
    });
  } catch (err) {
    // Markup even Svelte's loose parser cannot read (a CompileError): no script until it parses. Else a crash.
    const {code, position} = (err ?? {}) as {code?: unknown; position?: unknown};
    if (typeof code !== 'string' || !position) throw err;
    return undefined;
  }
  // Resolved only when needed: the VS Code bundle passes its copy and ships no svelte2tsx folder.
  const root =
    ctx.svelteTypesRoot ?? (installedTypesRoot ??= dirname(createRequire(import.meta.url).resolve('svelte2tsx/package.json')));
  const prefix = SHIMS.map((name) => `/// <reference path="${join(root, name).replaceAll('\\', '/')}" />\n`).join('');
  // svelte2tsx reads the renamed block: its map ends there, the rename's goes on into the `.ucf` file.
  const outer = sourceMapMappings(script.map, svelte, script.code, SVELTE_FEATURES).map((mapping) => ({
    ...mapping,
    generatedOffsets: [prefix.length + mapping.generatedOffsets[0]!],
  }));
  // The rename's only mismatches are the renamed uses, mapped whole below: its points go.
  const exact = sourceMapMappings({mappings: renameMappings}, ctx.split.source, svelte, SVELTE_FEATURES).filter(
    ({lengths}) => lengths[0] !== 0
  );
  const uses = renamedUses(exact, ctx.split.source, svelte, new Set(locals.values()));
  // A run an object shorthand's value took over entirely is gone.
  const inner = [...exact.filter(({lengths}) => lengths[0] !== 0), ...uses];
  const mappings = composeMappings(outer, inner);
  let code = prefix + script.code;
  for (const [module, local] of locals) code = declareModule(code, local, module.classes, mappings);
  mappings.push(...propsMappings(block, code, mappings));
  return {code, mappings, lang};
}

function types(block: Block, ctx: EditorContext): EditorFile | undefined {
  const script = svelteTypes(block, ctx);
  return script && {ext: '.ts', code: script.code, map: undefined, mappings: script.mappings};
}

// For the HTML service; `{…}` maps nowhere: expressions are TypeScript's.
function markupCode(block: Block): VirtualCode {
  const {code, pieces} = scanMarkup(block.content);
  const mappings = pieces.map(({start, end}) => ({
    sourceOffsets: [block.contentStart + start],
    generatedOffsets: [start],
    lengths: [end - start],
    data: MARKUP_FEATURES,
  }));
  return {id: 'svelte_markup', languageId: SVELTE_MARKUP_LANGUAGE, snapshot: stringSnapshot(code), mappings};
}

// No compiler (the language server): only the markup code.
function editor(block: Block, ctx: EditorContext): VirtualCode[] {
  const script = svelteTypes(block, ctx);
  if (!script) {
    // Unparsable markup: importers keep the last script's types; its offsets are stale, so nothing maps.
    const last = ctx.previous?.embeddedCodes?.find(({id}) => id === 'svelte');
    return last ? [{...last, mappings: []}, markupCode(block)] : [markupCode(block)];
  }
  const languageId = script.lang === 'ts' ? 'typescript' : 'javascript';
  return [{id: 'svelte', languageId, snapshot: stringSnapshot(script.code), mappings: script.mappings}, markupCode(block)];
}

function serviceScript(code: VirtualCode): TargetScript {
  const scriptKind = code.languageId === 'typescript' ? (3 satisfies ts.ScriptKind.TS) : (1 satisfies ts.ScriptKind.JS);
  return {code, scriptKind};
}

export const svelteEditorKind: EditorBlockKind = {tag: 'svelte', types, editor, serviceScript};
