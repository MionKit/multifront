import {readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {checkBlocks, locate, splitBlocks} from '@multifront/core';
import {mergeConfig, type InlineConfig, type Rolldown, type ViteDevServer} from 'vite';
import {beforeAll, describe, expect, it} from 'vitest';
import {svelte, vitePreprocess} from '@sveltejs/vite-plugin-svelte';
import {multifront} from '@multifront/vite';
import {copyApp, removeApp} from '../fixtures/index.ts';
import {buildApp, expectImportError, rejection, withDevServer, withEditedApp} from './lib/build.ts';
import {expectNoAttribute, resolutionRecorder, frontPaths} from './lib/references.ts';

const COMPONENTS = '../../../components';
const SVELTE_MARKERS = ['panel-svelte-marker', 'panel-item-svelte-marker', 'icon-svelte-marker', 'uses-icon-svelte-marker'];
const OTHER_MARKERS = [
  'panel-item-vue-marker',
  'panel-item-react-marker',
  'icon-vue-marker',
  'icon-react-marker',
  'uses-icon-vue-marker',
  'uses-icon-react-marker',
];
// Every component App.svelte reaches, each as its Svelte target.
const SVELTE_IDS = ['Card', 'Counter', 'Panel', 'PanelItem', 'imports/Icon', 'imports/UsesIcon'].map(
  (name) => `${name}.front.svelte.svelte`
);
// App.svelte's own imports: a bare one, a static and a dynamic one with the attribute, a re-export in `<script module>`.
const APP_IMPORTS = [
  `${COMPONENTS}/Panel.front`,
  `${COMPONENTS}/Counter.front?framework=svelte`,
  `${COMPONENTS}/imports/UsesIcon.front?framework=svelte`,
  `${COMPONENTS}/Card.front?framework=svelte`,
];
const APP_TARGETS = ['Card', 'Counter', 'Panel', 'imports/UsesIcon'].map((name) => `/components/${name}.front.svelte.svelte`);

/** `app.ts` mounts App.svelte; `main.ts` mounts the 5.3 components. */
function buildImporter(root: string, config: InlineConfig = {}) {
  return buildApp(root, mergeConfig({build: {rolldownOptions: {input: join(root, 'src', 'app.ts')}}}, config));
}

/** A copy of its own whose `App.svelte` also imports `specifier` as `name` and renders it. */
function withImport(name: string, specifier: string, run: (root: string) => Promise<void>) {
  const edits: [string, string][] = [
    ["  import Panel from '../../../components/Panel.front';\n", `  import ${name} from ${specifier};\n`],
    ['<Counter start={2} />\n', `<${name} />\n`],
  ];
  return withEditedApp('svelte-vite', join('src', 'App.svelte'), edits, run);
}

describe('imports through plugin-svelte in svelte-vite', () => {
  let root: string;
  let components: string;

  beforeAll(async () => {
    root = await copyApp('svelte-vite');
    components = resolve(root, '..', '..', 'components');
    return () => removeApp(root);
  });

  const frontIds = (chunks: Rolldown.OutputChunk[]) =>
    chunks.flatMap((chunk) => chunk.moduleIds).filter((id) => id.includes('.front') && !id.includes('?'));

  describe('vite build', () => {
    const recorder = resolutionRecorder();
    let chunks: Rolldown.OutputChunk[];

    beforeAll(async () => {
      ({chunks} = await buildImporter(root, {plugins: [recorder.plugin]}));
    });

    it("gives App.svelte's bare import the Svelte target, and moves each attribute, which Svelte kept, into the id", () => {
      expect(new Set(recorder.from('/src/App.svelte').map(({id}) => id))).toEqual(
        new Set([...APP_IMPORTS, ...APP_IMPORTS.map((id) => id.split('?')[0]!)])
      );
      expect(frontIds(chunks).sort()).toEqual(SVELTE_IDS.map((id) => join(components, id)));
      for (const chunk of chunks) {
        expectNoAttribute(chunk.code);
        expect(chunk.moduleIds.filter((id) => id.includes('framework='))).toEqual([]);
      }
    });

    it("gives the imports inside a <svelte> block that block's framework, with no attribute", () => {
      // Our resolve asks again with the query dropped; the style sub-requests aside.
      const inBlock = (importer: string) =>
        new Set(
          recorder
            .from(`/components/${importer}.front.svelte.svelte`)
            .map(({id}) => id)
            .filter((id) => !id.includes('?front'))
        );
      expect(inBlock('Panel')).toEqual(new Set(['./PanelItem.front']));
      expect(inBlock('imports/UsesIcon')).toEqual(new Set(['./Icon.front']));
      const code = chunks.map((chunk) => chunk.code).join('\n');
      for (const marker of SVELTE_MARKERS) expect(code).toContain(marker);
      for (const marker of OTHER_MARKERS) expect(code).not.toContain(marker);
    });
  });

  it('builds the same Svelte targets for SSR, with no attribute', async () => {
    const {chunks} = await buildApp(root, {build: {ssr: join(root, 'src', 'entry-server.ts')}});
    expect(frontIds(chunks).sort()).toEqual(SVELTE_IDS.map((id) => join(components, id)));
    for (const chunk of chunks) expectNoAttribute(chunk.code);
    const code = chunks.map((chunk) => chunk.code).join('\n');
    for (const marker of SVELTE_MARKERS) expect(code).toContain(marker);
  });

  describe('dev server', () => {
    const recorder = resolutionRecorder();
    let results: Record<'client' | 'ssr', string>;
    let html: string;

    beforeAll(async () => {
      await withDevServer(root, {plugins: [recorder.plugin]}, async (server: ViteDevServer) => {
        const transform = async (name: 'client' | 'ssr') =>
          (await server.environments[name].transformRequest('/src/App.svelte'))!.code;
        results = {client: await transform('client'), ssr: await transform('ssr')};
        // Inside Vite: a render from this process would load a second Svelte runtime.
        const {render} = (await server.ssrLoadModule('/src/entry-server.ts')) as {render: () => string};
        html = render();
      });
    });

    for (const environment of ['client', 'ssr'] as const) {
      it(`gives App.svelte's imports their Svelte target, the attribute moved into the id and gone (${environment})`, () => {
        const code = results[environment];
        expectNoAttribute(code);
        expect(frontPaths(code).sort()).toEqual(APP_TARGETS);
        expect(recorder.from('/src/App.svelte', environment).map(({id}) => id)).toEqual(expect.arrayContaining(APP_IMPORTS));
      });
    }

    it('renders the Svelte Panel, its Svelte PanelItem and the Svelte Counter on the server', () => {
      expect(html).toMatch(/<section [^>]*data-marker="panel-svelte-marker"/);
      expect(html).toMatch(/<p [^>]*data-marker="panel-item-svelte-marker"[^>]*>first item<\/p>/);
      expect(html).toMatch(/<div data-v-[0-9a-f]+="" class="counter">/);
      for (const marker of OTHER_MARKERS) expect(html).not.toContain(marker);
    });
  });
});

describe('import errors through plugin-svelte', () => {
  const componentFile = (root: string, name: string) => resolve(root, '..', '..', 'components', name);

  // An `import()` in markup falls to the post rewrite of the compiled module, at its specifier.
  it.each([
    {name: 'AttrInSvelte', count: 3, at: undefined},
    {name: 'AttrInSvelteMarkup', count: 0, at: "'../../imports/Icon.front'"},
  ])(
    'fails each framework attribute in the <svelte> block of $name.front at its place, in build and dev',
    async ({name, count, at}) => {
      const path = `svelte/imports/${name}.front`;
      await withImport(name, `'${COMPONENTS}/${path}'`, async (root) => {
        const file = componentFile(root, path);
        const source = await readFile(file, 'utf8');
        const diagnostics = checkBlocks(splitBlocks(source, file));
        expect(diagnostics.map(({code}) => code)).toEqual(Array<string>(count).fill('framework-in-block'));
        const [first, ...rest] = diagnostics;
        const loc = at ? {file, ...locate(source, source.indexOf(at))} : {file, line: first!.line, column: first!.column};
        const built = await expectImportError(root, {
          build: () => buildImporter(root),
          url: `${file}.svelte.svelte`,
          environments: ['client', 'ssr'],
          code: 'framework-in-block',
          loc,
        });
        for (const other of rest) expect(built.message).toContain(`\n${file}:${other.line}:${other.column} `);
      });
    }
  );

  it.each([
    {
      name: 'ReactOnly',
      path: 'imports/ReactOnly.front',
      // Its own module is App.svelte.
      request: () => '/src/App.svelte',
      message:
        '../../../components/imports/ReactOnly.front has no <svelte> block; App.svelte imports it as svelte (missing-target-block)',
    },
    {
      name: 'UsesReactOnly',
      path: 'svelte/imports/UsesReactOnly.front',
      request: (file: string) => `${file}.svelte.svelte`,
      message:
        '../../imports/ReactOnly.front has no <svelte> block; UsesReactOnly.front imports it as svelte (missing-target-block)',
    },
  ])(
    'fails importing a file with no <svelte> block from $name, naming both files, in build and dev',
    async ({name, path, request, message}) => {
      await withImport(name, `'${COMPONENTS}/${path}'`, async (root) => {
        expect((await rejection<Rolldown.BundleError>(buildImporter(root))).message).toContain(message);
        await withDevServer(root, {}, async (server) => {
          const url = request(componentFile(root, path));
          expect((await rejection<Rolldown.RollupError>(server.environments.client.transformRequest(url))).message).toContain(
            message
          );
          expect((await rejection<Rolldown.RollupError>(server.ssrLoadModule('/src/entry-server.ts'))).message).toContain(
            message
          );
        });
      });
    }
  );
});

const PREPROCESSED: InlineConfig = {configFile: false, plugins: [svelte({preprocess: vitePreprocess()}), multifront()]};
const BAD_IMPORT = `import Bad from '${COMPONENTS}/Card.front' with { framework: 'nope' };`;

// `at` starts where the error points, in the importer's own file, as for a `.vue` importer.
describe('.svelte importer errors', () => {
  it.each([
    // Its own `<script module>` re-exports Card.front too.
    {importer: 'App.svelte', code: 'unknown-framework', at: BAD_IMPORT.slice(BAD_IMPORT.indexOf("'"))},
    {
      importer: 'LangLess.svelte',
      code: 'unknown-framework',
      at: `'${COMPONENTS}/Card.front' with`,
      source: `<script>\n  ${BAD_IMPORT}\n</script>\n\n<Bad title="a" />\n`,
    },
    {
      importer: 'NonLiteral.svelte',
      code: 'framework-attribute-not-literal',
      at: 'pick } })',
      source:
        `<script module lang="ts">\n  const pick = 'svelte';\n` +
        `  export const lazy = import('${COMPONENTS}/Card.front', { with: { framework: pick } });\n</script>\n\n<p>lazy</p>\n`,
    },
    // The first in the file, whichever script it is.
    {
      importer: 'ScriptFirst.svelte',
      code: 'unknown-framework',
      at: `'${COMPONENTS}/Card.front' with`,
      source:
        `<script lang="ts">\n  ${BAD_IMPORT}\n</script>\n\n<script module>\n` +
        `  export const lazy = import('${COMPONENTS}/Card.front', { with: { framework: 'worse' } });\n</script>\n\n<Bad title="a" />\n`,
    },
    // Svelte reads the lang-less `<script module>` as TypeScript, the language of the first `lang`.
    {
      importer: 'ModuleTs.svelte',
      code: 'unknown-framework',
      at: `'${COMPONENTS}/Card.front', {`,
      source:
        `<script module>\n  const size: number = 1;\n` +
        `  export const lazy = import('${COMPONENTS}/Card.front', { with: { framework: 'nope' } });\n</script>\n\n` +
        '<script lang="ts">\n  let gap = size;\n</script>\n\n<p>{gap}</p>\n',
    },
    // A preprocessor's map names the file relatively.
    {
      importer: 'Preprocessed.svelte',
      code: 'unknown-framework',
      at: `'${COMPONENTS}/Card.front' with`,
      source: `<script lang="ts">\n  ${BAD_IMPORT}\n</script>\n\n<section><Bad title="a" /></section>\n\n<style lang="scss">\n  $gap: 4px;\n  section {\n    margin: $gap;\n  }\n</style>\n`,
      config: PREPROCESSED,
    },
  ])(
    'fails $code in $importer at the import in that file, in a build with no source maps and in dev',
    async ({importer, code, at, source, config}) => {
      const [name, specifier] = source
        ? [importer.slice(0, -'.svelte'.length), `'./${importer}'`]
        : ['Bad', BAD_IMPORT.slice(BAD_IMPORT.indexOf("'"), -1)];
      await withImport(name, specifier, async (root) => {
        const file = join(root, 'src', importer);
        if (source) await writeFile(file, source);
        const text = await readFile(file, 'utf8');
        const loc = {file, ...locate(text, text.indexOf(at))};
        const build = () => buildImporter(root, config);
        await expectImportError(root, {build, url: `/src/${importer}`, environments: ['client', 'ssr'], code, loc, config});
      });
    }
  );

  it("leaves a .svelte importer that does not parse to plugin-svelte's own error", async () => {
    const source = `<script>\n  import Card from '${COMPONENTS}/Card.front';\n</script>\n\n{#if}\n`;
    await withImport('Broken', "'./Broken.svelte'", async (root) => {
      await writeFile(join(root, 'src', 'Broken.svelte'), source);
      const built = await rejection<Rolldown.BundleError>(buildImporter(root));
      expect(built.errors?.[0]?.plugin).toBe('vite-plugin-svelte:compile');
      await withDevServer(root, {}, async (server) => {
        const err = await rejection<Rolldown.RollupError>(server.environments.client.transformRequest('/src/Broken.svelte'));
        expect(err.plugin).toBe('vite-plugin-svelte:compile');
      });
    });
  });

  it("points a .front component's Svelte compiler error into the .front file, mapped once in the build and the dev server", async () => {
    const source = `<svelte lang="html">
  <script lang="ts">
    let count = $state(0)
    const doubled = $derived(count * 2)
    doubled = 3
  </script>

  <p>{doubled}</p>
</svelte>
`;
    await withImport('Bad', "'./Bad.front'", async (root) => {
      const file = join(root, 'src', 'Bad.front');
      await writeFile(file, source);
      const loc = {file, ...locate(source, source.indexOf('doubled = 3'))};
      const built = await rejection<Rolldown.BundleError>(buildImporter(root));
      expect(built.errors?.[0]).toMatchObject({plugin: 'vite-plugin-svelte:compile', loc});
      expect(built.errors?.[0]?.message).not.toMatch(/\.front\.svelte\.svelte/);
      await withDevServer(root, {}, async (server) => {
        const err = await rejection<Rolldown.RollupError>(
          server.environments.client.transformRequest('/src/Bad.front.svelte.svelte')
        );
        expect(err).toMatchObject({plugin: 'vite-plugin-svelte:compile', loc});
      });
    });
  });
});
