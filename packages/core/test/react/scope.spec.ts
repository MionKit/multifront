import {readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {sep} from 'node:path';
import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';
import {Visitor, parseSync} from 'oxc-parser';
import type {CallExpression, JSXAttributeItem, JSXElementName, JSXOpeningElement, Program} from 'oxc-parser';
import {describe, expect, it} from 'vitest';
import {SCOPE_HELPER_ID, checkBlocks, createBuildContext, getBlockKind, splitBlocks} from '@multifront/core';
import type {VueCompiler} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {FIXTURES_DIR, componentPath, listComponents, readComponent} from '../../../e2e/fixtures/index.ts';
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
  {fixture: 'react/shapes/MultiReturn.ucf'},
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
  const isForward = (item: JSXAttributeItem | undefined) =>
    item?.type === 'JSXSpreadAttribute' &&
    item.argument.type === 'CallExpression' &&
    item.argument.callee.type === 'Identifier' &&
    item.argument.callee.name === '__ucfScopeAttrs';
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

  it('only inserts: without the stamps, the forwarding and the imports, the code is the block content', () => {
    expect(withoutInjected(file.code, program).replaceAll(` ${stamp}=""`, '')).toBe(block.content);
  });

  it(`stamps every opening element once, ${scoped ? "but React's fragments" : 'none without a scoped style'}`, () => {
    expect(output.map(({name}) => nameText(name))).toEqual(input.map(({name}) => nameText(name)));
    for (const {name, attributes} of output) expect(attributes.filter(isStamp).length, nameText(name)).toBeLessThanOrEqual(1);
    const bare = output.filter(({attributes}) => !attributes.some(isStamp)).map(({name}) => nameText(name));
    expect(bare).toEqual(scoped ? unstamped : input.map(({name}) => nameText(name)));
  });

  it('keeps every mapping: the stamp comes first, and the text after the inserts maps back to the end of the element name', () => {
    const map = new TraceMap(file.map!);
    output.forEach(({attributes}, index) => {
      if (!attributes.some(isStamp)) return;
      expect(isStamp(attributes[0]!)).toBe(true);
      // A root's forwarding spread is inserted right after its stamp.
      const last = isForward(attributes[1]) ? attributes[1]! : attributes[0]!;
      const after = input[index]!.typeArguments ?? input[index]!.name;
      const original = originalPositionFor(map, lineColumn(file.code, last.end));
      expect({line: original.line, column: original.column}).toEqual(lineColumn(source, block.contentStart + after.end));
    });
  });
});

// Hand-read from the fixtures: `roots` are the opening elements that get the spread, in source order;
// `fragments` the fragment roots; `signature` the parameters the build adds.
const SHAPES: {fixture: string; props: string; roots: string[]; fragments?: number; signature?: string}[] = [
  {fixture: 'AndRoot.ucf', props: 'props', roots: ['p', 'section', 'div']},
  {fixture: 'ArrowExpression.ucf', props: 'props', roots: ['div']},
  {fixture: 'ComponentRoot.ucf', props: 'props', roots: ['ArrowExpression']},
  {fixture: 'ConstRoot.ucf', props: 'props', roots: ['article']},
  {fixture: 'ExportIdentifier.ucf', props: 'props', roots: ['div']},
  {fixture: 'ForwardRef.ucf', props: 'props', roots: ['div']},
  {fixture: 'FragmentRoot.ucf', props: 'props', roots: [], fragments: 2},
  {fixture: 'Memo.ucf', props: 'props', roots: ['div']},
  {fixture: 'MemoForwardRef.ucf', props: '__props', roots: ['div'], signature: '<HTMLDivElement>((__props, __ref) =>'},
  {fixture: 'MultiReturn.ucf', props: 'props', roots: ['section', 'div']},
  {fixture: 'NestedTernary.ucf', props: 'props', roots: ['div', 'p', 'section']},
  {fixture: 'NoParams.ucf', props: '__props', roots: ['div'], signature: 'function NoParams /* () */ (__props) {'},
  {fixture: 'NullRoot.ucf', props: 'props', roots: []},
  {fixture: 'Ternary.ucf', props: 'props', roots: ['div', 'p']},
];

