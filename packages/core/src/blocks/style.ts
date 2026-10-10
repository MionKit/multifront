import {createDiagnostic} from '../diagnostics.ts';
import type {Block, BlockKind, Diagnostic, SplitResult} from '../types.ts';

const STYLE_LANGS: readonly string[] = ['css', 'scss', 'sass', 'less', 'styl', 'stylus', 'postcss'];
const LANG_LIST = `${STYLE_LANGS.slice(0, -1).join(', ')} or ${STYLE_LANGS.at(-1)}`;

// Vue's parser reads `module=""` as a bare `module`.
function moduleName(block: Block): string | undefined {
  const {module} = block.attrs;
  if (module === undefined) return undefined;
  return module === true || module === '' ? '$style' : module;
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
  return diagnostics;
}

export const styleKind: BlockKind = {tag: 'style', role: 'shared', check};
