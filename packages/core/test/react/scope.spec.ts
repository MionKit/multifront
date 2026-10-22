import {readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {basename, sep} from 'node:path';
import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';
import {Visitor, parseSync} from 'oxc-parser';
import type {CallExpression, JSXAttribute, JSXAttributeItem, JSXElementName, JSXOpeningElement, Program} from 'oxc-parser';
import {describe, expect, it} from 'vitest';
import {
  checkBlocks,
  createBuildContext,
  getBlockKind,
  propsTypeInserts,
  reactRootProps,
  scopeHelperCode,
  splitBlocks,
} from '@multifront/core';
import type {ReactPropsSite, VueCompiler} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {FIXTURES_DIR, componentPath, listComponents, readComponent} from '../../../e2e/fixtures/index.ts';
import {MERGES, isAdded, isCallTo, isHelperImport, withoutInjected} from '../blocks/injected.ts';

const compiler = createRequire(import.meta.url)('@vue/compiler-sfc') as VueCompiler;

// The order the build's helper import names them in.
const HELPERS = ['__frontScopeAttrs', '__frontWarnFragment', '__frontClass', '__frontStyle', '__frontRef'];
type RootProp = keyof typeof MERGES;

// `unstamped`: the names of React's Fragment elements in source order, hand-read from the fixture.
const SCOPED: {fixture: string; unstamped?: string[]}[] = [
  {fixture: 'Badge.front'},
  {fixture: 'Button.front'},
  {fixture: 'ComposesScoped.front'},
  {fixture: 'Counter.front'},
  {fixture: 'Note.front'},
  {fixture: 'Panel.front'},
  {fixture: 'PanelItem.front'},
  {fixture: 'ScopedModuleScss.front'},
  {fixture: 'TsxEdges.front'},
  {fixture: 'invalid/CssSyntaxError.front'},
  {fixture: 'langs/PostcssPlain.front'},
  {fixture: 'langs/SassIndented.front'},
  {fixture: 'langs/StylusPlain.front'},
  {fixture: 'react/ScopedPanel.front'},
  {fixture: 'react/forwarding/ClassRoot.front'},
  {fixture: 'react/fuzz-found/ConstFragment.front', unstamped: ['Fragment']},
  // The const, parameter and arrow parameter that shadow `Fragment` and `React` get stamped.
  {fixture: 'react/scope/FragmentImports.front', unstamped: ['R.Fragment', 'Quoted', 'Fragment', 'React.Fragment']},
  {fixture: 'react/scope/Namespaced.front'},
  {fixture: 'react/scope/Stamped.front', unstamped: ['Fragment', 'Fragment', 'Frag', 'React.Fragment']},
  {fixture: 'react/shapes/MultiReturn.front'},
  {fixture: 'scoped-modules/ScopedModuleEdges.front'},
  {fixture: 'vue/CounterCrlf.front'},
];
const CASES = [
  ...SCOPED.map((row) => ({...row, scoped: true})),
  {fixture: 'react/AllBlocks.front', scoped: false},
  {fixture: 'react/ScopedBadge.front', scoped: false},
];

it('runs every fixture with a <react> block, a scoped style and no error', () => {
  const found = readdirSync(componentPath(''), {recursive: true, encoding: 'utf8'})
    .map((path) => path.split(sep).join('/'))
    .filter((name) => {
      if (!name.endsWith('.front')) return false;
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
  return item?.type === 'JSXSpreadAttribute' && isCallTo(item.argument, '__frontScopeAttrs');
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
  const file = getBlockKind('react').build(block, ctx);
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
      // A root's forwarding spread is inserted right after its stamp, then the root props it adds.
      let inserted = isForward(attributes[1]) ? 2 : 1;
      while (inserted > 1 && isAdded(attributes[inserted])) inserted++;
      const last = attributes[inserted - 1]!;
      const after = input[index]!.typeArguments ?? input[index]!.name;
      const original = originalPositionFor(map, lineColumn(file.code, last.end));
      expect({line: original.line, column: original.column}).toEqual(lineColumn(source, block.contentStart + after.end));
    });
  });
});

// The build's one rewrite: a merged className string with a line break or `\` becomes the JS string JSX makes of it.
function withJsStrings(content: string): string {
  const edits: [number, number, string][] = [];
  new Visitor({
    JSXAttribute: ({name, value}) => {
      if (name.type !== 'JSXIdentifier' || name.name !== 'className' || value?.type !== 'Literal') return;
      if (/[\n\r\\]/.test(value.raw ?? '') && !value.raw?.includes('&'))
        edits.push([value.start, value.end, JSON.stringify(value.value)]);
    },
  }).visit(parse(content).program);
  return edits.reduceRight((text, [start, end, string]) => text.slice(0, start) + string + text.slice(end), content);
}

