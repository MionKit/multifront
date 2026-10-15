// The real `mf-tsc` on real fixture apps: the `<react>` block of each `.ucf` file and the `.ts` / `.tsx` importers.
import {cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, relative, sep} from 'node:path';
import {findingOf, splitBlocks} from '@multifront/core';
import type {Finding} from '@multifront/core';
import {describe, expect, it} from 'vitest';
import {FIXTURES_DIR, copyApp, readComponent, removeApp} from '../../fixtures/index.ts';
import {runMfTsc} from '../lib/commands.ts';
import type {BinReport} from '../lib/commands.ts';
import {E2E_DIR, locate, offsetAt} from '../lib/tsserver.ts';

const BROKEN = 'types-broken';
const VALID = 'types-every-target';
const REPO = join(E2E_DIR, '..', '..');
const NOT_STRING = "Type 'number' is not assignable to type 'string'.";
const HELP = `Usage: mf-tsc [options] [paths...]

Type-checks the <react> block of .ucf files, with the .ts and .tsx files that import them.
Paths are files or folders of the project; none checks the whole project.

Options:
  -p, --project <file>   the tsconfig.json to use (default: the nearest one above each path)
  --format <format>      text or json (default: text)
  -h, --help             show this help

Example:
  mf-tsc src/Card.ucf --format json

Exit codes: 0 no errors, 1 errors found, 2 the command could not run (bad usage, config or setup).
`;

const fixture = (app: string, file: string) => readFileSync(join(FIXTURES_DIR, 'apps', app, file), 'utf8');
const shown = (from: string, path: string) => relative(from, path).split(sep).join('/');
const report = (stdout: string) => JSON.parse(stdout) as BinReport;

// 1-based start and end of the first `length` characters of `needle` in `source`, on one line.
function span(source: string, needle: string, length = needle.length): Pick<Finding, 'line' | 'column' | 'end'> {
  const {line, offset} = locate(source, needle);
  return {line, column: offset, end: {line, column: offset + length}};
}

const REACT_BREAKS = fixture(BROKEN, 'ReactBreaks.ucf');
const MAIN = fixture(BROKEN, 'pages/main.tsx');
// TypeScript marks the prop whose value has the wrong type.
const BREAKS_SPAN = span(REACT_BREAKS, 'text={42}', 'text'.length);
const MAIN_SPAN = span(MAIN, 'text={1}', 'text'.length);

function breaksFinding(file = 'ReactBreaks.ucf'): Finding {
  return {file, ...BREAKS_SPAN, code: 'TS2322', severity: 'error', message: NOT_STRING, block: 'react', framework: 'react'};
}

function mainFinding(file = 'pages/main.tsx'): Finding {
  return {file, ...MAIN_SPAN, code: 'TS2322', severity: 'error', message: NOT_STRING};
}

const line = ({file, line, column}: Finding, framework = '') =>
  `${file}:${line}:${column}: error TS2322${framework}: ${NOT_STRING}`;
const BREAKS_LINE = line(breaksFinding(), ' (react)');
const MAIN_LINE = line(mainFinding());

async function withCopy(app: string, check: (root: string) => Promise<void>): Promise<void> {
  const root = await copyApp(app);
  try {
    await check(root);
  } finally {
    await removeApp(root);
  }
}

function editFile(root: string, file: string, from: string, to: string): void {
  const path = join(root, file);
  const text = readFileSync(path, 'utf8');
  if (!text.includes(from)) throw new Error(`${file} has no ${JSON.stringify(from)}`);
  writeFileSync(path, text.replace(from, to));
}

function addFile(root: string, file: string, text: string): void {
  mkdirSync(dirname(join(root, file)), {recursive: true});
  writeFileSync(join(root, file), text);
}

