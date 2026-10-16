import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll, beforeAll, expect, it} from 'vitest';
import {REPO_ROOT, tempRepo} from '../lib/vsix.ts';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A temp repo copy: the committed icon is never rewritten by a test run.
let root: string;
let icon: string;

beforeAll(() => {
  root = tempRepo();
  cpSync(join(REPO_ROOT, 'docs', 'assets', 'src'), join(root, 'docs', 'assets', 'src'), {recursive: true});
  const {icon: path} = JSON.parse(readFileSync(join(root, 'packages', 'vscode', 'package.json'), 'utf8')) as {icon: string};
  icon = join(root, 'packages', 'vscode', path);
  rmSync(icon);
});

afterAll(() => {
  if (root) rmSync(root, {recursive: true, force: true});
});

it("pnpm devx docs-images vscode-icon renders the icon the extension's manifest names, not into docs/assets/", () => {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'devx.mjs'), 'docs-images', 'vscode-icon'], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout.trim()).toBe('packages/vscode/assets/icon.png');
  const png = readFileSync(icon);
  expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  // IHDR: a 128 px canvas at the renderer's scale 2.
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([256, 256]);
  expect(existsSync(join(root, 'docs', 'assets', 'vscode-icon.png'))).toBe(false);
}, 60_000);