// How the build left a root's `className`, `style` or `ref`.
type RootPropState = 'added' | 'merged' | 'author' | 'none';

function forwardedRoots(program: Program): JSXOpeningElement[] {
  return openingElements(program).filter(({attributes}) => attributes.some(isForward));
}

function rootProp(code: string, opening: JSXOpeningElement, prop: RootProp, props: string): RootPropState {
  const own = opening.attributes.findLast(
    (item): item is JSXAttribute => item.type === 'JSXAttribute' && item.name.type === 'JSXIdentifier' && item.name.name === prop
  );
  if (!own) return 'none';
  const value = own.value?.type === 'JSXExpressionContainer' ? own.value.expression : undefined;
  const text = (node: {start: number; end: number}) => code.slice(node.start, node.end);
  if (value && isAdded(own) && text(value) === `${props}.${prop}`) return 'added';
  if (value?.type !== 'CallExpression' || !isCallTo(value, MERGES[prop])) return 'author';
  return value.arguments.length === 2 && text(value.arguments[1]!) === `${props}.${prop}` ? 'merged' : 'author';
}

// Hand-read from the fixtures: `roots` get the spread, in source order.
// `signature`: dev build text around the added parameters, the moved-in `const <pattern> = <props>;`, or the helper import.
// `forwarding/` holds build-only edges of finding the component and a name for its props.
// `rootProps`: per root in source order, how the build leaves each root prop (`react/root-props/` rows).
// `typed`: block text around `reactRootProps`' sites, marked as `markSites` does.
type RootProps = ({tag: string} & Record<RootProp, RootPropState>)[];
const SHAPES: {
  fixture: string;
  roots: string[];
  props?: string;
  fragments?: number;
  signature?: string;
  rootProps?: RootProps;
  typed?: string;
}[] = [
  {
    fixture: 'react/forwarding/ArrayPattern.front',
    roots: ['div'],
    props: '__props',
    signature: 'function ArrayPattern(__props /* ] */ ?: [string?]) {const [ first ] = __props;',
  },
  {fixture: 'react/forwarding/ClassRoot.front', roots: []},
  {fixture: 'react/forwarding/Cyclic.front', roots: []},
  {fixture: 'react/forwarding/DefaultReadsBody.front', roots: []},
  {
    fixture: 'react/forwarding/DestructuredFragment.front',
    roots: [],
    fragments: 1,
    props: '__props',
    signature: 'function DestructuredFragment(__props: { branch?: string }) {const { branch } = __props;',
  },
  {
    fixture: 'react/forwarding/DirectiveBody.front',
    roots: ['div'],
    props: '__props',
    signature: "(__props: { branch?: string }) {\n    'use no memo'\n    const { branch } = __props;return",
  },
  {fixture: 'react/forwarding/ExportAsDefault.front', roots: ['div']},
  {fixture: 'react/forwarding/LaterParamReads.front', roots: []},
  {fixture: 'react/forwarding/LetExport.front', roots: []},
  {fixture: 'react/forwarding/NestedConst.front', roots: []},
  {fixture: 'react/forwarding/OnlyThis.front', roots: []},
  {
    fixture: 'react/forwarding/PropsClash.front',
    roots: ['div'],
    props: '__props2',
    signature: 'function PropsClash(__props2: { branch?: string }) {const { branch } = __props2;',
  },
  {fixture: 'react/forwarding/RedeclaredPattern.front', roots: []},
  {
    fixture: 'react/forwarding/RefClash.front',
    roots: ['div'],
    props: '__props1',
    signature: '<HTMLDivElement>((__props1, __ref1) =>',
  },
  {
    fixture: 'react/forwarding/RenamedKey.front',
    roots: ['div'],
    props: '__props',
    signature: 'function RenamedKey(__props: Props) {const { className: extra, onChange } = __props;',
  },
  {fixture: 'react/forwarding/RestParams.front', roots: []},
  {fixture: 'react/forwarding/ShadowedProps.front', roots: []},
  {fixture: 'react/forwarding/ThisParam.front', roots: ['div']},
  {fixture: 'react/forwarding/WrappedExport.front', roots: ['div']},
  {
    fixture: 'react/root-props/BodyDestructure.front',
    roots: ['div', 'p'],
    rootProps: [
      {tag: 'div', className: 'none', style: 'none', ref: 'none'},
      {tag: 'p', className: 'added', style: 'added', ref: 'author'},
    ],
  },
  {
    fixture: 'react/root-props/ComputedKeys.front',
    roots: ['div'],
    rootProps: [{tag: 'div', className: 'author', style: 'author', ref: 'added'}],
  },
  {
    fixture: 'react/root-props/Destructures.front',
    roots: ['span'],
    props: '__props',
    signature: 'function Destructures(__props: Props) {const { label, className, style: own = {} } = __props;',
    rootProps: [{tag: 'span', className: 'author', style: 'author', ref: 'added'}],
  },
  {
    fixture: 'react/root-props/HelperClash.front',
    roots: ['div'],
    signature: 'import {__frontScopeAttrs as __frontScopeAttrs1, __frontClass as __frontClass1} from',
    rootProps: [{tag: 'div', className: 'merged', style: 'added', ref: 'added'}],
  },
  {
    fixture: 'react/root-props/LeftAlone.front',
    roots: ['div', 'p', 'section'],
    rootProps: [
      {tag: 'div', className: 'merged', style: 'added', ref: 'added'},
      {tag: 'p', className: 'added', style: 'author', ref: 'author'},
      {tag: 'section', className: 'added', style: 'author', ref: 'author'},
    ],
  },
  {
    fixture: 'react/root-props/MemoTyped.front',
    roots: ['div'],
    rootProps: [{tag: 'div', className: 'merged', style: 'added', ref: 'added'}],
    typed: 'memo<{ branch?: string } & X>(function MemoTyped(props)',
  },
  {
    fixture: 'react/root-props/NestedProps.front',
    roots: ['ul'],
    rootProps: [{tag: 'ul', className: 'merged', style: 'added', ref: 'added'}],
  },
  {
    fixture: 'react/root-props/OtherSpread.front',
    roots: ['div'],
    props: '__props',
    signature: 'function OtherSpread(__props) {',
    rootProps: [{tag: 'div', className: 'merged', style: 'added', ref: 'added'}],
  },
  {
    fixture: 'react/root-props/Own.front',
    roots: ['section', 'p'],
    rootProps: [
      {tag: 'section', className: 'merged', style: 'merged', ref: 'merged'},
      {tag: 'p', className: 'merged', style: 'added', ref: 'added'},
    ],
  },
  {
    fixture: 'react/root-props/ReadsProps.front',
    roots: ['div'],
    rootProps: [{tag: 'div', className: 'author', style: 'author', ref: 'added'}],
  },
  {
    fixture: 'react/root-props/SpreadsProps.front',
    roots: ['div'],
    rootProps: [{tag: 'div', className: 'author', style: 'none', ref: 'none'}],
  },
  {
    fixture: 'react/root-props/StringClass.front',
    roots: ['div', 'p', 'span'],
    rootProps: [
      {tag: 'div', className: 'merged', style: 'added', ref: 'added'},
      {tag: 'p', className: 'merged', style: 'added', ref: 'added'},
      {tag: 'span', className: 'author', style: 'added', ref: 'added'},
    ],
  },
  {
    fixture: 'react/root-props/UnionProps.front',
    roots: ['div'],
    rootProps: [{tag: 'div', className: 'merged', style: 'added', ref: 'added'}],
    typed: "function UnionProps(props: ({ kind: 'a' } | { kind: 'b'; note: string }) & X)",
  },
  {
    fixture: 'react/root-props/Valueless.front',
    roots: ['div'],
    props: '__props',
    signature: 'function Valueless(__props) {',
    rootProps: [{tag: 'div', className: 'author', style: 'added', ref: 'added'}],
  },
  {
    fixture: 'react/root-props/WrappedReads.front',
    roots: ['div'],
    rootProps: [{tag: 'div', className: 'author', style: 'author', ref: 'author'}],
  },
  {fixture: 'react/shapes/AndRoot.front', roots: ['p', 'section', 'div']},
  {fixture: 'react/shapes/ArrowExpression.front', roots: ['div']},
  {fixture: 'react/shapes/ComponentRoot.front', roots: ['ArrowExpression']},
  {fixture: 'react/shapes/ConstRoot.front', roots: ['article']},
  {
    fixture: 'react/shapes/Destructured.front',
    roots: ['div'],
    props: '__props',
    signature: 'function Destructured(__props: Props) {const { branch } = __props;',
  },
  {
    fixture: 'react/shapes/DestructuredArrow.front',
    roots: ['p'],
    props: '__props',
    signature: 'export default (__props: { branch?: string }) => {const { branch } = __props; return (',
  },
  {
    fixture: 'react/shapes/DestructuredDefaults.front',
    roots: ['section'],
    props: '__props',
    signature:
      "function DestructuredDefaults(__props: Props = {}) {const {\n    /* shown without a label */\n    label = 'default label',\n    branch,\n    ...rest\n  } = __props;",
    typed: '}: Props & X = {}) {',
  },
  {fixture: 'react/shapes/ExportIdentifier.front', roots: ['div']},
  {
    fixture: 'react/shapes/ForwardRef.front',
    roots: ['div'],
    typed: 'forwardRef<HTMLDivElement, { branch?: string } & X>(function ForwardRef(props, ref)',
  },
  {
    fixture: 'react/shapes/ForwardRefDestructured.front',
    roots: ['div'],
    props: '__props',
    signature: '>((__props, ref) => {const { branch } = __props; return (',
    typed: 'forwardRef<HTMLDivElement, { branch?: string } & X>(({ branch }, ref)',
  },
  {fixture: 'react/shapes/FragmentRoot.front', roots: [], fragments: 2},
  {fixture: 'react/shapes/Memo.front', roots: ['div'], typed: 'memo(function Memo(props: { branch?: string } & X)'},
  {
    fixture: 'react/shapes/MemoForwardRef.front',
    roots: ['div'],
    props: '__props',
    signature: '<HTMLDivElement>((__props, __ref) =>',
    typed: 'React.forwardRef<HTMLDivElement, X>((__props: X) =>',
  },
  {fixture: 'react/shapes/MultiReturn.front', roots: ['section', 'div']},
  {fixture: 'react/shapes/NestedTernary.front', roots: ['div', 'p', 'section']},
  {
    fixture: 'react/shapes/NoParams.front',
    roots: ['div'],
    props: '__props',
    signature: 'function NoParams /* () */ (__props) {',
    typed: 'function NoParams /* () */ (__props: X) {',
  },
  {fixture: 'react/shapes/NullRoot.front', roots: []},
  {fixture: 'react/shapes/Ternary.front', roots: ['div', 'p']},
  // `content` warns at each return naming it; `mixed`, a ternary, never warns.
  {fixture: 'react/fuzz-found/ConstFragment.front', roots: ['div'], fragments: 2},
];

