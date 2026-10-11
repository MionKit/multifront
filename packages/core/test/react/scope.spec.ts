import {readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {basename, sep} from 'node:path';
import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';
import {Visitor, parseSync} from 'oxc-parser';
import type {CallExpression, JSXAttributeItem, JSXElementName, JSXOpeningElement, Program} from 'oxc-parser';
import {describe, expect, it} from 'vitest';
import {checkBlocks, createBuildContext, getBlockKind, scopeHelperCode, splitBlocks} from '@multifront/core';
import type {VueCompiler} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {FIXTURES_DIR, componentPath, listComponents, readComponent} from '../../../e2e/fixtures/index.ts';
import {isCallTo, isHelperImport, withoutInjected} from '../blocks/injected.ts';

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
  {fixture: 'react/ScopedPanel.ucf'},
  {fixture: 'react/forwarding/ClassRoot.ucf'},
  {fixture: 'react/fuzz-found/ConstFragment.ucf', unstamped: ['Fragment']},
  // The const, parameter and arrow parameter that shadow `Fragment` and `React` get stamped.
  {fixture: 'react/scope/FragmentImports.ucf', unstamped: ['R.Fragment', 'Quoted', 'Fragment', 'React.Fragment']},
  {fixture: 'react/scope/Namespaced.ucf'},
  {fixture: 'react/scope/Stamped.ucf', unstamped: ['Fragment', 'Fragment', 'Frag', 'React.Fragment']},
  {fixture: 'react/shapes/MultiReturn.ucf'},
  {fixture: 'scoped-modules/ScopedModuleEdges.ucf'},
];
const CASES = [
  ...SCOPED.map((row) => ({...row, scoped: true})),
  {fixture: 'react/AllBlocks.ucf', scoped: false},
  {fixture: 'react/ScopedBadge.ucf', scoped: false},
];

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

