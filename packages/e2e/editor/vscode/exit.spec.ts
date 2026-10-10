import {mkdtempSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR} from '../../fixtures/index.ts';
import {runInVsCode, VSCODE_VERSION} from '../lib/vscode.ts';
import type {CheckResult} from '../lib/vscode.ts';
import {packVsix} from '../lib/vsix.ts';

const SUITE = join(import.meta.dirname, 'suite.cjs');
const {checks} = createRequire(import.meta.url)(SUITE) as {checks: {name: string}[]};

let temp: string;
let results: CheckResult[];

// Packs and runs once: VS Code starts in seconds, but the first run downloads it.
beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), 'multifront-exit-'));
  const extension = await packVsix(temp);
  results = await runInVsCode({extension, workspace: join(FIXTURES_DIR, 'apps', 'imports'), suite: SUITE});
}, 900_000);

afterAll(() => {
  if (temp) rmSync(temp, {recursive: true, force: true});
});

describe(`milestone 2 exit test, in VS Code ${VSCODE_VERSION} with the packed extension`, () => {
  it.each(checks.map(({name}) => name))('%s', (name) => {
    const result = results.find((row) => row.name === name);
    // A missing result: the suite died before this check.
    expect(result, `${name} did not run`).toBeDefined();
    if (result?.error) throw new Error(result.error);
  });
});
