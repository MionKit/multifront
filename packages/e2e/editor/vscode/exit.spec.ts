import {mkdtempSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR} from '../../fixtures/index.ts';
import {runInVsCode, VSCODE_VERSION} from '../lib/vscode.ts';
import {packVsix} from '../lib/vsix.ts';

interface Check {
  name: string;
}

const SUITE = join(import.meta.dirname, 'suite.cjs');
const WORKSPACE = join(FIXTURES_DIR, 'apps', 'imports');
const {checks, withoutTypescript, TYPESCRIPT_EXTENSION} = createRequire(import.meta.url)(SUITE) as {
  checks: Check[];
  withoutTypescript: Check[];
  TYPESCRIPT_EXTENSION: string;
};

type Results = Awaited<ReturnType<typeof runInVsCode>>;

let temp: string;
let extension: string;

// The first run downloads VS Code; later ones start it in seconds.
beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), 'multifront-exit-'));
  extension = await packVsix(temp);
}, 120_000);

afterAll(() => {
  if (temp) rmSync(temp, {recursive: true, force: true});
});

/** One test per check, from the results of the run `start` makes. */
function reportChecks(names: Check[], start: () => Promise<Results>): void {
  let results: Results;

  beforeAll(async () => {
    results = await start();
  }, 900_000);

  it.each(names.map(({name}) => name))('%s', (name) => {
    const result = results.find((row) => row.name === name);
    // A missing result: the suite died before this check.
    expect(result, `${name} did not run`).toBeDefined();
    if (result?.error) throw new Error(result.error);
  });
}

describe(`milestone 2 exit test, in VS Code ${VSCODE_VERSION} with the packed extension`, () => {
  reportChecks(checks, () => runInVsCode({extension, workspace: WORKSPACE, suite: SUITE}));
});

describe("with VS Code's TypeScript extension disabled, the extension still starts its server", () => {
  reportChecks(withoutTypescript, () =>
    runInVsCode({
      extension,
      workspace: WORKSPACE,
      suite: join(import.meta.dirname, 'withoutTypescript.cjs'),
      args: ['--disable-extension', TYPESCRIPT_EXTENSION],
    })
  );
});
