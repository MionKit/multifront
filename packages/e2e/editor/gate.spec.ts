// The CI gate: the real `mf-tsc` and `mf-lint` over every valid fixture, which must type-check in every target and be
// oxlint clean. The fixtures are `tsconfig.fixtures.json`'s files; its excludes say why each one is left out.
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {basename, join, relative} from 'node:path';
import typescript from 'typescript';
import {describe, expect, it} from 'vitest';
import {FIXTURES_DIR, TMP_DIR} from '../fixtures/index.ts';
import {runMfLint, runMfTsc} from './lib/commands.ts';
import type {BinReport} from './lib/commands.ts';
import {BREAKS, line, span} from './lib/tsc.ts';

const CONFIG = 'tsconfig.fixtures.json';
const REPO_ROOT = join(FIXTURES_DIR, '..', '..', '..');
const CARD = 'components/Card.ucf';
const FOLDER = 'apps/types-every-target';
const RUNS = 5;

// Type-checked, but broken on purpose for oxlint; the rule each breaks and the spec that pins it.
const LINT_LEFT_OUT: Record<string, string> = {
  'components/TsxEdges.ucf': "no-useless-escape: the '<\\/react>' string core/test/split.spec.ts pins",
  'components/react/errors/NoDefault.ucf': 'no-unused-vars: the component with no default export blocks/react.spec.ts pins',
  'components/svelte/roots/EmptyPropsRoot.ucf': 'no-empty-pattern: the `let {} = $props()` svelte/forward.spec.ts pins',
};

type Report = BinReport<Record<string, unknown>>;

/** The `.ucf` files of the gate's tsconfig under `root`, relative to it. */
function gateUcfFiles(root: string): string[] {
  const host = {...typescript.sys, onUnRecoverableConfigFileDiagnostic: () => {}};
  const ucf = [{extension: 'ucf', isMixedContent: true, scriptKind: typescript.ScriptKind.Deferred}];
  const parsed = typescript.getParsedCommandLineOfConfigFile(join(root, CONFIG), {}, host, undefined, undefined, ucf);
  if (!parsed || parsed.errors.length > 0) throw new Error(`${CONFIG} does not parse`);
  return parsed.fileNames
    .filter((file) => file.endsWith('.ucf'))
    .map((file) => relative(root, file).split('\\').join('/'))
    .filter((file) => !(file in LINT_LEFT_OUT))
    .sort();
}

const readable = ({findings}: Report) => findings.map(line).join('\n');

const runTsc = (root: string, paths: string[] = []) => runMfTsc(root, ['-p', CONFIG, '--format', 'json', ...paths]);
const runLint = (root: string, paths: string[]) => runMfLint(root, ['--format', 'json', ...paths]);

/** A copy of every fixture under `.tmp/`, which the repo's `.oxlintrc.json` ignores: it gets its rules on its own. */
async function withFixturesCopy(check: (root: string) => Promise<void>): Promise<void> {
  await mkdir(TMP_DIR, {recursive: true});
  const root = await mkdtemp(join(TMP_DIR, 'fixtures-'));
  try {
    await cp(FIXTURES_DIR, root, {recursive: true, filter: (source) => basename(source) !== 'node_modules'});
    const config = JSON.parse(await readFile(join(REPO_ROOT, '.oxlintrc.json'), 'utf8')) as Record<string, unknown>;
    delete config.ignorePatterns;
    await writeFile(join(root, '.oxlintrc.json'), JSON.stringify(config));
    await check(root);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

async function median(run: () => Promise<{code: number}>): Promise<string> {
  const times: number[] = [];
  for (let index = 0; index < RUNS; index++) {
    const start = performance.now();
    const {code} = await run();
    times.push(performance.now() - start);
    expect(code).toBe(0);
  }
  return `${(times.sort((a, b) => a - b)[Math.floor(RUNS / 2)]! / 1000).toFixed(2)} s`;
}

describe('the fixtures gate', () => {
  it('mf-tsc: every valid fixture type-checks in every target', async () => {
    const run = await runTsc(FIXTURES_DIR);
    expect(run.stderr).toBe('');
    const report = JSON.parse(run.stdout) as Report;
    expect(report.errorCount, readable(report)).toBe(0);
    expect(run.code).toBe(0);
  });

  it("mf-lint: every valid fixture's .ucf file has no oxlint error under the repo's .oxlintrc.json", async () => {
    const run = await runLint(FIXTURES_DIR, gateUcfFiles(FIXTURES_DIR));
    expect(run.stderr).toBe('');
    const report = JSON.parse(run.stdout) as Report;
    expect(report.errorCount, readable(report)).toBe(0);
    expect(run.code).toBe(0);
  });

  it('fails once a fixture has a type error and an oxlint error', async () => {
    await withFixturesCopy(async (root) => {
      const broken = await readFile(join(FIXTURES_DIR, 'apps', 'types-broken', 'ReactBreaks.ucf'), 'utf8');
      const added = broken.replace('return <Label text={42} />', 'debugger;\n    return <Label text={42} />');
      await writeFile(join(root, 'components', 'ReactBreaks.ucf'), added);
      const file = 'components/ReactBreaks.ucf';

      const tsc = await runTsc(root);
      expect({code: tsc.code, stderr: tsc.stderr}).toEqual({code: 1, stderr: ''});
      const at = span(added, 'text={42}', 'text'.length);
      const errors = (JSON.parse(tsc.stdout) as Report).findings.filter(({severity}) => severity === 'error');
      expect(errors).toEqual([{...BREAKS.finding(file), ...at}]);

      const lint = await runLint(root, gateUcfFiles(root));
      expect({code: lint.code, stderr: lint.stderr}).toEqual({code: 1, stderr: ''});
      expect((JSON.parse(lint.stdout) as Report).findings).toEqual([
        expect.objectContaining({file, code: 'eslint(no-debugger)', severity: 'error', block: 'react'}),
      ]);
    });
  });

  it('times one file, one folder and every fixture: the median of 5 fresh runs each', {timeout: 300_000}, async () => {
    const files = gateUcfFiles(FIXTURES_DIR);
    const times = {
      [`mf-tsc ${CARD}`]: await median(() => runTsc(FIXTURES_DIR, [CARD])),
      [`mf-tsc ${FOLDER}`]: await median(() => runTsc(FIXTURES_DIR, [FOLDER])),
      [`mf-tsc -p ${CONFIG}`]: await median(() => runTsc(FIXTURES_DIR)),
      [`mf-lint ${CARD}`]: await median(() => runLint(FIXTURES_DIR, [CARD])),
      [`mf-lint, ${files.length} files`]: await median(() => runLint(FIXTURES_DIR, files)),
    };
    const lines = Object.entries(times).map(([command, time]) => `  ${command}: ${time}`);
    process.stdout.write(`gate speed, median of ${RUNS} fresh runs:\n${lines.join('\n')}\n`);
  });
});
