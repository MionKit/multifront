import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';
import react from '@vitejs/plugin-react';
import {SCOPE_HELPER_ID, checkBlocks, createBuildContext, loadVueCompiler, splitBlocks} from '@multifront/core';
import type {BuildContext} from '@multifront/core';
import {multifront} from '@multifront/vite';
import type {MultifrontOptions} from '@multifront/vite';
import {createLogger, createServer, type InlineConfig, type Rolldown, type ViteDevServer} from 'vite';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR, TMP_DIR, componentPath, readComponent} from '../fixtures/index.ts';
import {APP_CONFIG_LOADER, buildApp} from './lib/build.ts';

const ROOT = join(FIXTURES_DIR, 'apps', 'react-basic');
const COMPONENTS = ['react/AllBlocks.ucf', 'imports/Icon.ucf', 'imports/UsesIcon.ucf'];
const REACT_MARKERS = ['all-blocks-react-marker', 'icon-react-marker', 'uses-icon-react-marker'];
const OTHER_MARKERS = ['all-blocks-vue-marker', 'all-blocks-svelte-marker', 'icon-vue-marker', 'uses-icon-vue-marker'];

type BuildError = Error & {errors?: {loc?: unknown}[]};

/** `{}` keeps the app's own `vite.config.ts`. */
function inline(options?: MultifrontOptions): InlineConfig {
  return options ? {configFile: false, plugins: [react(), multifront(options)]} : {};
}

function entry(input: string, options?: MultifrontOptions): InlineConfig {
  return {...inline(options), build: {rolldownOptions: {input: input.startsWith('/') ? input : join(ROOT, input)}}};
}

// Like `toThrow`, but returns the error, whose `errors[0]` holds Rolldown's location.
async function buildError(input: string, options?: MultifrontOptions): Promise<BuildError> {
  try {
    await buildApp(ROOT, entry(input, options));
  } catch (err) {
    return err as BuildError;
  }
  throw new Error(`${input} built`);
}

function diagnosticsOf(name: string) {
  const {filename, source} = readComponent(name);
  return {filename, diagnostics: checkBlocks(splitBlocks(source, filename))};
}

async function contextOf(name: string): Promise<BuildContext> {
  const {filename, source} = readComponent(name);
  return createBuildContext(splitBlocks(source, filename), {root: ROOT, compiler: loadVueCompiler(ROOT), production: true});
}

describe('vite build of react-basic', () => {
  let chunk: Rolldown.OutputChunk;
  let css: string[];

  beforeAll(async () => {
    const result = await buildApp(ROOT, {build: {sourcemap: true}});
    expect(result.chunks).toHaveLength(1);
    chunk = result.chunks[0]!;
    css = result.css;
  });

  it('bundles the React module of every component, Icon reached from UsesIcon with no attribute', () => {
    for (const name of COMPONENTS) expect(chunk.moduleIds).toContain(`${componentPath(name)}.react.tsx`);
    for (const marker of REACT_MARKERS) expect(chunk.code).toContain(marker);
  });

  it('bundles the scope helper once for every forwarding component, without the dev fragment warning', () => {
    expect(chunk.moduleIds).toContain(`\0${SCOPE_HELPER_ID}`);
    expect(chunk.code.split('function __ucfScopeAttrs(').length - 1).toBe(1);
    expect(chunk.code.split('__ucfScopeAttrs(').length - 1).toBeGreaterThan(2);
    expect(chunk.code).not.toContain('__ucfWarnFragment');
  });

  it('leaves out the text of the <vue> and <svelte> blocks', () => {
    for (const marker of OTHER_MARKERS) for (const text of [chunk.code, ...css]) expect(text).not.toContain(marker);
  });

  it('puts each style block once in one CSS asset, and each class map in the bundle', async () => {
    expect(css).toHaveLength(1);
    for (const name of COMPONENTS) {
      const ctx = await contextOf(name);
      expect(ctx.styles.length).toBeGreaterThan(0);
      for (const style of ctx.styles) {
        const selector = style.code.slice(0, style.code.indexOf('{')).trim();
        expect(css[0]!.split(selector).length - 1, `${name} ${selector}`).toBe(1);
        for (const generated of Object.values(style.classes ?? {})) expect(chunk.code).toContain(JSON.stringify(generated));
      }
    }
  });

  it('maps a marker in the bundle back to its line in AllBlocks.ucf', () => {
    const marker = REACT_MARKERS[0]!;
    const before = chunk.code.slice(0, chunk.code.indexOf(marker)).split('\n');
    const position = originalPositionFor(new TraceMap(chunk.map!.toString()), {
      line: before.length,
      column: before.at(-1)!.length,
    });
    const {source} = readComponent('react/AllBlocks.ucf');
    expect(position.source).toMatch(/components\/react\/AllBlocks\.ucf$/);
    expect(position.line).toBe(source.slice(0, source.indexOf(marker)).split('\n').length);
  });
});

