import {readFileSync} from 'node:fs';
import {parse as parseSfc} from '@vue/compiler-sfc';
import {parseSync} from 'oxc-parser';
import {splitBlocks} from '@multifront/core';
import type {Target} from '@multifront/core';

export interface FoundImport {
  specifier: string;
  attribute: string | undefined; // the `framework` value of `with { framework }`
  line: number; // 1-based, in the whole file
  block?: Target;
}

interface Script {
  code: string;
  offset: number; // where `code` starts in the file
  lang: 'ts' | 'tsx';
  block?: Target;
}

type Node = {type?: string; [key: string]: unknown};

function scriptsOf(fileName: string, source: string): Script[] {
  if (fileName.endsWith('.ucf')) {
    const react = splitBlocks(source, fileName).targets.react;
    return react ? [{code: react.content, offset: react.contentStart, lang: 'tsx', block: 'react'}] : [];
  }
  if (fileName.endsWith('.vue')) {
    const {descriptor} = parseSfc(source, {filename: fileName});
    return [descriptor.script, descriptor.scriptSetup]
      .filter((script) => script !== null)
      .map((script) => ({code: script.content, offset: script.loc.start.offset, lang: script.lang === 'tsx' ? 'tsx' : 'ts'}));
  }
  return [{code: source, offset: 0, lang: fileName.endsWith('.tsx') ? 'tsx' : 'ts'}];
}

function keyName(key: Node): unknown {
  return key.type === 'Identifier' ? key.name : key.value;
}

function stringValue(node: Node | undefined): string | undefined {
  return node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;
}

// `import()` options: `{with: {framework: '...'}}`.
function optionsAttribute(options: Node | undefined): string | undefined {
  if (options?.type !== 'ObjectExpression') return undefined;
  const withNode = (options.properties as Node[]).find((prop) => keyName(prop.key as Node) === 'with')?.value as Node;
  if (withNode?.type !== 'ObjectExpression') return undefined;
  const framework = (withNode.properties as Node[]).find((prop) => keyName(prop.key as Node) === 'framework');
  return stringValue(framework?.value as Node);
}

function staticAttribute(attributes: Node[] | undefined): string | undefined {
  const framework = attributes?.find((attr) => keyName(attr.key as Node) === 'framework');
  return stringValue(framework?.value as Node);
}

function walk(node: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(node)) for (const child of node) walk(child, visit);
  else if (node && typeof node === 'object') {
    visit(node as Node);
    for (const child of Object.values(node)) walk(child, visit);
  }
}

/** Every import of a `.ucf` path in a real file: static, `export ... from` and `import()` with a literal. */
export function readImports(fileName: string): FoundImport[] {
  const source = readFileSync(fileName, 'utf8');
  const lineOf = (offset: number) => source.slice(0, offset).split('\n').length;
  const found: FoundImport[] = [];
  for (const script of scriptsOf(fileName, source)) {
    const {program, errors} = parseSync(`script.${script.lang}`, script.code);
    if (errors.length) throw new Error(`${fileName}: ${errors[0]!.message}`);
    walk(program, (node) => {
      const isStatic = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type ?? '');
      if (!isStatic && node.type !== 'ImportExpression') return;
      const sourceNode = node.source as Node | undefined;
      const specifier = stringValue(sourceNode);
      if (!specifier?.endsWith('.ucf')) return;
      found.push({
        specifier,
        attribute: isStatic ? staticAttribute(node.attributes as Node[]) : optionsAttribute(node.options as Node),
        line: lineOf(script.offset + (sourceNode!.start as number)),
        ...(script.block && {block: script.block}),
      });
    });
  }
  return found;
}
