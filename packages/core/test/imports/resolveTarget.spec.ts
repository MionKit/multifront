import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {dirname, join, sep} from 'node:path';
import {describe, expect, it} from 'vitest';
import {importerFromId, resolveTarget} from '@multifront/core';
import type {ResolveTargetOptions, Target} from '@multifront/core';
// Relative paths, not a package dependency: @multifront/e2e depends on core.
import {EXPECTED_IMPORTS} from '../../../e2e/fixtures/apps/imports/expected.ts';
import {FIXTURES_DIR, componentPath} from '../../../e2e/fixtures/index.ts';
import {readImports, scriptName, scriptsOf} from './readImports.ts';

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
  'react-only/not-enabled.ts:1': 'framework "svelte" is not enabled; use react, or add svelte to the frameworks option',
};
const NO_ENTRY_TARGET = 'no framework for this .ucf entry; set the framework option';

// The target module ids of spec 4.3.
const BLOCK_IDS: Record<Target, (fileName: string) => string> = {
  vue: (fileName) => fileName,
  react: (fileName) => `${fileName}.react.tsx`,
  svelte: (fileName) => `${fileName}.svelte.svelte`,
};

// What a host sees: the module id of the block holding the import, or a script sub-request with its query.
function hostId(fileName: string, block: Target | undefined): string {
  if (block) return BLOCK_IDS[block](fileName);
  if (!/\.(vue|svelte)$/.test(fileName)) return fileName;
  return scriptName(fileName, scriptsOf(fileName, readFileSync(fileName, 'utf8'))[0]!);
}

const CARD = componentPath('Card.ucf');
// Card.ucf's module ids, then the editor's virtual scripts (`Card.ucf.react.tsx` is both).
const IN_BLOCK: [string, Target][] = [
  ['Card.ucf', 'vue'],
  ['Card.ucf?vue&type=script&setup=true&lang.ts', 'vue'],
  ['Card.ucf.react.tsx', 'react'],
  ['Card.ucf.svelte.svelte', 'svelte'],
  ['Card.ucf.vue.ts', 'vue'],
  ['Card.ucf.svelte.ts', 'svelte'],
];
// Written by hand.
const IN_BLOCK_MESSAGES: Record<string, string> = {
  'vue framework-in-block': 'a framework attribute cannot sit inside the <vue> block; imports there always get vue',
  'react framework-in-block': 'a framework attribute cannot sit inside the <react> block; imports there always get react',
  'svelte framework-in-block': 'a framework attribute cannot sit inside the <svelte> block; imports there always get svelte',
  'vue target-not-enabled': 'framework "vue" is not enabled; use react, or add vue to the frameworks option',
  'svelte target-not-enabled': 'framework "svelte" is not enabled; use react, or add svelte to the frameworks option',
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
  return {frameworks: entry.frameworks, framework: entry.framework, importers: entry.importers}; // toEqual ignores the undefined ones
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
    const importer = importerFromId(hostId(fileName, block));
    expect(importer).toEqual(block ? {fileName, block} : {fileName});
    const choice = resolveTarget(importer, attribute, options);
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

  it.each(IN_BLOCK)('%s is inside its <%s> block', (id, block) => {
    const importer = importerFromId(join(CARD, '..', id));
    expect(importer).toEqual({fileName: CARD, block});
    expect(resolveTarget(importer, undefined)).toEqual({target: block, rule: 'block'});
    const inBlock = {error: {code: 'framework-in-block', message: IN_BLOCK_MESSAGES[`${block} framework-in-block`]}};
    expect(resolveTarget(importer, 'react')).toEqual(inBlock);
    const reactOnly = resolveTarget(importer, undefined, {frameworks: ['react']});
    if (block === 'react') expect(reactOnly).toEqual({target: 'react', rule: 'block'});
    else
      expect(reactOnly).toEqual({error: {code: 'target-not-enabled', message: IN_BLOCK_MESSAGES[`${block} target-not-enabled`]}});
  });
});

// A build entry (M5): only the attribute and the framework option apply.
describe('resolveTarget with no importer, over the same rows', () => {
  const rows = EXPECTED_IMPORTS.filter(
    (row) => row.expect !== 'framework-in-block' && row.expect !== 'framework-attribute-not-literal'
  );
  it.each(rows.map((row) => [`${row.file}:${row.line}`, row] as const))('%s', (key, row) => {
    const [found] = readImports(join(APP, row.file)).imports.filter((entry) => entry.line === row.line);
    const choice = resolveTarget(undefined, found!.attribute, row.options);
    let expected: object;
    if (found!.attribute !== undefined) {
      expected = 'rule' in row ? {target: row.expect, rule: row.rule} : {error: {code: row.expect, message: MESSAGES[key]!}};
    } else if (row.options.framework) {
      expected = {target: row.options.framework, rule: 'default'};
    } else {
      expected = {error: {code: 'no-target', message: NO_ENTRY_TARGET}};
    }
    expect(choice).toEqual(expected);
  });
});
