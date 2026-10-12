import {readFileSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {SourceMapConsumer} from 'source-map-js';
import type {RawSourceMap} from 'source-map-js';
import {buildLibrary} from '@multifront/vite';
import type {LibraryOptions, LibraryResult} from '@multifront/vite';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {LIBRARY_DIR} from '../fixtures/index.ts';
import {buildFixtureLibrary, parseOutput, readOutput, resultOf, specifiersOf, withEditedLibrary} from './lib/library.ts';
import type {BuiltLibrary} from './lib/library.ts';

// Components with that block and plain modules; sub-modules and virtual modules under `_virtual/`.
const VIRTUAL = '_virtual/';
const EXPECTED_JS = {
  vue: ['Badge', 'Button', 'Card', 'Counter', 'Icon', 'Panel', 'Tooltip', 'VueOnly', 'forms/Field', 'index', 'utils/cx'].concat(
    ['Badge.script', 'Button.module-0', 'Button.script', 'Card.module-0', 'Card.script', 'Counter.script', 'Panel.script']
      .concat(['Tooltip.script', 'VueOnly.script', 'forms/Field.script', 'plugin-vue/export-helper'])
      .map((name) => VIRTUAL + name)
  ),
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
  ].concat(['Button.module-0', 'Card.module-0', 'multifront/scope-attrs'].map((name) => VIRTUAL + name)),
};
const OTHER_FRAMEWORKS = {vue: ['react', 'react-dom', 'svelte'], react: ['vue', 'svelte']};

let library: BuiltLibrary;

beforeAll(async () => {
  library = await buildFixtureLibrary();
});

afterAll(async () => {
  await library?.remove();
});

function output(target: 'react' | 'vue'): LibraryResult {
  return resultOf(library.results, target);
}

function read(target: 'react' | 'vue', file: string): string {
  return readOutput(output(target), file);
}

function jsFiles(target: 'react' | 'vue'): string[] {
  return output(target).files.filter((file) => file.endsWith('.js'));
}

