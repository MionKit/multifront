import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';
import {checkBlocks, createBuildContext, loadVueCompiler, splitBlocks} from '@multifront/core';
import {createLogger, createServer, type Rolldown} from 'vite';
import {beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR, componentPath, readComponent} from '../fixtures/index.ts';
import {APP_CONFIG_LOADER, buildApp} from './lib/build.ts';

const ROOT = join(FIXTURES_DIR, 'apps', 'react-basic');
const COMPONENTS = ['react/AllBlocks.ucf', 'imports/Icon.ucf', 'imports/UsesIcon.ucf'];
const REACT_MARKERS = ['all-blocks-react-marker', 'icon-react-marker', 'uses-icon-react-marker'];
const OTHER_MARKERS = ['all-blocks-vue-marker', 'all-blocks-svelte-marker'];

// Like `toThrow`, but returns the error, whose `errors[0]` holds Rolldown's location.
async function buildError(entry: string): Promise<Error & {errors?: {loc?: unknown}[]}> {
  try {
    await buildApp(ROOT, {build: {rolldownOptions: {input: join(ROOT, entry)}}});
  } catch (err) {
    return err as Error;
  }
  throw new Error(`${entry} built`);
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

  it('leaves out the text of the <vue> and <svelte> blocks', () => {
    for (const marker of OTHER_MARKERS) for (const text of [chunk.code, ...css]) expect(text).not.toContain(marker);
  });

  it('puts each style block once in one CSS asset', async () => {
    expect(css).toHaveLength(1);
    const compiler = loadVueCompiler(ROOT);
    for (const name of COMPONENTS) {
      const {filename, source} = readComponent(name);
      const ctx = await createBuildContext(splitBlocks(source, filename), {root: ROOT, compiler, production: true});
      expect(ctx.styles.length).toBeGreaterThan(0);
      for (const style of ctx.styles) {
        const selector = style.code.slice(0, style.code.indexOf('{')).trim();
        expect(css[0]!.split(selector).length - 1, `${name} ${selector}`).toBe(1);
      }
    }
  });

  it('maps a marker in the bundle back to its line in AllBlocks.ucf', () => {
    const marker = REACT_MARKERS[0]!;
    const before = chunk.code.slice(0, chunk.code.indexOf(marker)).split('\n');
    const position = originalPositionFor(new TraceMap(chunk.map! as never), {line: before.length, column: before.at(-1)!.length});
    const {source} = readComponent('react/AllBlocks.ucf');
    expect(position.source).toMatch(/components\/react\/AllBlocks\.ucf$/);
    expect(position.line).toBe(source.slice(0, source.indexOf(marker)).split('\n').length);
  });
});

describe('vite build of the react-basic error entries', () => {
  it('names both files when the imported file has no <react> block', async () => {
    const err = await buildError('src/errors/missing-block.tsx');
    expect(err.message).toContain('(missing-target-block)');
    expect(err.message).toContain(
      '../../../../components/imports/VueOnly.ucf has no <react> block; missing-block.tsx imports it as react'
    );
  });

  it('reports react-no-default-export at its place in the .ucf file', async () => {
    const {filename, source} = readComponent('react/errors/NoDefault.ucf');
    const [diagnostic] = checkBlocks(splitBlocks(source, filename));
    expect(diagnostic?.code).toBe('react-no-default-export');
    const err = await buildError('src/errors/no-default.tsx');
    expect(err.message).toContain('(react-no-default-export)');
    expect(err.message).toContain(`NoDefault.ucf:${diagnostic!.line}:${diagnostic!.column}`);
    expect(err.errors?.[0]?.loc).toEqual({file: filename, line: diagnostic!.line, column: diagnostic!.column});
  });

  it('fails a vue pick with target-not-built', async () => {
    const err = await buildError('src/errors/vue-pick.ts');
    expect(err.message).toContain('multifront does not build <vue> blocks yet (target-not-built)');
  });
});

describe('dev dependency scan of react-basic', () => {
  it('reads the <react> blocks and optimizes their app at startup', async () => {
    const errors: string[] = [];
    const logger = createLogger('silent');
    logger.error = (message) => void errors.push(message);
    const tmp = join(FIXTURES_DIR, '..', '.tmp');
    await mkdir(tmp, {recursive: true});
    const cacheDir = await mkdtemp(join(tmp, 'react-basic-cache-'));
    const server = await createServer({
      root: ROOT,
      configLoader: APP_CONFIG_LOADER,
      cacheDir,
      customLogger: logger,
      server: {middlewareMode: true, ws: false},
    });
    try {
      const optimizer = server.environments.client.depsOptimizer!;
      await optimizer.scanProcessing;
      expect(errors).toEqual([]);
      // A failed scan skips pre-bundling: main.tsx's own imports would be found late too.
      expect(Object.keys(optimizer.metadata.discovered)).toContain('react-dom/client');
    } finally {
      await server.close();
      await rm(cacheDir, {recursive: true, force: true});
    }
  });
});