it('has a row for every forwarding/, root-props/, shapes/ and fuzz-found/ fixture', () => {
  const listed = [
    ...listComponents('react/forwarding'),
    ...listComponents('react/root-props'),
    ...listComponents('react/shapes'),
    ...listComponents('react/fuzz-found'),
  ];
  expect(listed).toEqual(SHAPES.map(({fixture}) => fixture));
});

const loadHelper = (code: string) => import(`data:text/javascript,${encodeURIComponent(code)}`);

it('serves the fragment warning in the dev helper only, and the other helpers in both', async () => {
  const dev = await loadHelper(scopeHelperCode(true));
  const production = await loadHelper(scopeHelperCode(false));
  const shared = ['__frontClass', '__frontRef', '__frontScopeAttrs', '__frontStyle', '__frontSvelteClass'];
  expect(Object.keys(dev).sort()).toEqual([...shared, '__frontWarnFragment']);
  expect(Object.keys(production).sort()).toEqual(shared);
  expect(production.__frontScopeAttrs({'data-v-12345678': '', className: 'card', 'data-test': 'x'})).toEqual({
    'data-v-12345678': '',
  });
});

// The block content with each site typed as the editor does it, `X` standing for the root props type.
function markSites(content: string, sites: ReactPropsSite[]): string {
  const inserts = sites.flatMap((site) => propsTypeInserts(site, 'X')).sort((first, second) => second.at - first.at);
  return inserts.reduce((text, {at, text: insert}) => text.slice(0, at) + insert + text.slice(at), content);
}

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
  async ({fixture, roots, props = 'props', fragments = 0, signature, rootProps, typed}) => {
    const pattern = signature?.match(/const ([\s\S]+?) = __props\d*;/)?.[1];
    const {filename, source} = readComponent(fixture);
    const split = splitBlocks(source, filename);
    const block = split.targets.react!;
    const builds = await Promise.all(
      [false, true].map(async (production) => {
        const ctx = await createBuildContext(split, {root: FIXTURES_DIR, compiler, production});
        const {code, map} = getBlockKind('react').build(block, ctx);
        return {code, map: map!, ctx, program: parse(code).program};
      })
    );
    const [dev, production] = builds as [(typeof builds)[0], (typeof builds)[0]];
    const forwarded = ({program}: {program: Program}) => forwardedRoots(program).map(({name}) => nameText(name));
    const helperImport = ({program}: {program: Program}) =>
      program.body
        .filter(isHelperImport)
        .flatMap(({specifiers}) =>
          specifiers.map((spec) =>
            spec.type !== 'ImportSpecifier'
              ? spec.local.name
              : spec.imported.type === 'Identifier'
                ? spec.imported.name
                : spec.imported.value
          )
        );

    it('is a valid fixture whose builds parse', () => {
      expect(checkBlocks(split)).toEqual([]);
      for (const {code} of builds) expect(parse(code).errors).toEqual([]);
    });

    it('matches the dev code snapshot', async () => {
      const code = dev.code.replaceAll(FIXTURES_DIR, '<fixtures>');
      await expect(code).toMatchFileSnapshot(`../__snapshots__/react/scope/${fixture}.tsx.snap`);
    });

    it('only inserts and moves the pattern: without the stamps, the forwarding and the imports, the code is the block content', () => {
      const content = withJsStrings(block.content);
      for (const {code, ctx, program} of builds)
        expect(withoutInjected(code, program).replaceAll(` data-v-${ctx.scopeId}=""`, '')).toBe(content);
    });

    it('forwards the first parameter on every JSX element root, and nowhere else', () => {
      for (const build of builds) {
        expect(forwarded(build)).toEqual(roots);
        const spreads = calls(build.program, '__frontScopeAttrs');
        expect(spreads.map((call) => argumentText(build.code, call))).toEqual(roots.map(() => [props]));
        // Production adds nothing for a fragment root, whose warning is dev only.
        if (signature && (build === dev || roots.length > 0)) expect(build.code).toContain(signature);
        else expect(build.code).not.toMatch(/__props\d*[,:)]/);
      }
    });

    it('warns on each fragment root in dev only, naming the component by its file', () => {
      const warnings = calls(dev.program, '__frontWarnFragment').map((call) => argumentText(dev.code, call));
      expect(warnings).toEqual(Array.from({length: fragments}, () => [props, JSON.stringify(basename(fixture, '.front'))]));
      expect(production.code).not.toContain('__frontWarnFragment');
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

    it('imports exactly the helpers it calls, in a fixed order', () => {
      for (const build of builds)
        expect(helperImport(build)).toEqual(HELPERS.filter((name) => calls(build.program, name).length > 0));
      const forwarding = helperImport(dev).filter((name) => name === '__frontScopeAttrs' || name === '__frontWarnFragment');
      expect(forwarding).toEqual([
        ...(roots.length > 0 ? ['__frontScopeAttrs'] : []),
        ...(fragments > 0 ? ['__frontWarnFragment'] : []),
      ]);
    });

    it('adds, merges or leaves each root prop as the detection rule says', () => {
      if (!rootProps) return;
      for (const {code, program} of builds) {
        const found = forwardedRoots(program).map((opening) => ({
          tag: nameText(opening.name),
          className: rootProp(code, opening, 'className', props),
          style: rootProp(code, opening, 'style', props),
          ref: rootProp(code, opening, 'ref', props),
        }));
        expect(found).toEqual(rootProps);
      }
    });

    it('reactRootProps gives the roots and, per root, the root props the build added or merged', () => {
      const found = reactRootProps(block, filename);
      const taken = forwardedRoots(dev.program).map((opening) => ({
        tag: nameText(opening.name),
        props: (['className', 'style', 'ref'] as const).filter((prop) =>
          ['added', 'merged'].includes(rootProp(dev.code, opening, prop, props))
        ),
      }));
      expect(found?.roots ?? []).toEqual(taken);
      expect(taken.map(({tag}) => tag)).toEqual(roots);
      if (typed) expect(markSites(block.content, found!.sites)).toContain(typed);
    });

    it("adds or merges no ref on a forwardRef component's roots: React hands it the ref as a parameter", () => {
      if (!block.content.includes('forwardRef')) return;
      for (const build of builds)
        for (const opening of forwardedRoots(build.program))
          expect(rootProp(build.code, opening, 'ref', props)).not.toMatch(/added|merged/);
    });
  }
);
