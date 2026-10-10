import {readFileSync} from 'node:fs';
import {parse as parseSfc} from '@vue/compiler-sfc';
import {rewriteImportAttributes, splitBlocks} from '@multifront/core';
import type {DiagnosticCode, Target} from '@multifront/core';

interface FoundImport {
  specifier: string;
  attribute: string | undefined; // the `framework` value of `with { framework }`
  line: number; // 1-based, in the whole file
  block?: Target;
}

export interface Script {
  code: string;
  offset: number; // where `code` starts in the file
  lang: 'js' | 'jsx' | 'ts' | 'tsx';
  block?: Target;
}

export function scriptsOf(fileName: string, source: string): Script[] {
  if (fileName.endsWith('.ucf')) {
    const split = splitBlocks(source, fileName);
    if (split.errors.length) throw new Error(`${fileName}: ${split.errors[0]!.message}`);
    const react = split.targets.react;
    return react ? [{code: react.content, offset: react.contentStart, lang: 'tsx', block: 'react'}] : [];
  }
  if (fileName.endsWith('.vue')) {
    const {descriptor, errors} = parseSfc(source, {filename: fileName});
    if (errors.length) throw new Error(`${fileName}: ${errors[0]!.message}`);
    return [descriptor.script, descriptor.scriptSetup]
      .filter((script) => script !== null)
      .map((script) => ({code: script.content, offset: script.loc.start.offset, lang: script.lang === 'tsx' ? 'tsx' : 'ts'}));
  }
  if (fileName.endsWith('.svelte')) {
    // svelte/compiler arrives with the Svelte target (M6); the instance script is all an import can sit in.
    const script = /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(source);
    if (!script) return [];
    const lang = /\blang=["']ts["']/.test(script[0]) ? 'ts' : 'js';
    return [{code: script[1]!, offset: script.index + script[0].indexOf('>') + 1, lang}];
  }
  return [{code: source, offset: 0, lang: fileName.slice(fileName.lastIndexOf('.') + 1) as Script['lang']}];
}

interface FoundError {
  code: DiagnosticCode;
  message: string;
  line: number; // 1-based, in the whole file
}

/** A script of a `.ucf`, `.vue` or `.svelte` file names its language in a `lang.<x>` query, like a Vite sub-request. */
export function scriptName(fileName: string, script: Script): string {
  return /\.(ucf|vue|svelte)$/.test(fileName) ? `${fileName}?lang.${script.lang}` : fileName;
}

/** Every `.ucf` import of the file and the rewrite's errors, as `rewriteImportAttributes` finds them. */
export function readImports(fileName: string): {imports: FoundImport[]; errors: FoundError[]} {
  const source = readFileSync(fileName, 'utf8');
  const imports: FoundImport[] = [];
  const errors: FoundError[] = [];
  const lineAt = (offset: number) => source.slice(0, offset).split('\n').length;
  for (const script of scriptsOf(fileName, source)) {
    const result = rewriteImportAttributes(script.code, scriptName(fileName, script));
    for (const {specifier, framework, start} of result.imports) {
      imports.push({
        specifier,
        attribute: framework,
        line: lineAt(script.offset + start),
        ...(script.block && {block: script.block}),
      });
    }
    for (const {code, message, start} of result.errors) errors.push({code, message, line: lineAt(script.offset + start)});
  }
  return {imports, errors};
}
