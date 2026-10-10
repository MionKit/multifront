import {readFileSync} from 'node:fs';
import {parse as parseSfc} from '@vue/compiler-sfc';
import {Visitor, parseSync} from 'oxc-parser';
import type {Expression, ImportAttribute, ImportAttributeKey, PropertyKey} from 'oxc-parser';
import {splitBlocks} from '@multifront/core';
import type {Target} from '@multifront/core';

interface FoundImport {
  specifier: string;
  attribute: string | undefined; // the `framework` value of `with { framework }`
  line: number; // 1-based, in the whole file
  block?: Target;
}

interface Script {
  code: string;
  offset: number; // where `code` starts in the file
  lang: 'js' | 'jsx' | 'ts' | 'tsx';
  block?: Target;
}

function scriptsOf(fileName: string, source: string): Script[] {
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

function keyName(key: ImportAttributeKey | PropertyKey): string | undefined {
  if (key.type === 'Identifier') return key.name;
  return key.type === 'Literal' && typeof key.value === 'string' ? key.value : undefined;
}

function stringValue(node: Expression | undefined): string | undefined {
  return node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;
}

function property(object: Expression | null | undefined, name: string): Expression | undefined {
  if (object?.type !== 'ObjectExpression') return undefined;
  for (const prop of object.properties)
    if (prop.type === 'Property' && keyName(prop.key) === name) return prop.value as Expression;
  return undefined;
}

function staticAttribute(attributes: ImportAttribute[]): string | undefined {
  return attributes.find((attr) => keyName(attr.key) === 'framework')?.value.value;
}

/** Only `.ucf` imports; an `import()` counts only with a string literal. */
export function readImports(fileName: string): FoundImport[] {
  const source = readFileSync(fileName, 'utf8');
  const found: FoundImport[] = [];
  for (const script of scriptsOf(fileName, source)) {
    const {program, errors} = parseSync(`script.${script.lang}`, script.code);
    if (errors.length) throw new Error(`${fileName}: ${errors[0]!.message}`);
    const add = (sourceNode: Expression | null, attribute: string | undefined) => {
      const specifier = stringValue(sourceNode ?? undefined);
      if (!sourceNode || !specifier?.endsWith('.ucf')) return;
      const line = source.slice(0, script.offset + sourceNode.start).split('\n').length;
      found.push({specifier, attribute, line, ...(script.block && {block: script.block})});
    };
    const fromStatic = (node: {source: Expression | null; attributes: ImportAttribute[]}) =>
      add(node.source, staticAttribute(node.attributes));
    new Visitor({
      ImportDeclaration: fromStatic,
      ExportNamedDeclaration: fromStatic,
      ExportAllDeclaration: fromStatic,
      ImportExpression: (node) => add(node.source, stringValue(property(property(node.options, 'with'), 'framework'))),
    }).visit(program);
  }
  return found;
}
