// The bins of the packed @multifront/language-tools, installed from a local registry into a fresh project: the same
// output as from source, on copies of the same fixture apps.
import {readFileSync} from 'node:fs';
import {cp} from 'node:fs/promises';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR, copyApp, removeApp} from '../fixtures/index.ts';
import {runBin} from '../editor/lib/commands.ts';
import {editFile, report} from '../editor/lib/tsc.ts';
import {REPO_ROOT, createConsumerApp, runInApp} from './lib/app.ts';
import type {ConsumerApp} from './lib/app.ts';
import {packLanguageTools} from './lib/pack.ts';
import type {LanguageToolsTarballs} from './lib/pack.ts';
import {startRegistry} from './lib/registry.ts';
import type {Registry} from './lib/registry.ts';

const VALID = 'types-every-target';
const LINT_FORMAT = 'lint-format';
const BINS = ['mf-tsc', 'mf-lint', 'mf-fmt'] as const;
const {version} = JSON.parse(readFileSync(join(REPO_ROOT, 'version.json'), 'utf8')) as {version: string};
const SETUP_TIMEOUT = 240_000;

type Bin = (typeof BINS)[number];

let tarballs: LanguageToolsTarballs | undefined;
let registry: Registry | undefined;
let app: ConsumerApp | undefined;
// In-repo copies the source bins run on.
const sources = new Map<string, string>();

beforeAll(async () => {
  tarballs = await packLanguageTools();
  registry = await startRegistry();
  await registry.publish(tarballs.core);
  await registry.publish(tarballs.languageTools);
  app = await createConsumerApp('consumer-language-tools', [`@multifront/language-tools@${version}`], registry.url);
  for (const name of [VALID, LINT_FORMAT]) {
    await cp(join(FIXTURES_DIR, 'apps', name), join(app.dir, name), {recursive: true});
    sources.set(name, await copyApp(name));
  }
}, SETUP_TIMEOUT);

afterAll(async () => {
  await app?.remove();
  await registry?.stop();
  await tarballs?.remove();
  await Promise.all([...sources.values()].map((root) => removeApp(root)));
}, SETUP_TIMEOUT);

/** The installed bin, from `node_modules/.bin`, inside the fresh project's copy of `folder`. */
async function installed(bin: Bin, folder: string, args: string[] = []) {
  const {code, stdout, stderr} = await runInApp(
    app!,
    [join(app!.dir, 'node_modules', '.bin', bin), ...args],
    join(app!.dir, folder)
  );
  return {code, stdout, stderr};
}

/** The same bin from `src/`, inside the in-repo copy of `folder`. */
const fromSource = (bin: Bin, folder: string, args: string[] = []) =>
  runBin('@multifront/language-tools', bin, sources.get(folder)!, args);

describe('the bins of the packed @multifront/language-tools', () => {
  it('installs @multifront/core from the registry too, as a dependency of language-tools', () => {
    const resolved = readFileSync(join(app!.dir, 'pnpm-lock.yaml'), 'utf8');
    expect(resolved).toContain(`'@multifront/core@${version}':`);
    expect(resolved).toContain(`'@multifront/language-tools@${version}':`);
  });

  it('mf-tsc type-checks every target, and finds one error in each broken block as from source', async () => {
    expect(await installed('mf-tsc', VALID)).toEqual({
      code: 0,
      stdout: 'mf-tsc: checked 5 files with tsconfig.json: no errors\n',
      stderr: '',
    });
    for (const root of [join(app!.dir, VALID), sources.get(VALID)!]) {
      editFile(root, 'Greeting.ucf', 'label={String(count)}', 'label={count}');
      editFile(root, 'Greeting.ucf', 'Hello {{ name }}', 'Hello {{ name.toFixed() }}');
      editFile(root, 'Greeting.ucf', 'Hello {name} ({count})', 'Hello {name.toFixed()} ({count})');
    }
    const run = await installed('mf-tsc', VALID, ['--format', 'json']);
    expect(run.code).toBe(1);
    expect(
      report(run.stdout)
        .findings.map(({framework}) => framework)
        .sort()
    ).toEqual(['react', 'svelte', 'vue']);
    expect(run).toEqual(await fromSource('mf-tsc', VALID, ['--format', 'json']));
  });

  it('mf-lint lints every block with the project oxlint, as from source', async () => {
    const run = await installed('mf-lint', LINT_FORMAT, ['--format', 'json']);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout).errorCount).toBeGreaterThan(0);
    expect(run).toEqual(await fromSource('mf-lint', LINT_FORMAT, ['--format', 'json']));
  });

  it('mf-fmt --check finds the unformatted file with the project oxfmt, as from source', async () => {
    const run = await installed('mf-fmt', LINT_FORMAT, ['--check', '--format', 'json']);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout).changed).toEqual(['Messy.ucf']);
    expect(run).toEqual(await fromSource('mf-fmt', LINT_FORMAT, ['--check', '--format', 'json']));
  });

  it.each(BINS)('%s answers --help and an unknown option as from source', async (bin) => {
    const help = await installed(bin, VALID, ['--help']);
    expect(help.code).toBe(0);
    expect(help).toEqual(await fromSource(bin, VALID, ['--help']));
    const unknown = await installed(bin, VALID, ['--bogus']);
    expect({code: unknown.code, stdout: unknown.stdout}).toEqual({code: 2, stdout: ''});
    expect(unknown.stderr).toMatch(new RegExp(`^${bin}: unknown option '--bogus'; .+\\n$`));
  });
});
