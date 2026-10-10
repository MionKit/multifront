import {spawnSync} from 'node:child_process';
import type {SpawnSyncReturns} from 'node:child_process';
import {cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {BLOCK_KINDS} from '@multifront/core';
import {generateGrammar} from 'multifront-vscode/grammar';
import type {GrammarFile} from 'multifront-vscode/grammar';
import {afterEach, beforeAll, describe, expect, it} from 'vitest';
import {componentPath} from '../fixtures/index.ts';
import {tokenizeUcf} from './lib/tokenize.ts';
import {EXTENSION_DIR, readZip, REPO_ROOT, tempRepo} from './lib/vsix.ts';

const PACK = 'node_modules/multifront-typescript-plugin-pack';

type GrammarContribution = Pick<GrammarFile, 'scopeName' | 'path' | 'injectTo'> & {
  language?: string;
  embeddedLanguages?: Record<string, string>;
};

interface Manifest {
  version: string;
  main: string;
  activationEvents: string[];
  contributes: {
    languages: {id: string; extensions: string[]; configuration: string; icon: {light: string; dark: string}}[];
    grammars: GrammarContribution[];
    typescriptServerPlugins: {name: string; enableForWorkspaceTypeScriptVersions: boolean; languages: string[]}[];
  };
}

const readJson = <Value>(path: string): Value => JSON.parse(readFileSync(path, 'utf8')) as Value;

function spawn(args: string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, args, {cwd, encoding: 'utf8', env: {...process.env, CI: '1'}});
}

// vsce warns on stderr, or on stdout as `::warning::` under GitHub Actions.
function succeed(args: string[], cwd: string): string {
  const result = spawn(args, cwd);
  const output = `${result.stdout}\n${result.stderr}`;
  expect(result.status, `${args.join(' ')}\n${result.error?.message ?? ''}\n${output}`).toBe(0);
  return output;
}

function devx(root: string, ...args: string[]): string[] {
  return [join(root, 'scripts', 'devx.mjs'), ...args];
}

// vsce packs `LICENSE` as `LICENSE.txt`.
const zipPath = (path: string): string =>
  `extension/${path.replace(/^\.\//, '').replace(/^LICENSE$/, 'LICENSE.txt')}`.toLowerCase();

function registryLanguages(): Record<string, string> {
  const languages: Record<string, string> = {};
  for (const {tag, grammar} of BLOCK_KINDS) {
    languages[`meta.embedded.block.${tag}`] = grammar.languageId;
    for (const {languageId} of Object.values(grammar.byLang ?? {})) {
      languages[`meta.embedded.block.${tag}.${languageId}`] = languageId;
    }
  }
  return languages;
}

