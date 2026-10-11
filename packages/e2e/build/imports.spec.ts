import {readdirSync, readFileSync} from 'node:fs';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {checkBlocks, createBuildContext, loadVueCompiler, locate, rewriteImportAttributes, splitBlocks} from '@multifront/core';
import type {Diagnostic, Target} from '@multifront/core';
import {createServer, isRunnableDevEnvironment, type Rolldown, type ViteDevServer} from 'vite';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {EXPECTED_IMPORTS} from '../fixtures/apps/imports/expected.ts';
import {FIXTURES_DIR, TMP_DIR, componentPath, filesOf, readComponent} from '../fixtures/index.ts';
import {APP_CONFIG_LOADER, buildApp} from './lib/build.ts';
import {expectNoAttribute, moduleReferences} from './lib/references.ts';

const APP = join(FIXTURES_DIR, 'apps', 'imports');
const CARD = componentPath('Card.ucf');
// The module ids of spec 4.3.
const TARGET_ID: Record<Target, string> = {react: `${CARD}.react.tsx`, vue: CARD, svelte: `${CARD}.svelte.svelte`};
// Vite writes `/@fs` only before a file on disk; the react and svelte ids name none.
const DEV_URL: Record<Target, string> = {react: TARGET_ID.react, vue: `/@fs${CARD}`, svelte: TARGET_ID.svelte};
// Milestone 5 adds `svelte()` to the configs, and these rows here.
const ROWS = EXPECTED_IMPORTS.filter((row) => !row.file.endsWith('.svelte'));
const FILES = [...new Set(ROWS.map((row) => row.file))];
const NO_IMPORTS = 'no-default/strings-and-comments.ts';
const SSR_ENTRY = 'no-default/ssr-entry.tsx';

type Row = (typeof ROWS)[number];
type BuildError = Rolldown.BundleError & Pick<Rolldown.RollupError, 'loc'>;

function rowsOf(file: string): Row[] {
  return ROWS.filter((row) => row.file === file).sort((left, right) => left.line - right.line);
}

const isTargetRow = (row: Row): row is Extract<Row, {rule: unknown}> => 'rule' in row;

function projectOf(file: string): string {
  let dir = dirname(join(APP, file));
  while (!readdirSync(dir).includes('vite.config.ts')) dir = dirname(dir);
  return dir;
}

// A `.ucf` row is served through its React module, the one that holds the block's imports.
function urlOf(file: string): string {
  const path = relative(projectOf(file), join(APP, file)).split(sep).join('/');
  return `/${path}${file.endsWith('.ucf') ? '.react.tsx' : ''}`;
}

// Fast Refresh makes a React module import itself.
function ucfImports(code: string, url: string) {
  return moduleReferences(code).filter(({specifier}) => specifier.includes('.ucf') && specifier !== url);
}

function expectError(err: BuildError | undefined, loc: BuildError['loc'], file: string) {
  expect(err, `${file} did not fail`).toBeDefined();
  const filename = join(APP, file);
  const source = readFileSync(filename, 'utf8');
  const rows = rowsOf(file);
  let expected: (Pick<Diagnostic, 'filename' | 'line' | 'column'> & {code: string})[];
  if (file.endsWith('.ucf')) expected = checkBlocks(splitBlocks(source, filename));
  else {
    const {imports, errors} = rewriteImportAttributes(source, filename);
    expected = rows.map((row) => {
      if (row.expect === 'framework-attribute-not-literal') return errors[0]!;
      const entry = imports.find(({start}) => locate(source, start).line === row.line)!;
      return {code: row.expect, filename, ...locate(source, entry.start)};
    });
  }
  expect(expected.map(({line, code}) => [line, code])).toEqual(rows.map(({line, expect: code}) => [line, code]));
  const [first, ...rest] = expected;
  expect(err!.message).toContain(`(${first!.code})`);
  expect(loc).toEqual({file: first!.filename, line: first!.line, column: first!.column});
  for (const other of rest) expect(err!.message).toContain(`\n${other.filename}:${other.line}:${other.column} `);
}

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: BuildError) => error
  );

const ERROR_FILES = FILES.filter((file) => rowsOf(file).every((row) => !isTargetRow(row)));
const TARGET_FILES = FILES.filter((file) => rowsOf(file).every(isTargetRow));
const REACT_FILES = TARGET_FILES.filter((file) => rowsOf(file).every((row) => row.expect === 'react'));