describe('buildLibrary(): one JS file per component, per target', () => {
  it('builds vue then react, one file per component with that block, and lists the files it skipped', () => {
    expect(library.results.map(({target, packageName}) => [target, packageName])).toEqual([
      ['vue', '@mf-fixture/ui-vue'],
      ['react', '@mf-fixture/ui-react'],
    ]);
    for (const target of ['vue', 'react'] as const) {
      expect(output(target).outDir).toBe(join(library.outDir, target).replaceAll('\\', '/'));
      expect(jsFiles(target), target).toEqual(EXPECTED_JS[target].map((name) => `${name}.js`).sort());
    }
    expect(output('react').skipped).toEqual(['VueOnly.ucf']);
    expect(output('vue').skipped).toEqual([]);
  });

  it('leaves no .ucf in a file name or an import specifier', () => {
    for (const target of ['vue', 'react'] as const) {
      for (const file of output(target).files) {
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
      for (const file of output(target).files.filter((name) => name.endsWith('.map'))) {
        const {sources} = JSON.parse(read(target, file)) as RawSourceMap;
        for (const source of sources) expect(source, `${target}/${file}`).not.toContain('node_modules');
      }
    }
  });

  it('ships the root-prop helpers once, under _virtual/, imported by the components that merge', () => {
    const helper = '_virtual/multifront/scope-attrs.js';
    const importedFromHelper = (file: string) =>
      parseOutput(file, read('react', file))
        .module.staticImports.filter((entry) => entry.moduleRequest.value === `./${helper}`)
        .flatMap((entry) => entry.entries.map(({importName}) => importName.name));
    // Button merges its own className and style; Badge handles className itself.
    expect(importedFromHelper('Button.js')).toEqual(expect.arrayContaining(['__ucfClass', '__ucfStyle']));
    expect(importedFromHelper('Badge.js')).not.toContain('__ucfClass');
    for (const file of jsFiles('react')) {
      const defines = /function __ucf\w+\(/.test(read('react', file));
      expect({file, defines}).toEqual({file, defines: file === helper});
    }
  });

  it('maps the JSX in react/Card.js back to its line in Card.ucf', () => {
    const code = read('react', 'Card.js');
    const consumer = new SourceMapConsumer(JSON.parse(read('react', 'Card.js.map')) as RawSourceMap);
    // One JSX element's output lines all map to one source line; `return` maps to a line of its own.
    const offset = code.indexOf('return /* @__PURE__ */ jsxs("article"');
    const before = code.slice(0, offset).split('\n');
    const original = consumer.originalPositionFor({line: before.length, column: before.at(-1)!.length});
    const ucfFile = join(LIBRARY_DIR, 'src', 'Card.ucf');
    expect(resolve(dirname(join(output('react').outDir, 'Card.js.map')), original.source)).toBe(ucfFile);
    const ucf = readFileSync(ucfFile, 'utf8');
    expect(original.line).toBe(ucf.slice(0, ucf.indexOf('return (', ucf.indexOf('<react>'))).split('\n').length);
  });
});

describe('buildLibrary() defaults', () => {
  it('builds only the frameworks some file has a block for, with the index of its own src', async () => {
    const vueOnly = readFileSync(join(LIBRARY_DIR, 'src', 'VueOnly.ucf'), 'utf8');
    const edits = [
      {file: 'lib/VueOnly.ucf', content: vueOnly},
      {file: 'lib/index.ts', content: "export {default as VueOnly} from './VueOnly.ucf';\n"},
    ];
    await withEditedLibrary(edits, async (root) => {
      const built = await buildFixtureLibrary(root, {src: 'lib'});
      try {
        expect(built.results.map(({target}) => target)).toEqual(['vue']);
        expect(built.results[0]!.files).toContain('index.js');
      } finally {
        await built.remove();
      }
    });
  });

  it('names a package after packages[framework].name, which a library with no package name needs', async () => {
    await withEditedLibrary([{file: 'package.json', content: '{"type": "module"}\n'}], async (root) => {
      const built = await buildFixtureLibrary(root, {frameworks: ['vue'], packages: {vue: {name: '@acme/ui-vue'}}});
      try {
        expect(built.results.map(({packageName}) => packageName)).toEqual(['@acme/ui-vue']);
      } finally {
        await built.remove();
      }
      await expect(buildFixtureLibrary(root)).rejects.toThrow('package.json has no name; set packages.vue.name');
    });
  });

  it('merges the vite option into the build, builds a framework named twice once, and empties its folder first', async () => {
    const button = readFileSync(join(LIBRARY_DIR, 'src', 'Button.ucf'), 'utf8');
    const reactImport = "import type { MouseEventHandler } from 'react'\n  import { cx } from './utils/cx.js'";
    if (!button.includes(reactImport)) throw new Error('Button.ucf changed');
    const aliased = button.replace(reactImport, reactImport.replace('./utils/cx.js', '~/utils/cx.js'));
    await withEditedLibrary([{file: 'src/Button.ucf', content: aliased}], async (root) => {
      const options: LibraryOptions = {
        frameworks: ['react', 'react'],
        index: false,
        // An alias only Vite knows never reaches tsc.
        dts: false,
        vite: {logLevel: 'silent', resolve: {alias: {'~': join(root, 'src')}}, build: {sourcemap: false}},
      };
      const built = await buildFixtureLibrary(root, options);
      try {
        expect(built.results.map(({target}) => target)).toEqual(['react']);
        const [{outDir, files}] = built.results as [LibraryResult];
        expect(files.filter((file) => file.endsWith('.map') || file === 'index.js')).toEqual([]);
        // The alias into src passes the peer-only guard and becomes a relative import.
        expect(specifiersOf('Button.js', readFileSync(join(outDir, 'Button.js'), 'utf8'))).toContain('./utils/cx.js');
        await writeFile(join(outDir, 'stale.js'), 'export {};\n');
        const [again] = await buildLibrary({...options, root, outDir: built.outDir});
        expect(again!.files).toEqual(files);
      } finally {
        await built.remove();
      }
    });
  });
});

describe('buildLibrary() and NODE_ENV', () => {
  it("builds for production while other library builds overlap, then puts back the caller's NODE_ENV", async () => {
    expect(process.env.NODE_ENV).toBe('test');
    // The short build starts first and ends first, in the middle of the long one.
    const [short, long] = await Promise.all([buildFixtureLibrary(LIBRARY_DIR, {frameworks: ['react']}), buildFixtureLibrary()]);
    try {
      expect(process.env.NODE_ENV).toBe('test');
      for (const {results} of [short, long]) {
        const react = results.find(({target}) => target === 'react')!;
        const code = readFileSync(join(react.outDir, 'Card.js'), 'utf8');
        expect(specifiersOf('Card.js', code)).toContain('react/jsx-runtime');
      }
    } finally {
      await short.remove();
      await long.remove();
    }
  });
});

describe('buildLibrary() errors', () => {
  it('fails on an import that is not a peer, and keeps it external once packages[framework].peers names it', async () => {
    const leftPad =
      "import leftPad from 'left-pad';\n\nexport const cx = (...names: (string | undefined)[]) => leftPad(names.filter(Boolean).join(' '));\n";
    // Its types, as a library with an untyped peer would declare them.
    const leftPadTypes = "declare module 'left-pad' {\n  export default function leftPad(text: string): string;\n}\n";
    const edits = [
      {file: 'src/utils/cx.ts', content: leftPad},
      {file: 'src/left-pad.d.ts', content: leftPadTypes},
    ];
    await withEditedLibrary(edits, async (root) => {
      const build = buildFixtureLibrary(root);
      await expect(build).rejects.toThrow('"left-pad" is imported by src/utils/cx.ts, but it is not a peer dependency of');
      await expect(build).rejects.toThrow('a library package has peer dependencies only');
      expect(process.env.NODE_ENV).toBe('test');
      const peers = {'left-pad': '^1.3.0'};
      const built = await buildFixtureLibrary(root, {packages: {vue: {peers}, react: {peers}}});
      try {
        for (const {outDir} of built.results) {
          expect(specifiersOf('cx.js', readFileSync(join(outDir, 'utils', 'cx.js'), 'utf8'))).toEqual(['left-pad']);
        }
      } finally {
        await built.remove();
      }
    });
  });

  it('fails on a component importing a file outside src', async () => {
    const card = readFileSync(join(LIBRARY_DIR, 'src', 'Card.ucf'), 'utf8');
    const edits = [
      {file: 'shared/tokens.ts', content: "export const accent = 'rgb(1, 2, 3)';\n"},
      {file: 'src/Card.ucf', content: card.replace('<react>\n', "<react>\n  import '../shared/tokens.js'\n")},
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

  it('fails when no file has a block for a framework with a library build', async () => {
    const svelteOnly = '<svelte>\n  <p>svelte only</p>\n</svelte>\n';
    await withEditedLibrary([{file: 'svelte-only/SvelteOnly.ucf', content: svelteOnly}], async (root) => {
      await expect(buildFixtureLibrary(root, {src: 'svelte-only', index: false})).rejects.toThrow(
        /nothing to build, no \.ucf file in .*\/svelte-only has a block for a framework with a library build/
      );
    });
  });

  it('fails on a package.json that does not parse, not on a missing name', async () => {
    await withEditedLibrary([{file: 'package.json', content: '{"name": \n'}], async (root) => {
      await expect(buildFixtureLibrary(root)).rejects.toThrow(/cannot read .*package\.json: /);
    });
  });

  it('fails on two modules that would be written to one file', async () => {
    const index = readFileSync(join(LIBRARY_DIR, 'src', 'index.ts'), 'utf8');
    const edits = [
      {file: 'src/Badge.ts', content: "export const tone = 'info';\n"},
      {file: 'src/index.ts', content: `${index}export {tone} from './Badge.js';\n`},
    ];
    await withEditedLibrary(edits, async (root) => {
      await expect(buildFixtureLibrary(root)).rejects.toThrow(
        /src\/Badge\.(ucf|ts) and src\/Badge\.(ucf|ts) would both be written as Badge\.js/
      );
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
    await withEditedLibrary([], async (root) => {
      await expect(buildFixtureLibrary(root, {frameworks: ['svelte']})).rejects.toThrow(
        "the 'svelte' framework has no library build"
      );
    });
  });
});