describe('vite build of the react-basic error entries', () => {
  it('names both files when the imported file has no <react> block', async () => {
    const err = await buildError('src/errors/missing-block.tsx');
    expect(err.message).toContain(
      '../../../../components/imports/VueOnly.ucf has no <react> block; missing-block.tsx imports it as react (missing-target-block)'
    );
  });

  it('reports react-no-default-export at its place in the .ucf file', async () => {
    const {filename, diagnostics} = diagnosticsOf('react/errors/NoDefault.ucf');
    const [diagnostic] = diagnostics;
    expect(diagnostic?.code).toBe('react-no-default-export');
    const err = await buildError('src/errors/no-default.tsx');
    expect(err.message).toContain('(react-no-default-export)');
    expect(err.message).toContain(`NoDefault.ucf:${diagnostic!.line}:${diagnostic!.column}`);
    expect(err.errors?.[0]?.loc).toEqual({file: filename, line: diagnostic!.line, column: diagnostic!.column});
  });

  it('lists every error of the block, one file:line:column line each', async () => {
    const {filename, diagnostics} = diagnosticsOf('react/errors/TwoSyntaxErrors.ucf');
    expect(diagnostics.map(({code}) => code)).toEqual(['react-syntax-error', 'react-syntax-error']);
    const [first, second] = diagnostics;
    const err = await buildError('src/errors/two-syntax-errors.tsx');
    expect(err.message).toContain(`${first!.message} (react-syntax-error)`);
    expect(err.message).toContain(`\n${filename}:${second!.line}:${second!.column} ${second!.message} (react-syntax-error)`);
    expect(err.errors?.[0]?.loc).toEqual({file: filename, line: first!.line, column: first!.column});
  });

  it.each([
    ['style-lang.tsx', 'invalid/UnknownStyleLang.ucf', 'unknown-style-lang'],
    ['style-syntax.tsx', 'invalid/CssSyntaxError.ucf', 'style-compile-error'],
  ])('%s: the style module reports its block errors', async (file, name, code) => {
    const err = await buildError(`src/errors/${file}`);
    expect(err.message).toContain(`(${code})`);
    const ctx = await contextOf(name);
    const expected = [...checkBlocks(ctx.split), ...ctx.styles.flatMap((style) => style.errors)]
      .filter((diagnostic) => diagnostic.code === code)
      .map(({line, column}) => ({file: ctx.filename, line, column}));
    expect(expected).toContainEqual(err.errors?.[0]?.loc);
  });

  it('fails a svelte pick with target-not-built', async () => {
    const err = await buildError('src/errors/svelte-pick.ts');
    expect(err.message).toContain('multifront does not build <svelte> blocks yet (target-not-built)');
  });

  it('fails a vue pick without plugin-vue, naming the import and its importer', async () => {
    const err = await buildError('src/errors/vue-pick.ts');
    const importer = join(ROOT, 'src/errors/vue-pick.ts');
    expect(err.message).toContain(
      `AllBlocks.ucf (imported by ${importer}): the vue target needs @vitejs/plugin-vue in your Vite plugins`
    );
  });

  it('names the import and its importer on a resolveTarget error', async () => {
    const err = await buildError('src/errors/unknown-pick.ts');
    expect(err.message).toContain(`AllBlocks.ucf (imported by ${join(ROOT, 'src/errors/unknown-pick.ts')}): unknown framework`);
    expect(err.message).toContain('(unknown-framework)');
  });
});

