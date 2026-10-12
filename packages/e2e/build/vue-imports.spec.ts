import {readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {checkBlocks, locate, splitBlocks} from '@multifront/core';
import type {Rolldown, ViteDevServer} from 'vite';
import {beforeAll, describe, expect, it} from 'vitest';
import {copyApp, removeApp} from '../fixtures/index.ts';
import {buildApp, rejection, withDevServer} from './lib/build.ts';
import {expectNoAttribute, resolutionRecorder, ucfPaths} from './lib/references.ts';

const COUNTER = '../../../components/Counter.ucf';
const USES_ICON = '../../../components/imports/UsesIcon.ucf';
const VUE_MARKERS = ['icon-vue-marker', 'uses-icon-vue-marker'];
const OTHER_MARKERS = ['icon-react-marker', 'uses-icon-react-marker', 'icon-svelte-marker', 'uses-icon-svelte-marker'];

/** A copy of its own whose `App.vue` also imports `specifier` as `name` and renders it. */
async function withImport(name: string, specifier: string, run: (root: string) => Promise<void>) {
  const root = await copyApp('vue');
  try {
    const app = join(root, 'src', 'App.vue');
    const source = await readFile(app, 'utf8');
    const script = "import Plain from './Plain.vue';\n";
    const template = '  <Plain />\n';
    if (!source.includes(script) || !source.includes(template)) throw new Error(`App.vue changed:\n${source}`);
    // Rendered, as TypeScript drops an import nothing uses.
    const edited = source
      .replace(script, `${script}import ${name} from ${specifier};\n`)
      .replace(template, `${template}  <${name} />\n`);
    await writeFile(app, edited);
    await run(root);
  } finally {
    await removeApp(root);
  }
}

describe('imports through plugin-vue in the vue app', () => {
  let root: string;
  let components: string;

  beforeAll(async () => {
    root = await copyApp('vue');
    components = resolve(root, '..', '..', 'components');
    return () => removeApp(root);
  });

  describe('vite build', () => {
    const recorder = resolutionRecorder();
    let chunks: Rolldown.OutputChunk[];

    beforeAll(async () => {
      ({chunks} = await buildApp(root, {plugins: [recorder.plugin]}));
    });

    it('gives a bare import in App.vue the Vue target', () => {
      const ids = chunks.flatMap((chunk) => chunk.moduleIds);
      for (const name of ['Counter.ucf', 'imports/UsesIcon.ucf', 'imports/Icon.ucf'])
        expect(ids).toContain(join(components, name));
      expect(ids.filter((id) => id.includes('.ucf.'))).toEqual([]);
      const app = recorder.from('/src/App.vue');
      expect(app.map(({id}) => id)).toContain(COUNTER);
      expect(app.every(({query}) => query.startsWith('vue&type=script'))).toBe(true);
    });

    it('moves with { framework } in App.vue, which plugin-vue kept, into the id; none is left in the output', () => {
      expect(recorder.from('/src/App.vue').map(({id}) => id)).toContain(`${USES_ICON}?framework=vue`);
      for (const chunk of chunks) {
        expectNoAttribute(chunk.code);
        expect(chunk.moduleIds.filter((id) => id.includes('framework='))).toEqual([]);
      }
    });

    it('builds the Vue Icon UsesIcon.ucf imports with no attribute', () => {
      // Its own style sub-requests aside.
      const imports = recorder.from('/imports/UsesIcon.ucf').filter(({id}) => !id.includes('?vue'));
      expect(new Set(imports.map(({id, query}) => `${id} from ?${query}`))).toEqual(
        new Set(['./Icon.ucf from ?vue&type=script&setup=true&lang.ts'])
      );
      const code = chunks.map((chunk) => chunk.code).join('\n');
      for (const marker of VUE_MARKERS) expect(code).toContain(marker);
      for (const marker of OTHER_MARKERS) expect(code).not.toContain(marker);
    });
  });

  describe('dev server', () => {
    const recorder = resolutionRecorder();
    let results: Record<'client' | 'ssr', {app: string; usesIcon: string}>;
    let html: string;

    beforeAll(async () => {
      await withDevServer(root, {plugins: [recorder.plugin]}, async (server: ViteDevServer) => {
        const transform = async (name: 'client' | 'ssr') => ({
          app: (await server.environments[name].transformRequest('/src/App.vue'))!.code,
          usesIcon: (await server.environments[name].transformRequest(`/@fs${join(components, 'imports/UsesIcon.ucf')}`))!.code,
        });
        results = {client: await transform('client'), ssr: await transform('ssr')};
        const {render} = (await server.ssrLoadModule('/src/entry-server.ts')) as {render: () => Promise<string>};
        html = await render();
      });
    });

    for (const environment of ['client', 'ssr'] as const) {
      it(`gives App.vue's imports the Vue target, the attribute moved into the id and gone (${environment})`, () => {
        const {app, usesIcon} = results[environment];
        expectNoAttribute(app);
        expect(ucfPaths(app).sort()).toEqual([
          '/components/Counter.ucf',
          '/components/imports/UsesIcon.ucf',
          '/components/vue/VBind.ucf',
        ]);
        const ids = recorder.from('/src/App.vue', environment).map(({id}) => id);
        expect(ids).toEqual(expect.arrayContaining([COUNTER, `${USES_ICON}?framework=vue`]));
        expect(ucfPaths(usesIcon).filter((path) => !path.endsWith('UsesIcon.ucf'))).toEqual(['/components/imports/Icon.ucf']);
      });
    }

    it('renders the Vue Icon inside UsesIcon on the server', () => {
      expect(html).toMatch(
        /<span class="uses-icon"><svg [^>]*aria-label="icon-vue-marker"[^>]*>.*<\/svg> uses-icon-vue-marker<\/span>/s
      );
      expect(html).toMatch(/<div class="counter" data-v-[0-9a-f]+>/);
      for (const marker of OTHER_MARKERS) expect(html).not.toContain(marker);
    });
  });
});

describe('import errors through plugin-vue', () => {
  it.each(['AttrInside', 'AttrInsideJs'])(
    'fails a framework attribute inside the <vue> block of %s.ucf at its place, in build and dev',
    async (name) => {
      await withImport(name, `'../../../components/vue/${name}.ucf'`, async (root) => {
        const file = resolve(root, '..', '..', 'components', 'vue', `${name}.ucf`);
        const diagnostics = checkBlocks(splitBlocks(await readFile(file, 'utf8'), file));
        expect(new Set(diagnostics.map(({code}) => code))).toEqual(new Set(['framework-in-block']));
        const [first, ...rest] = diagnostics;
        const loc = {file, line: first!.line, column: first!.column};

        const built = await rejection<Rolldown.BundleError>(buildApp(root));
        expect(built.message).toContain('(framework-in-block)');
        for (const other of rest) expect(built.message).toContain(`\n${file}:${other.line}:${other.column} `);
        expect(built.errors?.[0]?.loc).toEqual(loc);

        await withDevServer(root, {}, async (server) => {
          const client = await rejection<Rolldown.RollupError>(server.environments.client.transformRequest(`/@fs${file}`));
          expect(client.message).toContain('(framework-in-block)');
          expect(client.loc).toEqual(loc);
          const ssr = await rejection<Rolldown.RollupError>(server.ssrLoadModule('/src/entry-server.ts'));
          expect(ssr.message).toContain('(framework-in-block)');
          expect(ssr.loc).toEqual(loc);
        });
      });
    }
  );

  it('fails importing ReactOnly.ucf from App.vue, naming both files, in build and dev', async () => {
    await withImport('ReactOnly', "'../../../components/imports/ReactOnly.ucf'", async (root) => {
      const message =
        '../../../components/imports/ReactOnly.ucf has no <vue> block; App.vue imports it as vue (missing-target-block)';
      expect((await rejection<Rolldown.BundleError>(buildApp(root))).message).toContain(message);
      await withDevServer(root, {}, async (server) => {
        const client = await rejection<Rolldown.RollupError>(server.environments.client.transformRequest('/src/App.vue'));
        expect(client.message).toContain(message);
        expect((await rejection<Rolldown.RollupError>(server.ssrLoadModule('/src/entry-server.ts'))).message).toContain(message);
      });
    });
  });

  // `at` starts where the error points. App.vue and NonLiteral.vue are `lang="ts"`: a build compiles their script apart.
  it.each([
    {importer: 'App.vue', code: 'unknown-framework', at: `'${COUNTER}' with`},
    {
      importer: 'LangLess.vue',
      code: 'unknown-framework',
      at: `'${COUNTER}' with`,
      source: `<script setup>\nimport Bad from '${COUNTER}' with { framework: 'nope' };\n</script>\n\n<template>\n  <Bad />\n</template>\n`,
    },
    {
      importer: 'NonLiteral.vue',
      code: 'framework-attribute-not-literal',
      at: 'pick } })',
      source:
        `<script setup lang="ts">\nimport {defineAsyncComponent} from 'vue';\n\nconst pick = 'vue';\n` +
        `const Lazy = defineAsyncComponent(() => import('${COUNTER}', { with: { framework: pick } }));\n</script>\n\n` +
        '<template>\n  <Lazy />\n</template>\n',
    },
  ])(
    'fails $code in $importer at the import in that file, in a build with no source maps',
    async ({importer, code, at, source}) => {
      const [name, specifier] = source
        ? [importer.slice(0, -'.vue'.length), `'./${importer}'`]
        : ['Bad', `'${COUNTER}' with { framework: 'nope' }`];
      await withImport(name, specifier, async (root) => {
        const file = join(root, 'src', importer);
        if (source) await writeFile(file, source);
        const text = await readFile(file, 'utf8');
        const loc = {file, ...locate(text, text.indexOf(at))};

        const built = await rejection<Rolldown.BundleError>(buildApp(root));
        expect(built.message).toContain(`(${code})`);
        expect(built.errors?.[0]?.loc).toEqual(loc);

        await withDevServer(root, {}, async (server) => {
          const client = await rejection<Rolldown.RollupError>(server.environments.client.transformRequest(`/src/${importer}`));
          expect(client.message).toContain(`(${code})`);
          expect(client.loc).toEqual(loc);
        });
      });
    }
  );
});