describe('pnpm devx vsix packs the .ucf language and every grammar', () => {
  const {version} = readJson<{version: string}>(join(REPO_ROOT, 'version.json'));
  const manifest = readJson<Manifest>(join(EXTENSION_DIR, 'package.json'));
  const generated = generateGrammar();
  const vsixPath = join(EXTENSION_DIR, `multifront-vscode-${version}.vsix`);
  let output: string;
  let packed: Map<string, Buffer>;

  const packedJson = <Value>(path: string): Value => {
    const entry = packed.get(zipPath(path));
    if (!entry) throw new Error(`${path} is not in the .vsix`);
    return JSON.parse(entry.toString('utf8')) as Value;
  };

  beforeAll(async () => {
    // Gitignored leftovers: an old .vsix must not pass as new, a removed grammar or file must not be packed.
    rmSync(vsixPath, {force: true});
    for (const dir of ['dist/syntaxes', PACK]) mkdirSync(join(EXTENSION_DIR, dir), {recursive: true});
    writeFileSync(join(EXTENSION_DIR, 'dist', 'syntaxes', 'source.ucf.removed.tmLanguage.json'), '{}');
    writeFileSync(join(EXTENSION_DIR, 'dist', 'removed.cjs'), '');
    writeFileSync(join(EXTENSION_DIR, PACK, 'removed.js'), '');
    output = succeed(devx(REPO_ROOT, 'vsix'), REPO_ROOT);
    packed = await readZip(vsixPath, () => true);
  }, 120_000);

  it('packs with no vsce warning, so a terminal run never prompts', () => {
    expect(output).not.toMatch(/WARNING|::warning::/);
  });

  it('packs exactly the manifest, language files, generated grammars, bundles, plugin pack and licenses', () => {
    const vendored = Object.keys(readJson<Record<string, unknown>>(join(EXTENSION_DIR, 'syntaxes', 'vendor', 'sources.json')));
    expect(vendored.length).toBeGreaterThan(0);
    const [language] = manifest.contributes.languages;
    const expected = [
      'package.json',
      'LICENSE',
      ...[language!.configuration, language!.icon.light, language!.icon.dark].map((path) => path.replace(/^\.\//, '')),
      'syntaxes/vendor/sources.json',
      ...vendored.map((name) => `syntaxes/vendor/${name}/LICENSE`),
      ...generated.map(({path}) => `dist/syntaxes/${path}`),
      'dist/extension.cjs',
      'dist/server.cjs',
      'dist/typescript-plugin.cjs',
      'dist/parser.wasm32-wasi.wasm',
      `${PACK}/index.js`,
      `${PACK}/package.json`,
    ];
    const inZip = [...packed.keys()].filter((name) => name.startsWith('extension/'));
    expect(new Set(inZip)).toEqual(new Set(expected.map(zipPath)));
  });

  it('contributes every grammar of generateGrammar(), with embedded languages from the registry', () => {
    const expected: GrammarContribution[] = generated.map(({scopeName, path, injectTo}, index) => ({
      ...(index === 0 && {language: 'ucf', embeddedLanguages: registryLanguages()}),
      scopeName,
      path: `./dist/syntaxes/${path}`,
      ...(injectTo && {injectTo}),
    }));
    const packedManifest = packedJson<Manifest>('package.json');
    expect(packedManifest.contributes.grammars).toEqual(expected);
    expect(packedManifest.contributes.languages).toEqual(manifest.contributes.languages);
    expect(packedManifest.contributes.languages).toHaveLength(1);
    expect(packedManifest.contributes.languages[0]).toMatchObject({id: 'ucf', extensions: ['.ucf']});
    expect(packedManifest.version).toBe(version);
    expect(packedJson(packedManifest.contributes.languages[0]!.configuration)).toHaveProperty('comments.blockComment');
  });

  it('starts the server from the bundle on .ucf files, and has tsserver load the plugin pack for them', () => {
    const packedManifest = packedJson<Manifest>('package.json');
    expect(packedManifest.main).toBe('./dist/extension.cjs');
    expect(packedManifest.activationEvents).toEqual(['onLanguage:ucf']);
    // tsserver finds a plugin only as `<extension>/node_modules/<name>`; `languages` sends .ucf files to it.
    expect(packedManifest.contributes.typescriptServerPlugins).toEqual([
      {name: 'multifront-typescript-plugin-pack', enableForWorkspaceTypeScriptVersions: true, languages: ['ucf']},
    ]);
    expect(packed.get(zipPath(`${PACK}/index.js`))!.toString('utf8')).toContain("require('../../dist/typescript-plugin.cjs')");
  });

  it('Card.ucf gets the same scopes from the packed grammar files as from generateGrammar()', async () => {
    // As VS Code loads them: root grammar first, injections by `injectTo`.
    const files: GrammarFile[] = packedJson<Manifest>('package.json').contributes.grammars.map(({scopeName, path, injectTo}) => ({
      scopeName,
      path,
      grammar: packedJson(path),
      ...(injectTo && {injectTo}),
    }));
    expect(files[0]!.scopeName).toBe('source.ucf');
    const card = componentPath('Card.ucf');
    expect(await tokenizeUcf(card, files)).toEqual(await tokenizeUcf(card, generated));
  });
});

describe('pnpm devx vsix takes the version from version.json', () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, {recursive: true, force: true});
  });

  function repoWithVersion(versionJson: string): string {
    const root = tempRepo(versionJson);
    temps.push(root);
    return root;
  }

  it(
    'packs the version into the .vsix manifest and the plugin pack only, never into package.json',
    {timeout: 120_000},
    async () => {
      const root = repoWithVersion('{"version": "1.2.3"}');
      succeed(devx(root, 'vsix'), root);
      const extension = join(root, 'packages', 'vscode');
      const manifests = ['extension/package.json', `extension/${PACK}/package.json`];
      const packed = await readZip(join(extension, 'multifront-vscode-1.2.3.vsix'), (name) => manifests.includes(name));
      for (const name of manifests) expect(JSON.parse(packed.get(name)!.toString('utf8'))).toHaveProperty('version', '1.2.3');
      expect(readJson<Manifest>(join(extension, 'package.json')).version).toBe('0.0.0');
    }
  );

  it.each(['{}', '{"version": "../1.2.3"}'])('refuses version.json %s', (versionJson) => {
    const root = repoWithVersion(versionJson);
    const result = spawn(devx(root, 'vsix'), root);
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('devx: version.json has no valid version');
  });
});

describe('pnpm devx vsix bundles only with the wasm build of the oxc-parser core uses', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, {recursive: true, force: true});
  });

  it('refuses a wasm binding of another version', () => {
    root = tempRepo();
    // A stale install, faked on a copy so the real binding package stays untouched.
    const binding = join(root, 'packages', 'vscode', 'node_modules', '@oxc-parser', 'binding-wasm32-wasi');
    const real = realpathSync(binding);
    rmSync(binding);
    cpSync(real, binding, {recursive: true});
    const manifest = readJson<Record<string, unknown>>(join(binding, 'package.json'));
    writeFileSync(join(binding, 'package.json'), JSON.stringify({...manifest, version: '0.0.1'}));
    const result = spawn(devx(root, 'vsix'), root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/oxc-parser (\S+) needs @oxc-parser\/binding-wasm32-wasi \1, found 0\.0\.1/);
  });
});
