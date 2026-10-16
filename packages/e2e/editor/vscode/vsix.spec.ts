import {mkdtempSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Finding} from '@multifront/core';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {copyApp, removeApp} from '../../fixtures/index.ts';
import {runMfFmt, runMfLint, runMfTsc} from '../lib/commands.ts';
import type {BinReport} from '../lib/commands.ts';
import {formatting, LINT_FORMAT, ORIGINAL, read} from '../lib/format.ts';
import {asLintPoint, lintDiagnostics, lintPoints, mfLintFindings} from '../lib/lint.ts';
import {labels, markupCompletions} from '../lib/markup.ts';
import {addFile, assertNotInstalled, editFile, VALID} from '../lib/tsc.ts';
import {runInVsCode} from '../lib/vscode.ts';
import {packVsix, readZip, VSIX_FILE} from '../lib/vsix.ts';

interface Check {
  name: string;
}

const SUITE = join(import.meta.dirname, 'vsix.cjs');
const {checks} = createRequire(import.meta.url)(SUITE) as {checks: Check[]};
const GREETING = 'Greeting.ucf';
// Marketplace minimum.
const ICON_SIZE = 128;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Manifest {
  displayName: string;
  icon: string;
  categories: string[];
}

// Everything runs on what `pnpm devx vsix` packs, unzipped outside the repo.
let temp: string;
let extension: string;

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), 'multifront-vsix-'));
  extension = await packVsix(temp);
}, 120_000);

afterAll(() => {
  if (temp) rmSync(temp, {recursive: true, force: true});
});

describe('the packed manifest has the Marketplace fields', () => {
  it('a display name, categories and a square PNG icon of at least 128 px', async () => {
    const packed = await readZip(join(temp, VSIX_FILE), () => true);
    const manifest = JSON.parse(packed.get('extension/package.json')!.toString('utf8')) as Manifest;
    expect(manifest.displayName).toBe('multifront');
    expect(manifest.categories).toEqual(['Programming Languages', 'Formatters', 'Linters']);
    const icon = packed.get(`extension/${manifest.icon}`.toLowerCase());
    expect(icon, `${manifest.icon} is not in the .vsix`).toBeDefined();
    expect(icon!.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    // IHDR, the first chunk: width and height right after its length and type.
    const [width, height] = [icon!.readUInt32BE(16), icon!.readUInt32BE(20)];
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(ICON_SIZE);
  });
});

describe('the server from the unzipped .vsix, with no repo node_modules beside it', () => {
  const {state, mfFmt, format} = formatting(LINT_FORMAT, {server: () => join(extension, 'dist', 'server.cjs')});
  const clean = () => ({filename: join(state.root, 'Clean.ucf'), source: read(state.root, 'Clean.ucf')});

  it('finds none of its dependencies outside the .vsix', () => {
    for (const name of ['@volar/language-server', '@multifront/language-tools', 'svelte2tsx'])
      assertNotInstalled(extension, name);
  });

  it('completes bind:value after <input bi in the <svelte> markup', async () => {
    const {complete} = markupCompletions(() => state.server, clean());
    expect(labels(await complete('<svelte>\n', '<input bi|'))).toContain('bind:value');
  });

  it("gives Lint.ucf's oxlint diagnostics as the real mf-lint reports them", async () => {
    const findings = await mfLintFindings(state.root, 'Lint.ucf');
    expect(findings).toHaveLength(4);
    expect(lintPoints(await lintDiagnostics(state.server, join(state.root, 'Lint.ucf')))).toEqual(findings.map(asLintPoint));
  });

  it('formats Messy.ucf as the real mf-fmt writes it', async () => {
    const {text} = await format(ORIGINAL);
    expect(text).not.toBe(ORIGINAL);
    expect(text).toBe(await mfFmt(ORIGINAL));
  });
});

/** A types-every-target/ copy with its own configs (the repo's ignore `.tmp/`), a type error and a `debugger`. */
async function brokenCopy(): Promise<string> {
  const root = await copyApp(VALID);
  addFile(root, '.oxlintrc.json', '{"rules": {"no-debugger": "error"}}\n');
  addFile(root, '.oxfmtrc.json', '{}\n');
  editFile(root, GREETING, 'label={String(count)}', 'label={count}');
  editFile(
    root,
    GREETING,
    'defineProps<{ name: string; count?: number }>()',
    'defineProps<{ name: string; count?: number }>()\n  debugger'
  );
  return root;
}

async function findings(run: Promise<{code: number; stdout: string; stderr: string}>): Promise<Finding[]> {
  const {code, stdout, stderr} = await run;
  expect({code, stderr}).toEqual({code: 1, stderr: ''});
  return (JSON.parse(stdout) as BinReport<object>).findings;
}

describe('a real VS Code with the .vsix installed into a fresh extensions folder', () => {
  let workspace: string;
  let other: string;
  let results: Awaited<ReturnType<typeof runInVsCode>>;

  // Long timeout: the first run downloads VS Code; later ones start it in seconds.
  beforeAll(async () => {
    [workspace, other] = await Promise.all([brokenCopy(), brokenCopy()]);
    const args = [GREETING, '--format', 'json'];
    const [tsc, lint, fmt] = await Promise.all([
      findings(runMfTsc(workspace, args)),
      findings(runMfLint(workspace, args)),
      runMfFmt(other, [GREETING]),
    ]);
    expect({code: fmt.code, stderr: fmt.stderr}).toEqual({code: 0, stderr: ''});
    const data = {tsc, lint, formatted: read(other, GREETING)};
    results = await runInVsCode({vsix: join(temp, VSIX_FILE), workspace, suite: SUITE, data});
  }, 900_000);

  afterAll(async () => {
    await Promise.all([workspace, other].filter(Boolean).map((root) => removeApp(root)));
  });

  it.each(checks.map(({name}) => name))('%s', (name) => {
    const result = results.find((row) => row.name === name);
    // A missing result: the suite died before this check.
    expect(result, `${name} did not run`).toBeDefined();
    if (result?.error) throw new Error(result.error);
  });
});
