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
// compiler-sfc's own `parseCssVars` comment rule, so we flag exactly the v-binds Vue sets.
const COMMENT = /\/\*[\s\S]*?\*\/|\/\/.*/g;
// The shadow DOM `::slotted()` is plain CSS; Vue rewrites `:slotted()` only in scoped styles.
const VUE_ONLY = /v-bind\s*\(|(?<!:):slotted\(|::v-slotted\(/g;

/** `v-bind()` and `:slotted()` spots: Vue sets them up at runtime, React and Svelte would silently drop them. */
function vueOnlyStyle(block: Block, split: SplitResult): Diagnostic[] {
  const others = (['react', 'svelte'] as const).filter((target) => split.targets[target]).map((target) => `<${target}>`);
  if (others.length === 0) return [];
  const otherTags = orList(others);
  const content = block.content.replace(COMMENT, (comment) => comment.replace(/[^\n]/g, ' '));
  return [...content.matchAll(VUE_ONLY)].flatMap((match) => {
    const vBind = match[0].startsWith('v-bind');
    if (!vBind && !('scoped' in block.attrs)) return [];
    const message = vBind
      ? `v-bind() in <style> works in <vue> only, not in ${otherTags}; set a CSS variable through the style prop instead`
      : `:slotted() in <style scoped> works in <vue> only, not in ${otherTags}; use :deep() or style the content from the parent`;
    const start = block.contentStart + match.index;
    return [createDiagnostic(split, 'vue-only-style', start, start + match[0].length, message)];
  });
}

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
  return [...diagnostics, ...vueOnlyStyle(block, split)];
}

async function fillContext(blocks: Block[], ctx: BuildContext): Promise<void> {
  const {scopeId: id, filename, source, compiler, production} = ctx;
  ctx.styles = await compileStyles(blocks, {id, filename, source, compiler, production});
  ctx.hasScoped = ctx.styles.some((style) => style.scoped);
  for (const {module: name, index, classes} of ctx.styles) {
    if (name === undefined) continue;
    // Later same-name block wins, as in plugin-vue; a failed block keeps `{}` so `$style` still resolves.
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
