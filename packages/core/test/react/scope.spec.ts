import {createRequire} from 'node:module';
import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';
import {Visitor, parseSync} from 'oxc-parser';
import type {JSXElementName, JSXOpeningElement, Program} from 'oxc-parser';
import {describe, expect, it} from 'vitest';
import {checkBlocks, createBuildContext, getBlockKind, splitBlocks} from '@multifront/core';
import type {VueCompiler} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {FIXTURES_DIR, readComponent} from '../../../e2e/fixtures/index.ts';
import {withoutInjected} from '../blocks/injected.ts';

const compiler = createRequire(import.meta.url)('@vue/compiler-sfc') as VueCompiler;

// `fragments`: React's Fragment elements, hand-read from the fixture; they carry no stamp.
const CASES: {fixture: string; scoped: boolean; fragments?: string[]}[] = [
  {fixture: 'react/scope/Stamped.ucf', scoped: true, fragments: ['Fragment', 'Frag', 'React.Fragment']},
  {fixture: 'react/scope/Namespaced.ucf', scoped: true},
  {fixture: 'Badge.ucf', scoped: true},
  {fixture: 'Button.ucf', scoped: true},
  {fixture: 'ComposesScoped.ucf', scoped: true},
  {fixture: 'Panel.ucf', scoped: true},
  {fixture: 'ScopedModuleScss.ucf', scoped: true},
  {fixture: 'TsxEdges.ucf', scoped: true},
  {fixture: 'react/AllBlocks.ucf', scoped: false},
];

function nameText(name: JSXElementName): string {
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXNamespacedName') return `${name.namespace.name}:${name.name.name}`;
  return `${nameText(name.object)}.${name.property.name}`;
}

function openingElements(program: Program): JSXOpeningElement[] {
  const found: JSXOpeningElement[] = [];
  new Visitor({JSXOpeningElement: (node) => void found.push(node)}).visit(program);
  return found;
}

function parse(code: string): {program: Program; errors: unknown[]} {
  return parseSync('Block.tsx', code, {lang: 'tsx', sourceType: 'module'});
}

function lineColumn(text: string, offset: number): {line: number; column: number} {
  const before = text.slice(0, offset).split('\n');
  return {line: before.length, column: before.at(-1)!.length};
}

describe.each(CASES)('react.build stamping of $fixture', async ({fixture, scoped, fragments = []}) => {
  const {filename, source} = readComponent(fixture);
  const split = splitBlocks(source, filename);
  const ctx = await createBuildContext(split, {root: FIXTURES_DIR, compiler, production: false});
  const block = split.targets.react!;
  const file = getBlockKind('react').build!(block, ctx);
  const stamp = `data-v-${ctx.scopeId}`;
  const {program, errors} = parse(file.code);
  const input = openingElements(parse(block.content).program);
  const output = openingElements(program);

  it('is a valid fixture whose build parses', () => {
    expect(checkBlocks(split)).toEqual([]);
    expect(ctx.hasScoped).toBe(scoped);
    expect(errors).toEqual([]);
  });

  it('matches the code snapshot', async () => {
    const code = file.code.replaceAll(FIXTURES_DIR, '<fixtures>');
    await expect(code).toMatchFileSnapshot(`../__snapshots__/react/scope/${fixture}.tsx.snap`);
  });

  it('only inserts: without the stamps and the imports, the code is the block content', () => {
    expect(withoutInjected(file.code.replaceAll(` ${stamp}=""`, ''), program)).toBe(block.content);
  });

  it(`stamps every opening element exactly once, ${scoped ? "but React's fragments" : 'none without a scoped style'}`, () => {
    expect(output.map(({name}) => nameText(name))).toEqual(input.map(({name}) => nameText(name)));
    for (const {name, attributes} of output) {
      const stamps = attributes.filter(
        (item) => item.type === 'JSXAttribute' && item.name.type === 'JSXIdentifier' && item.name.name === stamp
      );
      const expected = scoped && !fragments.includes(nameText(name)) ? 1 : 0;
      expect({element: nameText(name), stamps: stamps.length}, nameText(name)).toEqual({
        element: nameText(name),
        stamps: expected,
      });
      for (const item of stamps)
        expect(item.type === 'JSXAttribute' && item.value?.type === 'Literal' && item.value.value).toBe('');
    }
    if (fragments.length > 0) expect(output.map(({name}) => nameText(name))).toEqual(expect.arrayContaining(fragments));
  });

  it('keeps every mapping: the text after a stamp maps back to the end of the element name', () => {
    const map = new TraceMap(file.map!);
    output.forEach((element, index) => {
      const attribute = element.attributes[0];
      if (attribute?.type !== 'JSXAttribute' || attribute.name.type !== 'JSXIdentifier' || attribute.name.name !== stamp) return;
      const after = input[index]!.typeArguments ?? input[index]!.name;
      const original = originalPositionFor(map, lineColumn(file.code, attribute.end));
      expect({line: original.line, column: original.column}).toEqual(lineColumn(source, block.contentStart + after.end));
    });
  });
});
