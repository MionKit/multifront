import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {dirname, join, sep} from 'node:path';
import {describe, expect, it} from 'vitest';
import {resolveTarget} from '@multifront/core';
import type {ResolveTargetOptions} from '@multifront/core';
// Relative paths, not a package dependency: @multifront/e2e depends on core.
import {EXPECTED_IMPORTS} from '../../../e2e/fixtures/apps/imports/expected.ts';
import {FIXTURES_DIR} from '../../../e2e/fixtures/index.ts';
import {readImports} from './readImports.ts';

const APP = join(FIXTURES_DIR, 'apps', 'imports');
const PLUGIN = '@multifront/language-tools/typescript-plugin';

const APP_FILES = readdirSync(APP, {recursive: true, encoding: 'utf8'})
  .map((path) => path.split(sep).join('/'))
  .filter((file) => /\.(ts|tsx|jsx|vue|svelte|ucf)$/.test(file) && file !== 'expected.ts');

// Written by hand.
const MESSAGES: Record<string, string> = {
  'src/bad.ts:1': 'unknown framework "angular"; use vue, react or svelte',
  'src/BlockAttribute.ucf:2': 'a framework attribute cannot sit inside the <react> block; imports there always get react',
  'src/BlockAttribute.ucf:3': 'a framework attribute cannot sit inside the <react> block; imports there always get react',
  'no-default/unknown.ts:1': 'unknown framework "angular"; use vue, react or svelte',
  'no-default/non-literal.ts:2': "the framework attribute must be a string literal: with {framework: 'react'} (or vue, svelte)",
  'no-default/bare.ts:1':
    "no framework for this .ucf import; add with {framework: 'react'} (or vue, svelte), " +
    'import it from a .vue, .svelte, .jsx, .tsx or .mts file, or set the framework option',
};

// The plugin entry of the nearest tsconfig.json: the options the TypeScript plugin reads (2.8).
function pluginOptions(fileName: string): ResolveTargetOptions {
  let dir = dirname(fileName);
  while (!existsSync(join(dir, 'tsconfig.json'))) {
    if (dir === APP) throw new Error(`no tsconfig.json above ${fileName}`);
    dir = dirname(dir);
  }
  const {compilerOptions} = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8'));
  const entry = compilerOptions.plugins.find((plugin: {name: string}) => plugin.name === PLUGIN);
  return {framework: entry.framework, importers: entry.importers}; // toEqual ignores the undefined ones
}

describe('resolveTarget over the shared imports fixture set', () => {
  it.each(EXPECTED_IMPORTS.map((row) => [`${row.file}:${row.line}`, row] as const))('%s', (key, row) => {
    const fileName = join(APP, row.file);
    const {imports, errors} = readImports(fileName);
    const found = imports.filter((entry) => entry.specifier === row.specifier && entry.line === row.line);
    expect(found).toHaveLength(1);
    const options = pluginOptions(fileName);
    expect(options).toEqual(row.options);
    const rewriteErrors = errors.filter(({line}) => line === row.line).map(({code, message}) => ({code, message}));
    if (row.expect === 'framework-attribute-not-literal') {
      expect(rewriteErrors).toEqual([{code: row.expect, message: MESSAGES[key]}]);
      return;
    }
    expect(rewriteErrors).toEqual([]);
    const {attribute, block} = found[0]!;
    const choice = resolveTarget(block ? {fileName, block} : {fileName}, attribute, options);
    if ('rule' in row) expect(choice).toEqual({target: row.expect, rule: row.rule});
    else expect(choice).toEqual({error: {code: row.expect, message: MESSAGES[key]}});
  });

  it('has one row for every .ucf import of the app', () => {
    const imports = APP_FILES.flatMap((file) =>
      readImports(join(APP, file)).imports.map((entry) => `${file}:${entry.line} ${entry.specifier}`)
    );
    expect(imports.sort()).toEqual(EXPECTED_IMPORTS.map((row) => `${row.file}:${row.line} ${row.specifier}`).sort());
  });

  it('has a hand-written message for every error row', () => {
    const errorRows = EXPECTED_IMPORTS.filter((row) => !('rule' in row)).map((row) => `${row.file}:${row.line}`);
    expect(errorRows.sort()).toEqual(Object.keys(MESSAGES).sort());
  });
});