describe('mf-tsc on a whole project', () => {
  it('prints the summary line only on the valid app', async () => {
    await withCopy(VALID, async (root) => {
      expect(await runMfTsc(root)).toEqual({
        code: 0,
        stdout: 'mf-tsc: checked 4 files with tsconfig.json: no errors\n',
        stderr: '',
      });
    });
  });

  it('prints each error of the broken app, at its line in the file the user wrote, and exits 1', async () => {
    await withCopy(BROKEN, async (root) => {
      expect(await runMfTsc(root)).toEqual({
        code: 1,
        stdout: `${BREAKS_LINE}\n${MAIN_LINE}\nmf-tsc: checked 3 files with tsconfig.json: 2 errors\n`,
        stderr: '',
      });
    });
  });

  it('prints the same errors in the shared shape under --format json, each spanning the prop TypeScript marks', async () => {
    await withCopy(BROKEN, async (root) => {
      const run = await runMfTsc(root, ['--format', 'json']);
      expect({code: run.code, stderr: run.stderr}).toEqual({code: 1, stderr: ''});
      const document = report(run.stdout);
      expect(document).toEqual({
        findings: [breaksFinding(), mainFinding()],
        errorCount: 2,
        warningCount: 0,
        projects: [{tsconfig: 'tsconfig.json', files: 3}],
      });
      for (const {file, line, column, end} of document.findings) {
        const source = readFileSync(join(root, file!), 'utf8');
        const start = offsetAt(source, {line: line!, offset: column!});
        expect(source.slice(start, offsetAt(source, {line: end!.line, offset: end!.column}))).toBe('text');
        expect(source.slice(start).startsWith(file!.endsWith('.ucf') ? 'text={42}' : 'text={1}')).toBe(true);
      }
    });
  });
});

describe('mf-tsc on one file or one folder', () => {
  it('checks only the named file, and a file named twice once', async () => {
    await withCopy(BROKEN, async (root) => {
      const once = {code: 1, stdout: `${BREAKS_LINE}\nmf-tsc: checked 1 file with tsconfig.json: 1 error\n`, stderr: ''};
      expect(await runMfTsc(root, ['ReactBreaks.ucf'])).toEqual(once);
      expect(await runMfTsc(root, ['ReactBreaks.ucf', 'ReactBreaks.ucf'])).toEqual(once);
    });
  });

  it('checks only the files below a named folder, never one under its node_modules', async () => {
    await withCopy(BROKEN, async (root) => {
      const broken = 'pages/node_modules/broken/index.ts';
      addFile(root, broken, 'export const broken: string = 1;\n');
      editFile(root, 'tsconfig.json', '"include": ["*.ucf", "pages"]', `"include": ["*.ucf", "pages", "${broken}"]`);
      // It is in the program: named, it is checked.
      const named = await runMfTsc(root, [broken, '--format', 'json']);
      expect(report(named.stdout).findings.map(({file, code}) => ({file, code}))).toEqual([{file: broken, code: 'TS2322'}]);
      const once = {code: 1, stdout: `${MAIN_LINE}\nmf-tsc: checked 1 file with tsconfig.json: 1 error\n`, stderr: ''};
      expect(await runMfTsc(root, ['pages'])).toEqual(once);
      expect(await runMfTsc(root, ['pages', 'pages/main.tsx'])).toEqual(once);
      expect(await runMfTsc(join(root, 'pages'), ['.'])).toEqual({
        ...once,
        stdout: `${line(mainFinding('main.tsx'))}\nmf-tsc: checked 1 file with ../tsconfig.json: 1 error\n`,
      });
    });
  });

  it('finds the tsconfig above a file named from the repo root, or takes it from -p', async () => {
    await withCopy(BROKEN, async (root) => {
      const file = shown(REPO, join(root, 'ReactBreaks.ucf'));
      const config = shown(REPO, join(root, 'tsconfig.json'));
      const expected = {
        code: 1,
        stdout: `${line(breaksFinding(file), ' (react)')}\nmf-tsc: checked 1 file with ${config}: 1 error\n`,
        stderr: '',
      };
      expect(await runMfTsc(REPO, [file])).toEqual(expected);
      expect(await runMfTsc(REPO, ['-p', config, file])).toEqual(expected);
      expect(await runMfTsc(REPO, ['--project', config, file])).toEqual(expected);
    });
  });

  it('checks the files of two apps with each one its own tsconfig', async () => {
    await withCopy(BROKEN, async (broken) => {
      await withCopy(VALID, async (valid) => {
        editFile(valid, 'main.tsx', 'count={2}', "count={'2'}");
        const breaks = shown(REPO, join(broken, 'ReactBreaks.ucf'));
        const main = shown(REPO, join(valid, 'main.tsx'));
        const readable = await runMfTsc(REPO, [breaks, main]);
        expect(readable.code).toBe(1);
        expect(readable.stdout.trimEnd().split('\n').at(-1)).toBe('mf-tsc: checked 2 files with 2 tsconfigs: 2 errors');
        const document = report((await runMfTsc(REPO, [breaks, main, '--format', 'json'])).stdout);
        expect(document.projects).toEqual([
          {tsconfig: shown(REPO, join(broken, 'tsconfig.json')), files: 1},
          {tsconfig: shown(REPO, join(valid, 'tsconfig.json')), files: 1},
        ]);
        const source = readFileSync(join(valid, 'main.tsx'), 'utf8');
        expect(document.findings).toEqual([
          breaksFinding(breaks),
          {
            file: main,
            ...span(source, "count={'2'}", 'count'.length),
            code: 'TS2322',
            severity: 'error',
            message: "Type 'string' is not assignable to type 'number'.",
          },
        ]);
      });
    });
  });
});

