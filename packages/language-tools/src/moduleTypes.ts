import type {CodeMapping} from '@volar/language-core';
import type {StyleClass} from './types.ts';

export const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
// An unreadable module (a style mid-edit) must not turn every `$style.x` red; its own service reports the error.
const LOOSE_MODULE = '{readonly [name: string]: string}';

/** `code` plus `declare const <name>: {readonly card: string};`, each written key jumping to its class name. */
export function declareModule(code: string, name: string, classes: StyleClass[] | undefined, mappings: CodeMapping[]): string {
  let text = code.endsWith('\n') ? code : `${code}\n`;
  text += `declare const ${name}: `;
  text += classes ? moduleType(classes, text.length, mappings) : LOOSE_MODULE;
  return `${text};\n`;
}

function moduleType(classes: StyleClass[], start: number, mappings: CodeMapping[]): string {
  let text = '{';
  for (const [i, {name, offset}] of classes.entries()) {
    const key = IDENTIFIER.test(name) ? name : JSON.stringify(name);
    text += `${i > 0 ? '; ' : ''}readonly `;
    // Only plain CSS names get an offset, so a quoted key is the name plus its two quotes.
    if (offset !== undefined) {
      const keyStart = start + text.length + (key === name ? 0 : 1);
      mappings.push({sourceOffsets: [offset], generatedOffsets: [keyStart], lengths: [name.length], data: {navigation: true}});
    }
    text += `${key}: string`;
  }
  return `${text}}`;
}