it('every importer of the app is a row file, or the one with no import', () => {
  const importers = filesOf('imports', /\.(?:[cm]?[jt]sx?|vue|ucf)$/);
  expect(importers).toEqual([...FILES, NO_IMPORTS].sort());
  expect([...ERROR_FILES, ...TARGET_FILES].sort()).toEqual([...FILES].sort());
  expect(REACT_FILES).toContain(SSR_ENTRY);
});

describe('dev servers of the imports app', () => {
  const servers = new Map<string, ViteDevServer>();
  let cacheDir: string | undefined;

  beforeAll(async () => {
    await mkdir(TMP_DIR, {recursive: true});
    cacheDir = await mkdtemp(join(TMP_DIR, 'imports-cache-'));
    for (const project of new Set([...FILES, NO_IMPORTS].map(projectOf))) {
      const server = await createServer({
        root: project,
        configLoader: APP_CONFIG_LOADER,
        cacheDir,
        logLevel: 'silent',
        server: {middlewareMode: true, ws: false, preTransformRequests: false},
        optimizeDeps: {noDiscovery: true},
      });
      servers.set(project, server);
    }
  });

  afterAll(async () => {
    try {
      for (const server of servers.values()) await server.close();
    } finally {
      if (cacheDir) await rm(cacheDir, {recursive: true, force: true});
    }
  });

  const environment = (file: string, name: 'client' | 'ssr') => servers.get(projectOf(file))!.environments[name];

  for (const name of ['client', 'ssr'] as const) {
    it.each(TARGET_FILES)(`%s: each .ucf import is its target's id, no attribute left (${name})`, async (file) => {
      const {code} = (await environment(file, name).transformRequest(urlOf(file)))!;
      expectNoAttribute(code);
      const ucf = ucfImports(code, urlOf(file));
      const rows = rowsOf(file);
      expect(ucf).toHaveLength(rows.length);
      rows.forEach((row, index) => {
        if (!isTargetRow(row)) throw new Error(`${row.file}:${row.line} is an error row`);
        expect(resolve(dirname(join(APP, row.file)), row.specifier)).toBe(CARD);
        const [path, query = ''] = ucf[index]!.specifier.split('?');
        expect(path, `${row.file}:${row.line}`).toBe(DEV_URL[row.expect]);
        expect(new URLSearchParams(query).has('framework')).toBe(false);
      });
    });

    it(`${NO_IMPORTS} has no .ucf import (${name})`, async () => {
      const result = await environment(NO_IMPORTS, name).transformRequest(urlOf(NO_IMPORTS));
      expect(ucfImports(result!.code, urlOf(NO_IMPORTS))).toEqual([]);
    });
  }

  it.each(ERROR_FILES)('%s fails with its code at its place', async (file) => {
    const err = await rejection(environment(file, 'client').transformRequest(urlOf(file)));
    expectError(err, err?.loc, file);
  });

  it(`${SSR_ENTRY} renders the React Card through the SSR module runner`, async () => {
    const ssr = environment(SSR_ENTRY, 'ssr');
    if (!isRunnableDevEnvironment(ssr)) throw new Error('the ssr environment has no module runner');
    const {render} = (await ssr.runner.import(urlOf(SSR_ENTRY))) as {render: () => string};
    const {filename, source} = readComponent('Card.ucf');
    const root = projectOf(SSR_ENTRY);
    const ctx = await createBuildContext(splitBlocks(source, filename), {
      root,
      compiler: loadVueCompiler(root),
      production: false,
    });
    const card = ctx.styles.find((style) => style.classes)?.classes?.card;
    expect(card).toBeDefined();
    expect(render()).toBe(`<div class="${card}"><h2>Hello</h2></div>`);
  });
});

describe('vite build of the imports app', () => {
  const projects = [...new Set(REACT_FILES.map(projectOf))];

  it.each(projects.map((project) => [relative(APP, project) || '.', project]))(
    '%s: every react row builds, with no attribute in the output',
    async (_name, project) => {
      const files = REACT_FILES.filter((file) => projectOf(file) === project);
      const input = Object.fromEntries(files.map((file) => [file.replaceAll(/[/.]/g, '-'), join(APP, file)]));
      const {chunks} = await buildApp(project, {build: {rolldownOptions: {input}}});
      expect(chunks.flatMap((chunk) => chunk.moduleIds)).toContain(TARGET_ID.react);
      for (const chunk of chunks) expectNoAttribute(chunk.code);
    }
  );

  it.each(ERROR_FILES)('%s fails with its code at its place', async (file) => {
    const err = await rejection(buildApp(projectOf(file), {build: {rolldownOptions: {input: join(APP, file)}}}));
    expectError(err, err?.errors?.[0]?.loc, file);
  });
});
