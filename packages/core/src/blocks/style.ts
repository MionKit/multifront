import {createDiagnostic, orList} from '../diagnostics.ts';
import {classMapId} from '../ids.ts';
import {compileStyles, moduleName} from '../styles.ts';
import type {Block, BlockKind, BuildContext, Diagnostic, GrammarScope, SplitResult, VirtualFile} from '../types.ts';

// The one list of style langs; `css` falls to the default grammar.
const BY_LANG: Record<string, GrammarScope> = {
  scss: {scopeName: 'source.css.scss', languageId: 'scss'},
  sass: {scopeName: 'source.sass', languageId: 'sass'},
  less: {scopeName: 'source.css.less', languageId: 'less'},
  styl: {scopeName: 'source.stylus', languageId: 'stylus'},
  stylus: {scopeName: 'source.stylus', languageId: 'stylus'},
  postcss: {scopeName: 'source.css.postcss', languageId: 'postcss'},
};
const STYLE_LANGS: readonly string[] = ['css', ...Object.keys(BY_LANG)];
const LANG_LIST = orList(STYLE_LANGS);

function check(block: Block, split: SplitResult): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const {lang} = block.attrs;
  if (lang !== undefined && (lang === true || !STYLE_LANGS.includes(lang))) {
    const message = `<style ${lang === true ? 'lang' : `lang="${lang}"`}> is not a known style language; use ${LANG_LIST}`;
    diagnostics.push(createDiagnostic(split, 'unknown-style-lang', block.start, block.contentStart, message));
  }
  const name = moduleName(block);
  if (name !== undefined && split.styles.slice(0, block.index).some((earlier) => moduleName(earlier) === name)) {
    const message = `<style module> injects ${name} more than once; give each module its own name`;
    diagnostics.push(createDiagnostic(split, 'duplicate-style-module', block.start, block.contentStart, message));
  }
  return diagnostics;
}

async function fillContext(blocks: Block[], ctx: BuildContext): Promise<void> {
  const {scopeId: id, filename, source, compiler, production} = ctx;
  ctx.styles = await compileStyles(blocks, {id, filename, source, compiler, production});
  ctx.hasScoped = ctx.styles.some((style) => style.scoped);
  for (const {module: name, index, classes} of ctx.styles) {
    if (name === undefined) continue;
    // A later block with the same name wins, as in plugin-vue. A block that failed keeps `{}`, so `$style` resolves.
    ctx.modules[name] = {name, index, id: classMapId(filename, index), classes: classes ?? {}};
  }
}

function build(block: Block, ctx: BuildContext): VirtualFile {
  const {code, map} = ctx.styles[block.index]!;
  return {ext: '.css', code, map};
}

export const styleKind: BlockKind = {
  tag: 'style',
  role: 'shared',
  grammar: {scopeName: 'source.css', languageId: 'css', byLang: BY_LANG},
  check,
  fillContext,
  build,
};
