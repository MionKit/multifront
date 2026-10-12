import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {SourceMapConsumer} from 'source-map-js';
import type {RawSourceMap} from 'source-map-js';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {LIBRARY_DIR} from '../fixtures/index.ts';
import {buildFixtureLibrary, specifiersOf, withEditedLibrary} from './lib/library.ts';
import type {BuiltLibrary} from './lib/library.ts';

// One JS file per component with that block and per plain module, `_virtual/` aside.
const EXPECTED_MODULES = {
  vue: ['Badge', 'Button', 'Card', 'Counter', 'Icon', 'Panel', 'Tooltip', 'VueOnly', 'forms/Field', 'index', 'utils/cx'],
  react: [
    'Badge',
    'Button',
    'Card',
    'Counter',
    'Icon',
    'Panel',
    'Tooltip',
    'forms/Field',
    'hooks/useToggle',
    'index',
    'utils/cx',
  ],
};
const OTHER_FRAMEWORKS = {vue: ['react', 'react-dom', 'svelte'], react: ['vue', 'svelte']};

let library: BuiltLibrary;

beforeAll(async () => {
  library = await buildFixtureLibrary();
});

afterAll(async () => {
  await library?.remove();
});

function resultOf(target: 'react' | 'vue') {
  const result = library.results.find((entry) => entry.target === target);
  if (!result) throw new Error(`no ${target} build`);
  return result;
}

function read(target: 'react' | 'vue', file: string): string {
  return readFileSync(join(resultOf(target).outDir, file), 'utf8');
}

function jsFiles(target: 'react' | 'vue'): string[] {
  return resultOf(target).files.filter((file) => file.endsWith('.js'));
}

function lineOf(source: string, text: string, from: number): number {
  const offset = source.indexOf(text, from);
  if (offset === -1) throw new Error(`no ${text}`);
  return source.slice(0, offset).split('\n').length;
}

describe('buildLibrary(): one JS file per component, per target', () => {
  it('builds vue then react, one file per component with that block, and lists the files it skipped', () => {
    expect(library.results.map(({target, packageName}) => [target, packageName])).toEqual([
      ['vue', '@mf-fixture/ui-vue'],
      ['react', '@mf-fixture/ui-react'],
    ]);
    for (const target of ['vue', 'react'] as const) {
      expect(resultOf(target).outDir).toBe(join(library.outDir, target).replaceAll('\\', '/'));
      const modules = jsFiles(target).filter((file) => !file.startsWith('_virtual/'));
      expect(modules, target).toEqual(EXPECTED_MODULES[target].map((name) => `${name}.js`));
    }
    expect(resultOf('react').files).toContain('Card.js');
    expect(resultOf('react').files).toContain('forms/Field.js');
    expect(resultOf('vue').files).toContain('VueOnly.js');
    expect(resultOf('react').files).not.toContain('VueOnly.js');
    expect(resultOf('react').skipped).toEqual(['VueOnly.ucf']);
    expect(resultOf('vue').skipped).toEqual([]);
  });

  it('leaves no .ucf in a file name or an import specifier', () => {
    for (const target of ['vue', 'react'] as const) {
      for (const file of resultOf(target).files) {
        expect(file).not.toContain('.ucf');
        if (!file.endsWith('.js')) continue;
        for (const specifier of specifiersOf(file, read(target, file)))
          expect(specifier, `${target}/${file}`).not.toContain('.ucf');
      }
    }
    expect(specifiersOf('Card.js', read('react', 'Card.js'))).toContain('./Icon.js');
  });

  it("holds no other framework's code", () => {
    for (const target of ['vue', 'react'] as const) {
      for (const file of jsFiles(target)) {
        for (const specifier of specifiersOf(file, read(target, file))) {
          const imported = OTHER_FRAMEWORKS[target].find((name) => specifier === name || specifier.startsWith(`${name}/`));
          expect(imported, `${target}/${file} imports ${specifier}`).toBeUndefined();
        }
      }
    }
  });

  it('imports the peers, never bundles them, and builds for production', () => {
    expect(specifiersOf('Counter.js', read('react', 'Counter.js'))).toContain('react');
    expect(specifiersOf('Card.js', read('react', 'Card.js'))).toContain('react/jsx-runtime');
    expect(specifiersOf('Card.js', read('vue', '_virtual/Card.script.js'))).toContain('vue');
    for (const target of ['vue', 'react'] as const) {
      for (const file of resultOf(target).files.filter((name) => name.endsWith('.map'))) {
        const {sources} = JSON.parse(read(target, file)) as RawSourceMap;
        for (const source of sources) expect(source, `${target}/${file}`).not.toContain('node_modules');
      }
    }
  });

  it('maps a line of the JSX in react/Card.js back into Card.ucf', () => {
    const code = read('react', 'Card.js');
    const consumer = new SourceMapConsumer(JSON.parse(read('react', 'Card.js.map')) as RawSourceMap);
    const offset = code.indexOf('"h2"');
    const before = code.slice(0, offset).split('\n');
    const original = consumer.originalPositionFor({line: before.length, column: before.at(-1)!.length});
    const ucfFile = join(LIBRARY_DIR, 'src', 'Card.ucf');
    expect(resolve(dirname(join(resultOf('react').outDir, 'Card.js.map')), original.source)).toBe(ucfFile);
    const ucf = readFileSync(ucfFile, 'utf8');
    expect(original.line).toBe(lineOf(ucf, '<h2', ucf.indexOf('<react>')));
  });
});

describe('buildLibrary() errors', () => {
  it('fails on an import that is not a peer: a library package has peer dependencies only', async () => {
    const leftPad = "import leftPad from 'left-pad';\n\nexport const cx = (...names: string[]) => leftPad(names.join(' '));\n";
    await withEditedLibrary([{file: 'src/utils/cx.ts', content: leftPad}], async (root) => {
      const build = buildFixtureLibrary(root);
      await expect(build).rejects.toThrow('"left-pad" is imported by src/utils/cx.ts, but it is not a peer dependency of');
      await expect(build).rejects.toThrow('a library package has peer dependencies only');
    });
  });

  it('fails on a component importing a file outside src', async () => {
    const edits = [
      {file: 'shared/tokens.ts', content: "export const accent = 'rgb(1, 2, 3)';\n"},
      {file: 'src/Card.ucf', anchor: '<react>\n', added: "  import '../shared/tokens.js'\n"},
    ];
    await withEditedLibrary(edits, async (root) => {
      await expect(buildFixtureLibrary(root)).rejects.toThrow('shared/tokens.ts is outside src');
    });
  });

  it('fails on a framework no file has a block for', async () => {
    const vueOnly = readFileSync(join(LIBRARY_DIR, 'src', 'VueOnly.ucf'), 'utf8');
    await withEditedLibrary([{file: 'vue-only/VueOnly.ucf', content: vueOnly}], async (root) => {
      const build = buildFixtureLibrary(root, {src: 'vue-only', index: false, frameworks: ['react']});
      await expect(build).rejects.toThrow(/no \.ucf file in .*\/vue-only has a <react> block/);
    });
  });

  it('fails on an index that does not exist', async () => {
    await withEditedLibrary([], async (root) => {
      await expect(buildFixtureLibrary(root, {index: 'src/missing.ts'})).rejects.toThrow(
        'the index src/missing.ts does not exist'
      );
    });
  });

  it('fails on a framework with no library target', async () => {
    await expect(buildFixtureLibrary(LIBRARY_DIR, {frameworks: ['svelte']})).rejects.toThrow(
      "the 'svelte' framework has no library build"
    );
  });
});