describe('vite build with the plugin options', () => {
  it('needs the importers option for a .ts importer', async () => {
    expect((await buildError('src/plain.ts')).message).toContain('(no-target)');
    const {chunks} = await buildApp(ROOT, entry('src/plain.ts', {importers: {'.ts': 'react'}}));
    expect(chunks.flatMap((chunk) => chunk.moduleIds)).toContain(`${componentPath('react/AllBlocks.ucf')}.react.tsx`);
  });

  it('builds a .ucf entry, which has no importer, with the framework option', async () => {
    const input = componentPath('react/AllBlocks.ucf');
    expect((await buildError(input)).message).toContain(`${input} (imported by a build entry): `);
    const {chunks} = await buildApp(ROOT, entry(input, {framework: 'react'}));
    expect(chunks.flatMap((chunk) => chunk.moduleIds)).toContain(`${input}.react.tsx`);
  });

  it('names the file alone when a .ucf entry has no such block', async () => {
    const input = componentPath('imports/VueOnly.ucf');
    const err = await buildError(input, {framework: 'react'});
    expect(err.message).toContain(`${input} has no <react> block (missing-target-block)`);
  });

  it('splits a changed file again under the same plugin instance', async () => {
    await mkdir(TMP_DIR, {recursive: true});
    const root = await mkdtemp(join(TMP_DIR, 'react-cache-'));
    try {
      const plugins = [react(), multifront()];
      const write = (marker: string) =>
        writeFile(join(root, 'Card.ucf'), `<react>\n  export default () => <p>${marker}</p>\n</react>\n`);
      await writeFile(join(root, 'main.tsx'), "import Card from './Card.ucf';\nconsole.log(Card);\n");
      const build = async () => {
        const config = {configFile: false as const, plugins, build: {rolldownOptions: {input: join(root, 'main.tsx')}}};
        return (await buildApp(root, config)).chunks[0]!.code;
      };
      await write('first-cache-marker');
      expect(await build()).toContain('first-cache-marker');
      await write('second-cache-marker');
      const code = await build();
      expect(code).toContain('second-cache-marker');
      expect(code).not.toContain('first-cache-marker');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});

describe('dev server of react-basic', () => {
  const errors: string[] = [];
  let cacheDir: string | undefined;
  let server: ViteDevServer | undefined;

  beforeAll(async () => {
    const logger = createLogger('silent');
    logger.error = (message) => void errors.push(message);
    await mkdir(TMP_DIR, {recursive: true});
    cacheDir = await mkdtemp(join(TMP_DIR, 'react-basic-cache-'));
    server = await createServer({
      root: ROOT,
      configLoader: APP_CONFIG_LOADER,
      cacheDir,
      customLogger: logger,
      server: {middlewareMode: true, ws: false},
      // Every entry but the one whose block does not parse: the scanner rightly fails on that one.
      optimizeDeps: {
        entries: ['index.html', 'src/plain.ts', 'src/errors/*-pick.ts', 'src/errors/{missing-block,no-default,style-*}.tsx'],
      },
    });
  });

  afterAll(async () => {
    try {
      // Vite's close never settles while its first crawl is running, with or without multifront.
      await server?.environments.client.waitForRequestsIdle();
      await server?.close();
    } finally {
      if (cacheDir) await rm(cacheDir, {recursive: true, force: true});
    }
  });

  it('scans the <react> blocks and leaves every other pick to the build', async () => {
    const optimizer = server!.environments.client.depsOptimizer!;
    await optimizer.scanProcessing;
    expect(errors).toEqual([]);
    // A failed scan skips pre-bundling: main.tsx's own imports would be found late too.
    expect(Object.keys(optimizer.metadata.discovered)).toContain('react-dom/client');
  });

  it('serves the React module at the URL it writes into the importer', async () => {
    const client = server!.environments.client;
    const main = await client.transformRequest('/src/main.tsx');
    const url = /from "([^"]+AllBlocks\.ucf\.react\.tsx)"/.exec(main!.code)?.[1];
    expect(url).toBeDefined();
    expect((await client.transformRequest(url!))?.code).toContain(REACT_MARKERS[0]);
    // The watched `.ucf` file is an edge to the real file, not one more import of the React module.
    const module = await client.moduleGraph.getModuleByUrl(url!);
    expect([...module!.importedModules].map(({id}) => id)).toContain(componentPath('react/AllBlocks.ucf'));
  });

  it('answers a request for the Vue id, with no plugin-vue in the app, with the plugin-vue error', async () => {
    const client = server!.environments.client;
    const file = componentPath('react/AllBlocks.ucf');
    await expect(client.transformRequest(`/@fs${file}`)).rejects.toThrow(
      `${file}: the vue target needs @vitejs/plugin-vue in your Vite plugins`
    );
  });
});
