import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {dirname, join, relative, sep} from 'node:path';
import {describe, expect, it} from 'vitest';
import {DEFAULT_IMPORTERS, resolveTarget} from '@multifront/core';
import type {ResolveTargetOptions} from '@multifront/core';
// Relative paths, not a package dependency: @multifront/e2e depends on core.
import {EXPECTED_IMPORTS} from '../../../e2e/fixtures/apps/imports/expected.ts';
import {FIXTURES_DIR} from '../../../e2e/fixtures/index.ts';
import {readImports} from './readImports.ts';

const APP = join(FIXTURES_DIR, 'apps', 'imports');
const PLUGIN = '@multifront/language-tools/typescript-plugin';

// Written by hand, keyed by `file:line`.
const MESSAGES: Record<string, string> = {
  'src/bad.ts:1': 'unknown framework "angular"; use vue, react or svelte',
  'src/BlockAttribute.ucf:2': 'a framework attribute cannot sit inside the <react> block; imports there always get react',
  'no-default/bare.ts:1':
    "no framework for this .ucf import; add with {framework: 'react'} (or vue, svelte), " +
    'import it from a .vue, .svelte, .jsx or .tsx file, or set the framework option',
};

function appFiles(dir = APP): string[] {
  return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return appFiles(path);
    return /\.(ts|tsx|vue|ucf)$/.test(entry.name) && entry.name !== 'expected.ts' ? [path] : [];
  });
}

function rowFile(path: string): string {
  return relative(APP, path).split(sep).join('/');
}

// The plugin entry of the nearest tsconfig.json: what 2.8 reads as the options.
function pluginOptions(fileName: string): ResolveTargetOptions {
  let dir = dirname(fileName);
  while (!existsSync(join(dir, 'tsconfig.json'))) dir = dirname(dir);
  const {compilerOptions} = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8'));
  const entry = compilerOptions.plugins.find((plugin: {name: string}) => plugin.name === PLUGIN);
  return {framework: entry.framework, importers: entry.importers}; // toEqual ignores the undefined ones
}

describe('resolveTarget over the shared imports fixture set', () => {
  it.each(EXPECTED_IMPORTS.map((row) => [`${row.file}:${row.line}`, row] as const))('%s', (key, row) => {
    const fileName = join(APP, row.file);
    const found = readImports(fileName).filter((entry) => entry.specifier === row.specifier && entry.line === row.line);
    expect(found).toHaveLength(1);
    const {attribute, block} = found[0]!;
    const choice = resolveTarget(block ? {fileName, block} : {fileName}, attribute, row.options);
    if ('rule' in row) expect(choice).toEqual({target: row.expect, rule: row.rule});
    else expect(choice).toEqual({error: {code: row.expect, message: MESSAGES[key]}});
  });

  it('has one row for every .ucf import of the app', () => {
    const imports = appFiles().flatMap((path) =>
      readImports(path).map((entry) => `${rowFile(path)}:${entry.line} ${entry.specifier}`)
    );
    expect(imports.sort()).toEqual(EXPECTED_IMPORTS.map((row) => `${row.file}:${row.line} ${row.specifier}`).sort());
  });

  it("gives each row the options of its tsconfig.json's plugin entry", () => {
    for (const row of EXPECTED_IMPORTS) expect(pluginOptions(join(APP, row.file)), row.file).toEqual(row.options);
  });

  it('has a hand-written message for every error row', () => {
    const errorRows = EXPECTED_IMPORTS.filter((row) => !('rule' in row)).map((row) => `${row.file}:${row.line}`);
    expect(errorRows.sort()).toEqual(Object.keys(MESSAGES).sort());
  });
});

describe('DEFAULT_IMPORTERS', () => {
  it('maps the spec 4.2 importer extensions and cannot change', () => {
    expect(DEFAULT_IMPORTERS).toEqual({'.vue': 'vue', '.svelte': 'svelte', '.jsx': 'react', '.tsx': 'react'});
    expect(Object.isFrozen(DEFAULT_IMPORTERS)).toBe(true);
  });
});