describe('mf-tsc with tsconfig references', () => {
  it('checks the referenced project of a root with "files": [], with no path and for one file', async () => {
    await withCopy(BROKEN, async (root) => {
      renameSync(join(root, 'tsconfig.json'), join(root, 'tsconfig.app.json'));
      writeFileSync(join(root, 'tsconfig.json'), '{"files": [], "references": [{"path": "./tsconfig.app.json"}]}\n');
      expect(await runMfTsc(root)).toEqual({
        code: 1,
        stdout: `${BREAKS_LINE}\n${MAIN_LINE}\nmf-tsc: checked 3 files with tsconfig.app.json: 2 errors\n`,
        stderr: '',
      });
      expect(await runMfTsc(root, ['ReactBreaks.ucf'])).toEqual({
        code: 1,
        stdout: `${BREAKS_LINE}\nmf-tsc: checked 1 file with tsconfig.app.json: 1 error\n`,
        stderr: '',
      });
    });
  });
});

describe('mf-tsc findings beside the type errors', () => {
  it("reports the program's own errors with no file", async () => {
    await withCopy(BROKEN, async (root) => {
      editFile(root, 'tsconfig.json', '"skipLibCheck": true,', '"skipLibCheck": true,\n    "types": ["nonexistent"],');
      const run = await runMfTsc(root, ['ReactBreaks.ucf', '--format', 'json']);
      expect(run.code).toBe(1);
      expect(report(run.stdout).findings).toEqual([
        {
          code: 'TS2688',
          severity: 'error',
          message:
            "Cannot find type definition file for 'nonexistent'. The file is in the program because: " +
            "Entry point of type library 'nonexistent' specified in compilerOptions",
        },
        breaksFinding(),
      ]);
    });
  });

  it("reports the splitter's errors of a .ucf file at their positions", async () => {
    await withCopy(BROKEN, async (root) => {
      const {source} = readComponent('invalid/DuplicateReact.ucf');
      const file = join(root, 'DuplicateReact.ucf');
      writeFileSync(file, source);
      const run = await runMfTsc(root, ['DuplicateReact.ucf', '--format', 'json']);
      const split = splitBlocks(source, file);
      expect(split.errors.map(({code}) => code)).toEqual(['duplicate-target', 'duplicate-target']);
      const expected = split.errors.map((error) => ({...findingOf(error, split), file: 'DuplicateReact.ucf'}));
      expect({code: run.code, stderr: run.stderr}).toEqual({code: 1, stderr: ''});
      expect(report(run.stdout).findings).toEqual(expected);
    });
  });

  it('reports a .ucf import the target rules reject with our code, not TypeScript\'s "Cannot find module"', async () => {
    await withCopy(BROKEN, async (root) => {
      const pick = "import Breaks from '../ReactBreaks.ucf' with {framework: 'vue'};\n\nexport {Breaks};\n";
      addFile(root, 'pages/vue-pick.ts', pick);
      const run = await runMfTsc(root, ['pages/vue-pick.ts', '--format', 'json']);
      expect({code: run.code, stderr: run.stderr}).toEqual({code: 1, stderr: ''});
      expect(report(run.stdout).findings).toEqual([
        {
          file: 'pages/vue-pick.ts',
          ...span(pick, "'../ReactBreaks.ucf'"),
          code: 'missing-target-block',
          severity: 'error',
          message: '../ReactBreaks.ucf has no <vue> block; vue-pick.ts imports it as vue',
        },
      ]);
    });
  });
});

