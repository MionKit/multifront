import MagicString from 'magic-string';
import {parseSync} from 'oxc-parser';
import {createDiagnostic, styleInsideTarget} from '../diagnostics.ts';
import {frameworkInBlockMessage} from '../imports/resolveTarget.ts';
import {frameworkAttributes, langOf} from '../imports/rewrite.ts';
import {findClosingTag, topLevelTags} from '../scan.ts';
import {isTarget} from '../targets.ts';
import type {Block, BlockKind, Diagnostic, SourceMap, SplitResult} from '../types.ts';

// Like Vue's SFC parser: every root tag but `<template>` is raw text; a `<style>` inside `<template>` is markup.
const nests = (name: string): boolean => name === 'template';
const rawAtTop = (name: string): boolean => name !== 'template';

// Spec 4.1, like `react.check`: plugin-vue inlines some scripts into the bare `.ucf` module, which no post rewrite sees.
function attributesInScripts(block: Block, split: SplitResult, tags: ReturnType<typeof topLevelTags>): Diagnostic[] {
  return tags
    .filter(({name}) => name === 'script')
    .flatMap(({attrs, end}) => {
      const content = block.content.slice(end, findClosingTag(block.content, 'script', end)?.start);
      if (!content.includes('.ucf')) return [];
      const lang = langOf(`?lang.${attrs.lang ?? 'js'}`);
      const {program, errors} = parseSync(split.filename, content, {lang, sourceType: 'module'});
      // compiler-sfc reports the syntax error.
      if (errors.length > 0) return [];
      const offset = block.contentStart + end;
      return frameworkAttributes(program).map(({start, end: spanEnd}) =>
        createDiagnostic(split, 'framework-in-block', offset + start, offset + spanEnd, frameworkInBlockMessage('vue'))
      );
    });
}

// The same raw scan as the splitter: compiler-sfc's own "at least one <template> or <script>" error, without it.
function check(block: Block, split: SplitResult): Diagnostic[] {
  const tags = topLevelTags(block.content, nests, rawAtTop);
  const diagnostics = [...styleInsideTarget(block, split, nests, rawAtTop), ...attributesInScripts(block, split, tags)];
  if (tags.some(({name}) => name === 'template' || name === 'script')) return diagnostics;
  const message = '<vue> has no <template> or <script>; add one';
  return [createDiagnostic(split, 'vue-empty-block', block.start, block.contentStart, message), ...diagnostics];
}

export const vueKind: BlockKind = {
  tag: 'vue',
  role: 'target',
  grammar: {scopeName: 'text.html.vue', languageId: 'vue'}, // the official Vue extension's scope name
  check,
  build: (_block, ctx) => ({ext: '.vue', ...vueSfcCode(ctx.source, ctx.split.blocks, ctx.filename)}),
};

// Line breaks stay original characters, so lines and columns (CRLF included) match the .ucf file.
function blank(text: MagicString, source: string, start: number, end: number): void {
  for (const run of source.slice(start, end).matchAll(/[^\r\n]+/g)) {
    const runStart = start + run.index;
    text.overwrite(runStart, runStart + run[0].length, ' '.repeat(run[0].length));
  }
}

/** SFC code as long as the `.ucf` source: `<vue>` content and root `<style>` blocks kept, other targets blanked. */
export function vueSfcCode(source: string, blocks: Block[], filename: string): {code: string; map: SourceMap} {
  const text = new MagicString(source);
  const vue = blocks.find((block) => block.type === 'vue');
  for (const block of blocks) {
    if (block === vue) {
      blank(text, source, block.start, block.contentStart);
      blank(text, source, block.contentEnd, block.end);
    } else if (isTarget(block.type)) blank(text, source, block.start, block.end);
  }
  const {sources, sourcesContent, names, mappings} = text.generateMap({source: filename, hires: true, includeContent: true});
  return {code: text.toString(), map: {version: 3, sources, sourcesContent, names, mappings}};
}
