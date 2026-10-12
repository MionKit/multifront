import {readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {checkBlocks, locate, splitBlocks} from '@multifront/core';
import {mergeConfig, type InlineConfig, type Rolldown, type ViteDevServer} from 'vite';
import {beforeAll, describe, expect, it} from 'vitest';
import {copyApp, removeApp} from '../fixtures/index.ts';
import {buildApp, rejection, withDevServer} from './lib/build.ts';
import {expectNoAttribute, resolutionRecorder, ucfPaths} from './lib/references.ts';

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
  (name) => `${name}.ucf.svelte.svelte`
);
// App.svelte's own imports: a bare one, a static and a dynamic one with the attribute, a re-export in `<script module>`.
const APP_IMPORTS = [
  `${COMPONENTS}/Panel.ucf`,
  `${COMPONENTS}/Counter.ucf?framework=svelte`,
  `${COMPONENTS}/imports/UsesIcon.ucf?framework=svelte`,
  `${COMPONENTS}/Card.ucf?framework=svelte`,
];
const APP_TARGETS = ['Card', 'Counter', 'Panel', 'imports/UsesIcon'].map((name) => `/components/${name}.ucf.svelte.svelte`);

const SCRIPT = '<script lang="ts">\n  import Panel from \'../../../components/Panel.ucf\';\n';
const MARKUP = '<Counter start={2} />\n';

/** A client build of `app.ts`, which mounts App.svelte (`main.ts` mounts the 5.3 components). */
function buildImporter(root: string, config: InlineConfig = {}) {
  return buildApp(root, mergeConfig({build: {rolldownOptions: {input: join(root, 'src', 'app.ts')}}}, config));
}

/** A copy of its own whose `App.svelte` also imports `specifier` as `name` and renders it. */
async function withImport(name: string, specifier: string, run: (root: string) => Promise<void>) {
  const root = await copyApp('svelte-vite');
  try {
    const app = join(root, 'src', 'App.svelte');
    const source = await readFile(app, 'utf8');
    if (!source.includes(SCRIPT) || !source.includes(MARKUP)) throw new Error(`App.svelte changed:\n${source}`);
    const edited = source
      .replace(SCRIPT, `${SCRIPT}  import ${name} from ${specifier};\n`)
      .replace(MARKUP, `${MARKUP}<${name} />\n`);
    await writeFile(app, edited);
    await run(root);
  } finally {
    await removeApp(root);
  }
}

describe('imports through plugin-svelte in svelte-vite', () => {
  let root: string;
  let components: string;

  beforeAll(async () => {
    root = await copyApp('svelte-vite');
    components = resolve(root, '..', '..', 'components');
    return () => removeApp(root);
  });

  const ucfIds = (chunks: Rolldown.OutputChunk[]) =>
    chunks.flatMap((chunk) => chunk.moduleIds).filter((id) => id.includes('.ucf') && !id.includes('?'));

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
      expect(ucfIds(chunks).sort()).toEqual(SVELTE_IDS.map((id) => join(components, id)));
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
            .from(`/components/${importer}.ucf.svelte.svelte`)
            .map(({id}) => id)
            .filter((id) => !id.includes('?ucf'))
        );
      expect(inBlock('Panel')).toEqual(new Set(['./PanelItem.ucf']));
      expect(inBlock('imports/UsesIcon')).toEqual(new Set(['./Icon.ucf']));
      const code = chunks.map((chunk) => chunk.code).join('\n');
      for (const marker of SVELTE_MARKERS) expect(code).toContain(marker);
      for (const marker of OTHER_MARKERS) expect(code).not.toContain(marker);
    });
  });

  it('builds the same Svelte targets for SSR, with no attribute', async () => {
    const {chunks} = await buildApp(root, {build: {ssr: join(root, 'src', 'entry-server.ts')}});
    expect(ucfIds(chunks).sort()).toEqual(SVELTE_IDS.map((id) => join(components, id)));
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
        expect(ucfPaths(code).sort()).toEqual(APP_TARGETS);
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

  it('fails each framework attribute in a top-level script of a <svelte> block at its place, in build and dev', async () => {
    await withImport('AttrInSvelte', `'${COMPONENTS}/svelte/imports/AttrInSvelte.ucf'`, async (root) => {
      const file = componentFile(root, 'svelte/imports/AttrInSvelte.ucf');
      const diagnostics = checkBlocks(splitBlocks(await readFile(file, 'utf8'), file));
      expect(diagnostics.map(({code}) => code)).toEqual(['framework-in-block', 'framework-in-block', 'framework-in-block']);
      const [first, ...rest] = diagnostics;
      const loc = {file, line: first!.line, column: first!.column};

      const built = await rejection<Rolldown.BundleError>(buildImporter(root));
      expect(built.message).toContain('(framework-in-block)');
      for (const other of rest) expect(built.message).toContain(`\n${file}:${other.line}:${other.column} `);
      expect(built.errors?.[0]?.loc).toEqual(loc);

      await withDevServer(root, {}, async (server) => {
        const client = await rejection<Rolldown.RollupError>(
          server.environments.client.transformRequest(`${file}.svelte.svelte`)
        );
        expect(client.message).toContain('(framework-in-block)');
        expect(client.loc).toEqual(loc);
        const ssr = await rejection<Rolldown.RollupError>(server.ssrLoadModule('/src/entry-server.ts'));
        expect(ssr.message).toContain('(framework-in-block)');
        expect(ssr.loc).toEqual(loc);
      });
    });
  });

  it('fails a framework attribute of an import() in <svelte> markup at its import, in build and dev', async () => {
    await withImport('AttrInSvelteMarkup', `'${COMPONENTS}/svelte/imports/AttrInSvelteMarkup.ucf'`, async (root) => {
      const file = componentFile(root, 'svelte/imports/AttrInSvelteMarkup.ucf');
      const source = await readFile(file, 'utf8');
      expect(checkBlocks(splitBlocks(source, file))).toEqual([]);
      const loc = {file, ...locate(source, source.indexOf("'../../imports/Icon.ucf'"))};

      const built = await rejection<Rolldown.BundleError>(buildImporter(root));
      expect(built.message).toContain('(framework-in-block)');
      expect(built.errors?.[0]?.loc).toEqual(loc);

      await withDevServer(root, {}, async (server) => {
        const client = await rejection<Rolldown.RollupError>(
          server.environments.client.transformRequest(`${file}.svelte.svelte`)
        );
        expect(client.message).toContain('(framework-in-block)');
        expect(client.loc).toEqual(loc);
        const ssr = await rejection<Rolldown.RollupError>(server.ssrLoadModule('/src/entry-server.ts'));
        expect(ssr.message).toContain('(framework-in-block)');
        expect(ssr.loc).toEqual(loc);
      });
    });
  });

  it.each([
    {
      name: 'ReactOnly',
      path: 'imports/ReactOnly.ucf',
      // Its own module is App.svelte.
      request: () => '/src/App.svelte',
      message:
        '../../../components/imports/ReactOnly.ucf has no <svelte> block; App.svelte imports it as svelte (missing-target-block)',
    },
    {
      name: 'UsesReactOnly',
      path: 'svelte/imports/UsesReactOnly.ucf',
      request: (file: string) => `${file}.svelte.svelte`,
      message: '../../imports/ReactOnly.ucf has no <svelte> block; UsesReactOnly.ucf imports it as svelte (missing-target-block)',
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
