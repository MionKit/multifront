// Spec 3.5, item 5: the editor types the root props the build hands a React root, from the same analysis.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR, LIBRARY_DIR} from '../fixtures/index.ts';
import {codesOnLine, edit, PLUGIN} from './lib/cases.ts';
import {inBlock, locate, open, startTsserver} from './lib/tsserver.ts';
import type {Component, TsDefinitions, Tsserver} from './lib/tsserver.ts';

const APP_DIR = join(FIXTURES_DIR, 'apps', 'react-root-props');
const APP: Component = {filename: join(APP_DIR, 'src', 'App.tsx'), source: readFileSync(join(APP_DIR, 'src', 'App.tsx'), 'utf8')};
const BUTTON_FILE = join(LIBRARY_DIR, 'src', 'Button.front');
const BUTTON: Component = {filename: BUTTON_FILE, source: readFileSync(BUTTON_FILE, 'utf8')};
const EXPECT_ERROR = '// @ts-expect-error';
const WRONG_REF = '<Button label="Wrong" ref={divRef} />';
const LAST = `return ${WRONG_REF};\n}`;

// Each probe renders `Probe`, one fixture's default export, appended to App.tsx unsaved. `errors`: codes on its line.
const PROBES: {fixture: string; jsx: string; errors: number[]}[] = [
  {
    fixture: 'library/src/Badge.front',
    jsx: `<Probe label="x" className="a" style={{color: 'red'}} ref={createRef<HTMLSpanElement>()} />`,
    errors: [],
  },
  // Own renders a <section> (an HTMLElement) or a <p>: a ref for either fits, an SVG one does not.
  {fixture: 'components/react/root-props/Own.front', jsx: '<Probe ref={createRef<HTMLElement>()} />', errors: []},
  {fixture: 'components/react/root-props/Own.front', jsx: '<Probe ref={createRef<HTMLParagraphElement>()} />', errors: []},
  {fixture: 'components/react/root-props/Own.front', jsx: '<Probe ref={createRef<SVGSVGElement>()} />', errors: [2322]},
  // The author takes every root prop on a root spreading the props, and a className with no value.
  {fixture: 'components/react/root-props/SpreadsProps.front', jsx: '<Probe className="a" />', errors: [2322]},
  {fixture: 'components/react/root-props/Valueless.front', jsx: '<Probe className="a" />', errors: [2322]},
  {
    fixture: 'components/react/root-props/Valueless.front',
    jsx: '<Probe style={{}} ref={createRef<HTMLDivElement>()} />',
    errors: [],
  },
  // The root props join every member of a union props type.
  {fixture: 'components/react/root-props/UnionProps.front', jsx: '<Probe kind="a" className="a" />', errors: []},
  {fixture: 'components/react/root-props/UnionProps.front', jsx: '<Probe kind="b" note="n" style={{}} />', errors: []},
  {
    fixture: 'components/react/shapes/ForwardRef.front',
    jsx: '<Probe branch="b" className="a" style={{}} ref={createRef<HTMLDivElement>()} />',
    errors: [],
  },
  {
    fixture: 'components/react/root-props/MemoTyped.front',
    jsx: '<Probe className="a" style={{}} ref={createRef<HTMLDivElement>()} />',
    errors: [],
  },
  {fixture: 'components/react/shapes/MemoForwardRef.front', jsx: '<Probe className="a" style={{}} />', errors: []},
  {
    fixture: 'components/react/shapes/Memo.front',
    jsx: '<Probe className="a" style={{}} ref={createRef<HTMLDivElement>()} />',
    errors: [],
  },
  {
    fixture: 'components/react/shapes/NoParams.front',
    jsx: '<Probe className="a" style={{}} ref={createRef<HTMLDivElement>()} />',
    errors: [],
  },
  {fixture: 'components/react/shapes/NoParams.front', jsx: '<Probe ref={createRef<HTMLSpanElement>()} />', errors: [2322]},
  {
    fixture: 'components/react/shapes/DestructuredDefaults.front',
    jsx: '<Probe label="l" className="a" style={{}} />',
    errors: [],
  },
  // A component root's ref is only known as an Element.
  {fixture: 'components/react/shapes/ComponentRoot.front', jsx: '<Probe ref={createRef<Element>()} />', errors: []},
  {fixture: 'components/react/shapes/ComponentRoot.front', jsx: '<Probe ref={createRef<Text>()} />', errors: [2322]},
];

describe('the root props in the React types, in tsserver with our plugin', () => {
  let server: Tsserver;

  beforeAll(async () => {
    server = startTsserver({cwd: APP_DIR, plugins: [PLUGIN]});
    await open(server, [APP]);
  });

  afterAll(async () => {
    await server?.stop();
  });

  it("App.tsx type checks: Button, Badge and Own take className, style and ref; the wrong ref's directive is used", async () => {
    expect(await server.diagnostics(APP.filename)).toEqual([]);
  });

  it('without its directive, the <div> ref on Button is the only error', async () => {
    const revert = await edit(server, APP, EXPECT_ERROR, '// no directive');
    try {
      const diagnostics = await server.diagnostics(APP.filename);
      expect(diagnostics.map(({code}) => code)).toEqual([2322]);
      expect(diagnostics[0]!.start.line).toBe(locate(APP.source, WRONG_REF).line);
    } finally {
      await revert();
    }
  });

  it.each(PROBES)('$fixture: $jsx', async ({fixture, jsx, errors}) => {
    const specifier = join('..', '..', '..', fixture).split('\\').join('/');
    const probe = `import Probe from '${specifier}';\nimport {createRef} from 'react';\nexport const probe = ${jsx};`;
    const edited = APP.source.replace(LAST, `${LAST}\n${probe}`);
    const revert = await edit(server, APP, LAST, `${LAST}\n${probe}`);
    try {
      const diagnostics = await server.diagnostics(APP.filename);
      expect(codesOnLine(diagnostics, locate(edited, jsx).line)).toEqual(errors);
      expect(diagnostics).toHaveLength(errors.length);
    } finally {
      await revert();
    }
  });

  it("definition on <Button still lands in Button.front's <react> block", async () => {
    const definitions = await server.request<TsDefinitions>('definition', {
      file: APP.filename,
      ...locate(APP.source, '<Button', 1),
    });
    expect(definitions).toHaveLength(1);
    expect(inBlock(BUTTON, 'react', definitions[0]!)).toBe(true);
  });
});