function isForward(item: JSXAttributeItem | undefined): boolean {
  return item?.type === 'JSXSpreadAttribute' && isCallTo(item.argument, '__ucfScopeAttrs');
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

// Hand-read from the fixtures: `roots` get the spread, in source order.
// `signature`: dev build text around the parameters it adds, and the `const <pattern> = <props>;` it moves in.
// `forwarding/` holds build-only edges of finding the component and a name for its props.
const SHAPES: {fixture: string; roots: string[]; props?: string; fragments?: number; signature?: string}[] = [
  {
    fixture: 'react/forwarding/ArrayPattern.ucf',
    roots: ['div'],
    props: '__props',
    signature: 'function ArrayPattern(__props /* ] */ ?: [string?]) {const [ first ] = __props;',
  },
  {fixture: 'react/forwarding/ClassRoot.ucf', roots: []},
  {fixture: 'react/forwarding/Cyclic.ucf', roots: []},
  {fixture: 'react/forwarding/DefaultReadsBody.ucf', roots: []},
  {
    fixture: 'react/forwarding/DestructuredFragment.ucf',
    roots: [],
    fragments: 1,
    props: '__props',
    signature: 'function DestructuredFragment(__props: { branch?: string }) {const { branch } = __props;',
  },
  {
    fixture: 'react/forwarding/DirectiveBody.ucf',
    roots: ['div'],
    props: '__props',
    signature: "(__props: { branch?: string }) {\n    'use no memo'\n    const { branch } = __props;return",
  },
  {fixture: 'react/forwarding/ExportAsDefault.ucf', roots: ['div']},
  {fixture: 'react/forwarding/LaterParamReads.ucf', roots: []},
  {fixture: 'react/forwarding/LetExport.ucf', roots: []},
  {fixture: 'react/forwarding/NestedConst.ucf', roots: []},
  {fixture: 'react/forwarding/OnlyThis.ucf', roots: []},
  {
    fixture: 'react/forwarding/PropsClash.ucf',
    roots: ['div'],
    props: '__props2',
    signature: 'function PropsClash(__props2: { branch?: string }) {const { branch } = __props2;',
  },
  {fixture: 'react/forwarding/RedeclaredPattern.ucf', roots: []},
  {
    fixture: 'react/forwarding/RefClash.ucf',
    roots: ['div'],
    props: '__props1',
    signature: '<HTMLDivElement>((__props1, __ref1) =>',
  },
  {
    fixture: 'react/forwarding/RenamedKey.ucf',
    roots: ['div'],
    props: '__props',
    signature: 'function RenamedKey(__props: Props) {const { className: extra, onChange } = __props;',
  },
  {fixture: 'react/forwarding/RestParams.ucf', roots: []},
  {fixture: 'react/forwarding/ShadowedProps.ucf', roots: []},
  {fixture: 'react/forwarding/ThisParam.ucf', roots: ['div']},
  {fixture: 'react/forwarding/WrappedExport.ucf', roots: ['div']},
  {fixture: 'react/shapes/AndRoot.ucf', roots: ['p', 'section', 'div']},
  {fixture: 'react/shapes/ArrowExpression.ucf', roots: ['div']},
  {fixture: 'react/shapes/ComponentRoot.ucf', roots: ['ArrowExpression']},
  {fixture: 'react/shapes/ConstRoot.ucf', roots: ['article']},
  {
    fixture: 'react/shapes/Destructured.ucf',
    roots: ['div'],
    props: '__props',
    signature: 'function Destructured(__props: Props) {const { branch } = __props;',
  },
  {
    fixture: 'react/shapes/DestructuredArrow.ucf',
    roots: ['p'],
    props: '__props',
    signature: 'export default (__props: { branch?: string }) => {const { branch } = __props; return (',
  },
  {
    fixture: 'react/shapes/DestructuredDefaults.ucf',
    roots: ['section'],
    props: '__props',
    signature:
      "function DestructuredDefaults(__props: Props = {}) {const {\n    /* shown without a label */\n    label = 'default label',\n    branch,\n    ...rest\n  } = __props;",
  },
  {fixture: 'react/shapes/ExportIdentifier.ucf', roots: ['div']},
  {fixture: 'react/shapes/ForwardRef.ucf', roots: ['div']},
  {
    fixture: 'react/shapes/ForwardRefDestructured.ucf',
    roots: ['div'],
    props: '__props',
    signature: '>((__props, ref) => {const { branch } = __props; return (',
  },
  {fixture: 'react/shapes/FragmentRoot.ucf', roots: [], fragments: 2},
  {fixture: 'react/shapes/Memo.ucf', roots: ['div']},
  {
    fixture: 'react/shapes/MemoForwardRef.ucf',
    roots: ['div'],
    props: '__props',
    signature: '<HTMLDivElement>((__props, __ref) =>',
  },
  {fixture: 'react/shapes/MultiReturn.ucf', roots: ['section', 'div']},
  {fixture: 'react/shapes/NestedTernary.ucf', roots: ['div', 'p', 'section']},
  {fixture: 'react/shapes/NoParams.ucf', roots: ['div'], props: '__props', signature: 'function NoParams /* () */ (__props) {'},
  {fixture: 'react/shapes/NullRoot.ucf', roots: []},
  {fixture: 'react/shapes/Ternary.ucf', roots: ['div', 'p']},
  // Only `content` warns, at its return: `mixed` would also warn on renders that return the div.
  {fixture: 'react/fuzz-found/ConstFragment.ucf', roots: ['div'], fragments: 1},
];

it('has a row for every forwarding/, shapes/ and fuzz-found/ fixture', () => {
  const listed = [
    ...listComponents('react/forwarding'),
    ...listComponents('react/shapes'),
    ...listComponents('react/fuzz-found'),
  ];
  expect(listed).toEqual(SHAPES.map(({fixture}) => fixture));
});

it('serves the fragment warning in the dev helper only, and both helpers run', async () => {
  const load = (code: string) => import(`data:text/javascript,${encodeURIComponent(code)}`);
  const dev = await load(scopeHelperCode(true));
  const production = await load(scopeHelperCode(false));
  expect(Object.keys(dev).sort()).toEqual(['__ucfScopeAttrs', '__ucfWarnFragment']);
  expect(Object.keys(production)).toEqual(['__ucfScopeAttrs']);
  expect(production.__ucfScopeAttrs({'data-v-12345678': '', className: 'card', 'data-test': 'x'})).toEqual({
    'data-v-12345678': '',
  });
});

function calls(program: Program, name: string): CallExpression[] {
  const found: CallExpression[] = [];
  new Visitor({
    CallExpression: (node) => {
      if (isCallTo(node, name)) found.push(node);
    },
  }).visit(program);
  return found;
}

function argumentText(code: string, call: CallExpression): string[] {
  return call.arguments.map(({start, end}) => code.slice(start, end));
}

describe.each(SHAPES)(
  'react.build forwarding of $fixture',
  async ({fixture, roots, props = 'props', fragments = 0, signature}) => {
    const pattern = signature?.match(/const ([\s\S]+?) = __props\d*;/)?.[1];
    const {filename, source} = readComponent(fixture);
    const split = splitBlocks(source, filename);
    const block = split.targets.react!;
    const builds = await Promise.all(
      [false, true].map(async (production) => {
        const ctx = await createBuildContext(split, {root: FIXTURES_DIR, compiler, production});
        const {code, map} = getBlockKind('react').build!(block, ctx);
        return {code, map: map!, ctx, program: parse(code).program};
      })
    );
    const [dev, production] = builds as [(typeof builds)[0], (typeof builds)[0]];
    const forwarded = ({program}: {program: Program}) =>
      openingElements(program)
        .filter(({attributes}) => attributes.some(isForward))
        .map(({name}) => nameText(name));
    const helperImport = ({program}: {program: Program}) =>
      program.body.filter(isHelperImport).flatMap(({specifiers}) => specifiers.map(({local}) => local.name));

    it('is a valid fixture whose builds parse', () => {
      expect(checkBlocks(split)).toEqual([]);
      for (const {code} of builds) expect(parse(code).errors).toEqual([]);
    });

    it('matches the dev code snapshot', async () => {
      const code = dev.code.replaceAll(FIXTURES_DIR, '<fixtures>');
      await expect(code).toMatchFileSnapshot(`../__snapshots__/react/scope/${fixture}.tsx.snap`);
    });

    it('only inserts and moves the pattern: without the stamps, the forwarding and the imports, the code is the block content', () => {
      for (const {code, ctx, program} of builds)
        expect(withoutInjected(code, program).replaceAll(` data-v-${ctx.scopeId}=""`, '')).toBe(block.content);
    });

    it('forwards the first parameter on every JSX element root, and nowhere else', () => {
      for (const build of builds) {
        expect(forwarded(build)).toEqual(roots);
        const spreads = calls(build.program, '__ucfScopeAttrs');
        expect(spreads.map((call) => argumentText(build.code, call))).toEqual(roots.map(() => [props]));
        // Production adds nothing for a fragment root, whose warning is dev only.
        if (signature && (build === dev || roots.length > 0)) expect(build.code).toContain(signature);
        else expect(build.code).not.toMatch(/__props\d*[,:)]/);
      }
    });

    it('warns on each fragment root in dev only, naming the component by its file', () => {
      const warnings = calls(dev.program, '__ucfWarnFragment').map((call) => argumentText(dev.code, call));
      expect(warnings).toEqual(Array.from({length: fragments}, () => [props, JSON.stringify(basename(fixture, '.ucf'))]));
      expect(production.code).not.toContain('__ucfWarnFragment');
    });

    it('moves a destructured first parameter into the body, its first and last character mapped back to where they were written', () => {
      if (!pattern) return void expect(dev.code).not.toMatch(/const [^;]* = __props\d*;/);
      const statement = dev.code.indexOf(`const ${pattern} = ${props};`) + 'const '.length;
      const written = source.indexOf(pattern);
      expect(Math.min(statement, written)).toBeGreaterThan(-1);
      const map = new TraceMap(dev.map);
      for (const [from, to] of [
        [statement, written],
        [statement + pattern.length - 1, written + pattern.length - 1],
      ] as const) {
        const original = originalPositionFor(map, lineColumn(dev.code, from));
        expect({line: original.line, column: original.column}).toEqual(lineColumn(source, to));
      }
    });

    it('imports exactly the helpers it calls', () => {
      const attrs = roots.length > 0 ? ['__ucfScopeAttrs'] : [];
      expect(helperImport(dev)).toEqual([...attrs, ...(fragments > 0 ? ['__ucfWarnFragment'] : [])]);
      expect(helperImport(production)).toEqual(attrs);
    });
  }
);