it('has a row for every shapes/ fixture', () => {
  expect(listComponents('react/shapes')).toEqual(SHAPES.map(({fixture}) => `react/shapes/${fixture}`));
});

function calls(program: Program, name: string): CallExpression[] {
  const found: CallExpression[] = [];
  new Visitor({
    CallExpression: (node) => {
      if (node.callee.type === 'Identifier' && node.callee.name === name) found.push(node);
    },
  }).visit(program);
  return found;
}

function argumentText(code: string, call: CallExpression): string[] {
  return call.arguments.map(({start, end}) => code.slice(start, end));
}

describe.each(SHAPES)('react.build forwarding of shapes/$fixture', async ({fixture, props, roots, fragments = 0, signature}) => {
  const {filename, source} = readComponent(`react/shapes/${fixture}`);
  const split = splitBlocks(source, filename);
  const block = split.targets.react!;
  const builds = await Promise.all(
    [false, true].map(async (production) => {
      const ctx = await createBuildContext(split, {root: FIXTURES_DIR, compiler, production});
      const {code} = getBlockKind('react').build!(block, ctx);
      return {code, ctx, program: parse(code).program};
    })
  );
  const [dev, production] = builds as [(typeof builds)[0], (typeof builds)[0]];
  const forwarded = ({program}: {program: Program}) =>
    openingElements(program)
      .filter(({attributes}) =>
        attributes.some((item) => item.type === 'JSXSpreadAttribute' && item.argument.type === 'CallExpression')
      )
      .map(({name}) => nameText(name));
  const helperImport = ({program}: {program: Program}) =>
    program.body.flatMap((node) =>
      node.type === 'ImportDeclaration' && node.source.value === SCOPE_HELPER_ID
        ? node.specifiers.map(({local}) => local.name)
        : []
    );

  it('is a valid fixture whose builds parse', () => {
    expect(checkBlocks(split)).toEqual([]);
    for (const {code} of builds) expect(parse(code).errors).toEqual([]);
  });

  it('matches the dev code snapshot', async () => {
    const code = dev.code.replaceAll(FIXTURES_DIR, '<fixtures>');
    await expect(code).toMatchFileSnapshot(`../__snapshots__/react/scope/react/shapes/${fixture}.tsx.snap`);
  });

  it('only inserts: without the stamps, the forwarding and the imports, the code is the block content', () => {
    for (const {code, ctx, program} of builds)
      expect(withoutInjected(code, program).replaceAll(` data-v-${ctx.scopeId}=""`, '')).toBe(block.content);
  });

  it('forwards the first parameter on every JSX element root, and nowhere else', () => {
    for (const build of builds) {
      expect(forwarded(build)).toEqual(roots);
      const spreads = calls(build.program, '__ucfScopeAttrs');
      expect(spreads.map((call) => argumentText(build.code, call))).toEqual(roots.map(() => [props]));
      if (signature) expect(build.code).toContain(signature);
    }
  });

  it('warns on each fragment root in dev only, naming the component by its file', () => {
    const warnings = calls(dev.program, '__ucfWarnFragment').map((call) => argumentText(dev.code, call));
    expect(warnings).toEqual(Array.from({length: fragments}, () => [props, JSON.stringify(fixture.replace('.ucf', ''))]));
    expect(production.code).not.toContain('__ucfWarnFragment');
  });

  it('imports exactly the helpers it calls', () => {
    const attrs = roots.length > 0 ? ['__ucfScopeAttrs'] : [];
    expect(helperImport(dev)).toEqual([...attrs, ...(fragments > 0 ? ['__ucfWarnFragment'] : [])]);
    expect(helperImport(production)).toEqual(attrs);
  });
});
