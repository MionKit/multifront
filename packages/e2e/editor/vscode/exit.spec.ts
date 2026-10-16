import {existsSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR} from '../../fixtures/index.ts';
import {CRASH_DIR, runInVsCode, VSCODE_VERSION} from '../lib/vscode.ts';
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

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), 'multifront-exit-'));
  extension = await packVsix(temp);
}, 120_000);

afterAll(() => {
  if (temp) rmSync(temp, {recursive: true, force: true});
});

function reportChecks(names: Check[], start: () => Promise<Results>): void {
  let results: Results;

  // Long timeout: the first run downloads VS Code; later ones start it in seconds.
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

// Here, after the exit runs: another file starting VS Code would race them for the `.vscode-test/` download.
describe('a VS Code that dies by SIGSEGV', () => {
  let kept: string | undefined;
  const hostOptions = process.env.NODE_OPTIONS;

  afterAll(() => {
    process.env.NODE_OPTIONS = hostOptions;
    if (kept) rmSync(kept, {recursive: true, force: true});
  });

  it('leaves its crash dump, named in the error, and got no NODE_OPTIONS', async () => {
    process.env.NODE_OPTIONS = '--max-old-space-size=4096';
    const suite = join(import.meta.dirname, 'crash.cjs');
    const error = await runInVsCode({extension, workspace: WORKSPACE, suite}).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('Test run terminated with signal SIGSEGV');
    // The error ends with VS Code's own startup log: Electron names a NODE_OPTIONS it was given.
    expect(message).not.toContain('Most NODE_OPTIONs are not supported');
    kept = /^crash dump kept in (.+)$/m.exec(message)?.[1];
    expect(kept, message.slice(0, 2000)).toBeDefined();
    expect(kept!.startsWith(CRASH_DIR)).toBe(true);
    expect(readdirSync(kept!).some((name) => name.endsWith('.dmp'))).toBe(true);
    // crash.cjs left a writer in the run's folder: the harness waited for it before deleting the folder.
    expect(existsSync(join(tmpdir(), basename(kept!)))).toBe(false);
  });
});
