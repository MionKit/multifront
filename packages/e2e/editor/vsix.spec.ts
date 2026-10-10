import {spawnSync} from 'node:child_process';
import {readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {BLOCK_KINDS} from '@multifront/core';
import {generateGrammar} from 'multifront-vscode/grammar';
import type {GrammarFile} from 'multifront-vscode/grammar';
import {beforeAll, describe, expect, it} from 'vitest';
import {componentPath} from '../fixtures/index.ts';
import {hasScope, tokenizeUcf} from './lib/tokenize.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const EXTENSION_DIR = join(REPO_ROOT, 'packages', 'vscode');

interface GrammarContribution {
  language?: string;
  scopeName: string;
  path: string;
  injectTo?: string[];
  embeddedLanguages?: Record<string, string>;
}

interface Manifest {
  contributes: {
    languages: {id: string; extensions: string[]; configuration: string; icon: {light: string; dark: string}}[];
    grammars: GrammarContribution[];
  };
}

const readJson = <Value>(path: string): Value => JSON.parse(readFileSync(path, 'utf8')) as Value;

function spawn(args: string[], cwd: string): string {
  const result = spawnSync(process.execPath, args, {cwd, encoding: 'utf8', env: {...process.env, CI: '1'}});
  expect(result.status, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout;
}

// The content scope of every block and every `lang` grammar, mapped to the VS Code language it holds.
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
  let packed: Set<string>;
  let startedAt: number;

  beforeAll(() => {
    startedAt = Date.now();
    spawn([join(REPO_ROOT, 'scripts', 'devx.mjs'), 'vsix'], REPO_ROOT);
    const vsce = join(REPO_ROOT, 'node_modules', '@vscode', 'vsce', 'vsce');
    const listed = spawn([vsce, 'ls', '--no-dependencies'], EXTENSION_DIR);
    packed = new Set(
      listed
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    );
  }, 120_000);

  it('writes the .vsix named after version.json', () => {
    const vsix = statSync(join(EXTENSION_DIR, `multifront-vscode-${version}.vsix`));
    expect(vsix.size).toBeGreaterThan(0);
    // A .vsix left by an earlier run is gitignored and would pass the size check alone.
    expect(vsix.mtimeMs).toBeGreaterThanOrEqual(startedAt - 1000);
  });

  it('packs the manifest, icon, language configuration, every generated grammar and every license', () => {
    const vendored = Object.keys(readJson<Record<string, unknown>>(join(EXTENSION_DIR, 'syntaxes', 'vendor', 'sources.json')));
    expect(vendored.length).toBeGreaterThan(0);
    for (const path of [
      'package.json',
      'icons/ucf.svg',
      'language-configuration.json',
      'LICENSE',
      'syntaxes/vendor/sources.json',
      ...vendored.map((name) => `syntaxes/vendor/${name}/LICENSE`),
    ]) {
      expect(packed, path).toContain(path);
    }
    const grammars = [...packed].filter((path) => path.startsWith('dist/syntaxes/')).sort();
    expect(grammars).toEqual(generated.map(({path}) => `dist/syntaxes/${path}`).sort());
  });

  it('contributes every grammar of generateGrammar(), with embedded languages from the registry', () => {
    const expected: GrammarContribution[] = generated.map(({scopeName, path, injectTo}, index) => ({
      ...(index === 0 && {language: 'ucf', embeddedLanguages: registryLanguages()}),
      scopeName,
      path: `./dist/syntaxes/${path}`,
      ...(injectTo && {injectTo}),
    }));
    expect(manifest.contributes.grammars).toEqual(expected);
    const [language] = manifest.contributes.languages;
    expect(manifest.contributes.languages).toHaveLength(1);
    expect(language).toMatchObject({id: 'ucf', extensions: ['.ucf']});
    for (const path of [language!.configuration, language!.icon.light, language!.icon.dark]) {
      expect(packed, path).toContain(path.replace(/^\.\//, ''));
    }
  });

  it('Card.ucf gets the same scopes from the packed grammar files as from generateGrammar()', async () => {
    // Read through the manifest, as VS Code does: root grammar first, injections by `injectTo`.
    const files: GrammarFile[] = manifest.contributes.grammars.map(({scopeName, path, injectTo}) => ({
      scopeName,
      path,
      grammar: readJson(join(EXTENSION_DIR, path)),
      ...(injectTo && {injectTo}),
    }));
    expect(files[0]!.scopeName).toBe('source.ucf');
    const card = componentPath('Card.ucf');
    const tokens = await tokenizeUcf(card, files);
    expect(tokens).toEqual(await tokenizeUcf(card, generated));
    const source = readFileSync(card, 'utf8');
    const exportAt = source.indexOf('export', source.indexOf('<react'));
    expect(tokens.find(({start}) => start === exportAt)?.scopes).toContain('keyword.control.export.tsx');
    for (const scope of ['react', 'style.scss', 'vue', 'svelte'].map((block) => `meta.embedded.block.${block}`)) {
      expect(
        tokens.some((token) => hasScope(token, scope)),
        scope
      ).toBe(true);
    }
  });
});
