import {readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {sep} from 'node:path';
import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';
import {Visitor, parseSync} from 'oxc-parser';
import type {JSXAttributeItem, JSXElementName, JSXOpeningElement, Program} from 'oxc-parser';
import {describe, expect, it} from 'vitest';
import {checkBlocks, createBuildContext, getBlockKind, splitBlocks} from '@multifront/core';
import type {VueCompiler} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {FIXTURES_DIR, componentPath, readComponent} from '../../../e2e/fixtures/index.ts';
import {withoutInjected} from '../blocks/injected.ts';

const compiler = createRequire(import.meta.url)('@vue/compiler-sfc') as VueCompiler;

// `unstamped`: the names of React's Fragment elements in source order, hand-read from the fixture.
const SCOPED: {fixture: string; unstamped?: string[]}[] = [
  {fixture: 'Badge.ucf'},
  {fixture: 'Button.ucf'},
  {fixture: 'ComposesScoped.ucf'},
  {fixture: 'Panel.ucf'},
  {fixture: 'ScopedModuleScss.ucf'},
  {fixture: 'TsxEdges.ucf'},
  {fixture: 'invalid/CssSyntaxError.ucf'},
  {fixture: 'langs/PostcssPlain.ucf'},
  {fixture: 'langs/SassIndented.ucf'},
  // The const, parameter and arrow parameter that shadow `Fragment` and `React` get stamped.
  {fixture: 'react/scope/FragmentImports.ucf', unstamped: ['R.Fragment', 'Quoted', 'Fragment', 'React.Fragment']},
  {fixture: 'react/scope/Namespaced.ucf'},
  {fixture: 'react/scope/Stamped.ucf', unstamped: ['Fragment', 'Fragment', 'Frag', 'React.Fragment']},
  {fixture: 'scoped-modules/ScopedModuleEdges.ucf'},
];
const CASES = [...SCOPED.map((row) => ({...row, scoped: true})), {fixture: 'react/AllBlocks.ucf', scoped: false}];

it('runs every fixture with a <react> block, a scoped style and no error', () => {
  const found = readdirSync(componentPath(''), {recursive: true, encoding: 'utf8'})
    .map((path) => path.split(sep).join('/'))
    .filter((name) => {
      if (!name.endsWith('.ucf')) return false;
      const {filename, source} = readComponent(name);
      const split = splitBlocks(source, filename);
      return split.targets.react && split.styles.some(({attrs}) => attrs.scoped) && checkBlocks(split).length === 0;
    });
  expect(found.sort()).toEqual(SCOPED.map(({fixture}) => fixture));
});

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

function parse(code: string) {
  return parseSync('Block.tsx', code, {lang: 'tsx', sourceType: 'module'});
}

function lineColumn(text: string, offset: number): {line: number; column: number} {
  const before = text.slice(0, offset).split('\n');
  return {line: before.length, column: before.at(-1)!.length};
}

describe.each(CASES)('react.build stamping of $fixture', async ({fixture, scoped, unstamped = []}) => {
  const {filename, source} = readComponent(fixture);
  const split = splitBlocks(source, filename);
  const ctx = await createBuildContext(split, {root: FIXTURES_DIR, compiler, production: false});
  const block = split.targets.react!;
  const file = getBlockKind('react').build!(block, ctx);
  const stamp = `data-v-${ctx.scopeId}`;
  const isStamp = (item: JSXAttributeItem) =>
    item.type === 'JSXAttribute' &&
    item.name.type === 'JSXIdentifier' &&
    item.name.name === stamp &&
    item.value?.type === 'Literal' &&
    item.value.value === '';
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

  it(`stamps every opening element once, ${scoped ? "but React's fragments" : 'none without a scoped style'}`, () => {
    expect(output.map(({name}) => nameText(name))).toEqual(input.map(({name}) => nameText(name)));
    for (const {name, attributes} of output) expect(attributes.filter(isStamp).length, nameText(name)).toBeLessThanOrEqual(1);
    const bare = output.filter(({attributes}) => !attributes.some(isStamp)).map(({name}) => nameText(name));
    expect(bare).toEqual(scoped ? unstamped : input.map(({name}) => nameText(name)));
  });

  it('keeps every mapping: the stamp comes first, and the text after it maps back to the end of the element name', () => {
    const map = new TraceMap(file.map!);
    output.forEach(({attributes}, index) => {
      if (!attributes.some(isStamp)) return;
      expect(isStamp(attributes[0]!)).toBe(true);
      const after = input[index]!.typeArguments ?? input[index]!.name;
      const original = originalPositionFor(map, lineColumn(file.code, attributes[0]!.end));
      expect({line: original.line, column: original.column}).toEqual(lineColumn(source, block.contentStart + after.end));
    });
  });
});