describe('mf-tsc that cannot run', () => {
  // Exit 2, nothing on stdout, one line on stderr.
  const fails = (message: string) => ({code: 2, stdout: '', stderr: `mf-tsc: ${message}\n`});

  it('names the real options, the formats and a path that does not exist', async () => {
    await withCopy(BROKEN, async (root) => {
      expect(await runMfTsc(root, ['--nope'])).toEqual(fails("unknown option '--nope'; use --project, --format or --help"));
      expect(await runMfTsc(root, ['--format', 'xml'])).toEqual(fails("unknown format 'xml'; use text or json"));
      expect(await runMfTsc(root, ['nope.ucf'])).toEqual(fails('nope.ucf does not exist'));
    });
  });

  it('names a file no tsconfig holds, one with no tsconfig above it and a folder with no file to check', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'mf-tsc-'));
    try {
      await withCopy(BROKEN, async (root) => {
        addFile(root, 'notes/Loose.ts', 'export const loose = 1;\n');
        expect(await runMfTsc(root, ['notes/Loose.ts'])).toEqual(
          fails('notes/Loose.ts is not part of tsconfig.json; add it to "include" or pass -p')
        );
        const alone = join(outside, 'Alone.ts');
        writeFileSync(alone, 'export const alone = 1;\n');
        expect(await runMfTsc(root, [alone])).toEqual(
          fails(`${shown(root, alone)} has no tsconfig.json above it; add one or pass -p`)
        );
        mkdirSync(join(root, 'empty'));
        expect(await runMfTsc(root, ['empty'])).toEqual(fails('empty holds no file of tsconfig.json'));
      });
    } finally {
      rmSync(outside, {recursive: true, force: true});
    }
  });

  it("names the tsconfig's own errors: a missing -p file, an unknown option, two of them", async () => {
    await withCopy(BROKEN, async (root) => {
      const missing = join(root, 'missing.json').split(sep).join('/');
      expect(await runMfTsc(root, ['-p', 'missing.json'])).toEqual(fails(`error TS5083: Cannot read file '${missing}'.`));
      editFile(root, 'tsconfig.json', '"strict": true,', '"strict": true,\n    "foo": true,');
      const config = readFileSync(join(root, 'tsconfig.json'), 'utf8');
      const {line, offset} = locate(config, '"foo"');
      const unknown = `tsconfig.json:${line}:${offset}: error TS5023: Unknown compiler option 'foo'.`;
      expect(await runMfTsc(root)).toEqual(fails(unknown));
      editFile(root, 'tsconfig.json', '"foo": true,', '"foo": true,\n    "bar": true,');
      expect(await runMfTsc(root, ['ReactBreaks.ucf'])).toEqual(fails(`${unknown} (and 1 more)`));
    });
  });

  it('says when the project has no typescript to load', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'mf-tsc-'));
    try {
      cpSync(join(FIXTURES_DIR, 'apps', BROKEN), outside, {recursive: true});
      // No global install either: Node also looks in NODE_PATH.
      expect(await runMfTsc(outside, [], {NODE_PATH: undefined})).toEqual(
        fails(`typescript is not installed in ${realpathSync(outside)}; add it to devDependencies`)
      );
    } finally {
      rmSync(outside, {recursive: true, force: true});
    }
  });
});

describe('mf-tsc --help', () => {
  it('prints the options, an example and the exit codes, also as -h', async () => {
    const expected = {code: 0, stdout: HELP, stderr: ''};
    expect(await runMfTsc(REPO, ['--help'])).toEqual(expected);
    expect(await runMfTsc(REPO, ['-h'])).toEqual(expected);
  });
});
