// The real `mf-tsc` on real fixture apps: the `<react>` block of each `.ucf` file and the `.ts` / `.tsx` importers.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {createRequire} from 'node:module';
import {homedir, tmpdir} from 'node:os';
import {dirname, join, parse} from 'node:path';
import {findingOf, rootRelativePath, splitBlocks} from '@multifront/core';
import type {Finding} from '@multifront/core';
import {describe, expect, it} from 'vitest';
import {edited} from '../../build/lib/library.ts';
import {FIXTURES_DIR, copyApp, copyAppOutside, readComponent, removeApp} from '../../fixtures/index.ts';
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

type Report = BinReport<{projects: {tsconfig: string; files: number}[]}>;

const fixture = (app: string, file: string) => readFileSync(join(FIXTURES_DIR, 'apps', app, file), 'utf8');
const report = (stdout: string) => JSON.parse(stdout) as Report;

// 1-based start and end of the first `length` characters of `needle` in `source`, on one line.
function span(source: string, needle: string, length = needle.length): Pick<Finding, 'line' | 'column' | 'end'> {
  const {line, offset} = locate(source, needle);
  return {line, column: offset, end: {line, column: offset + length}};
}

// TypeScript marks the prop whose value has the wrong type.
const BREAKS_SPAN = span(fixture(BROKEN, 'ReactBreaks.ucf'), 'text={42}', 'text'.length);
const MAIN_SPAN = span(fixture(BROKEN, 'pages/main.tsx'), 'text={1}', 'text'.length);

function breaksFinding(file = 'ReactBreaks.ucf'): Finding {
  return {file, ...BREAKS_SPAN, code: 'TS2322', severity: 'error', message: NOT_STRING, block: 'react', framework: 'react'};
}

function mainFinding(file = 'pages/main.tsx'): Finding {
  return {file, ...MAIN_SPAN, code: 'TS2322', severity: 'error', message: NOT_STRING};
}

const line = ({file, line, column, code, framework, severity, message}: Finding) =>
  `${file}:${line}:${column}: ${severity} ${code}${framework ? ` (${framework})` : ''}: ${message}`;
const BREAKS_LINE = line(breaksFinding());
const MAIN_LINE = line(mainFinding());

async function withCopy(app: string, check: (root: string) => Promise<void>, copy = copyApp): Promise<void> {
  const root = await copy(app);
  try {
    await check(root);
  } finally {
    await removeApp(root);
  }
}

function withTempDir(check: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mf-tsc-')));
    try {
      await check(dir);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  };
}

function editFile(root: string, file: string, from: string, to: string): void {
  const path = join(root, file);
  writeFileSync(path, edited(readFileSync(path, 'utf8'), from, to));
}

function addFile(root: string, file: string, text: string): void {
  mkdirSync(dirname(join(root, file)), {recursive: true});
  writeFileSync(join(root, file), text);
}

// What the host must not have for a test outside the repo to mean what it says.
function ancestors(dir: string): string[] {
  const dirs = [dir];
  while (dirs.at(-1) !== parse(dir).root) dirs.push(dirname(dirs.at(-1)!));
  return dirs;
}

function assertNoConfigAbove(dir: string): void {
  const found = ancestors(dir).filter((folder) => existsSync(join(folder, 'tsconfig.json')));
  expect(found, 'a tsconfig.json above the temp folder changes what mf-tsc finds').toEqual([]);
}

function assertNoTypeScriptFor(dir: string): void {
  const globals = [join(homedir(), '.node_modules'), join(homedir(), '.node_libraries')];
  const folders = [...ancestors(dir).map((folder) => join(folder, 'node_modules')), ...globals];
  const found = folders.filter((folder) => existsSync(join(folder, 'typescript')));
  expect(found, 'a typescript install the temp copy can reach').toEqual([]);
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

  it('says when its tsconfig holds no file to check', async () => {
    await withCopy(BROKEN, async (root) => {
      addFile(root, 'pages/node_modules/broken/index.ts', 'export const broken: string = 1;\n');
      editFile(root, 'tsconfig.json', '"include": ["*.ucf", "pages"]', '"include": ["pages/node_modules/broken/index.ts"]');
      expect(await runMfTsc(root)).toEqual({code: 2, stdout: '', stderr: 'mf-tsc: tsconfig.json holds no file to check\n'});
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

  it('checks only the files below a named folder, never one under its node_modules or a dot folder', async () => {
    await withCopy(BROKEN, async (root) => {
      const skipped = ['pages/node_modules/broken/index.ts', 'pages/.cache/hidden.ts'];
      for (const file of skipped) addFile(root, file, 'export const broken: string = 1;\n');
      const include = ['*.ucf', 'pages', ...skipped].map((entry) => JSON.stringify(entry)).join(', ');
      editFile(root, 'tsconfig.json', '"include": ["*.ucf", "pages"]', `"include": [${include}]`);
      // Both are in the program: named, each is checked.
      const named = await runMfTsc(root, [...skipped, '--format', 'json']);
      expect(report(named.stdout).findings.map(({file, code}) => ({file, code}))).toEqual([
        {file: 'pages/.cache/hidden.ts', code: 'TS2322'},
        {file: 'pages/node_modules/broken/index.ts', code: 'TS2322'},
      ]);
      const once = {code: 1, stdout: `${MAIN_LINE}\nmf-tsc: checked 1 file with tsconfig.json: 1 error\n`, stderr: ''};
      expect(await runMfTsc(root, ['pages'])).toEqual(once);
      expect(await runMfTsc(root, ['pages', 'pages/main.tsx'])).toEqual(once);
      expect(await runMfTsc(root, ['-p', 'tsconfig.json', 'pages'])).toEqual(once);
      expect(await runMfTsc(join(root, 'pages'), ['.'])).toEqual({
        ...once,
        stdout: `${line(mainFinding('main.tsx'))}\nmf-tsc: checked 1 file with ../tsconfig.json: 1 error\n`,
      });
    });
  });

  it(
    'takes the tsconfig below a named folder when none is above it',
    withTempDir(async (dir) => {
      assertNoConfigAbove(dir);
      const source = 'export const a: string = 1;\n';
      addFile(dir, 'sub/a.ts', source);
      addFile(dir, 'sub/tsconfig.json', '{"compilerOptions": {"strict": true, "types": []}, "include": ["."]}\n');
      await withCopy(BROKEN, async (root) => {
        const file = rootRelativePath(root, join(dir, 'sub', 'a.ts'));
        const finding: Finding = {file, ...span(source, 'a'), code: 'TS2322', severity: 'error', message: NOT_STRING};
        expect(await runMfTsc(root, [dir])).toEqual({
          code: 1,
          stdout: `${line(finding)}\nmf-tsc: checked 1 file with ${rootRelativePath(root, join(dir, 'sub', 'tsconfig.json'))}: 1 error\n`,
          stderr: '',
        });
      });
    })
  );

  it('finds the tsconfig above a file named from the repo root, or takes it from -p', async () => {
    await withCopy(BROKEN, async (root) => {
      const file = rootRelativePath(REPO, join(root, 'ReactBreaks.ucf'));
      const config = rootRelativePath(REPO, join(root, 'tsconfig.json'));
      const expected = {
        code: 1,
        stdout: `${line(breaksFinding(file))}\nmf-tsc: checked 1 file with ${config}: 1 error\n`,
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
        const breaks = rootRelativePath(REPO, join(broken, 'ReactBreaks.ucf'));
        const main = rootRelativePath(REPO, join(valid, 'main.tsx'));
        const readable = await runMfTsc(REPO, [breaks, main]);
        expect(readable.code).toBe(1);
        expect(readable.stdout.trimEnd().split('\n').at(-1)).toBe('mf-tsc: checked 2 files with 2 tsconfigs: 2 errors');
        const document = report((await runMfTsc(REPO, [breaks, main, '--format', 'json'])).stdout);
        expect(document.projects).toEqual([
          {tsconfig: rootRelativePath(REPO, join(broken, 'tsconfig.json')), files: 1},
          {tsconfig: rootRelativePath(REPO, join(valid, 'tsconfig.json')), files: 1},
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
      // A reference back to the root: each project is visited once.
      editFile(
        root,
        'tsconfig.app.json',
        '"include": ["*.ucf", "pages"]',
        '"include": ["*.ucf", "pages"],\n  "references": [{"path": "./tsconfig.json"}]'
      );
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

  it('reports one file imported as two frameworks as a warning, counted apart from the errors', async () => {
    await withCopy(BROKEN, async (root) => {
      // The last import's resolution wins: React's, which resolves, so only the Vue import is an error.
      const mixed =
        "import VueTitle from '../Title.ucf' with {framework: 'vue'};\nimport Title from '../Title.ucf';\n\nexport {Title, VueTitle};\n";
      addFile(root, 'pages/mixed.ts', mixed);
      const missing: Finding = {
        file: 'pages/mixed.ts',
        ...span(mixed, "'../Title.ucf' with", "'../Title.ucf'".length),
        code: 'missing-target-block',
        severity: 'error',
        message: '../Title.ucf has no <vue> block; mixed.ts imports it as vue',
      };
      const warning: Finding = {
        file: 'pages/mixed.ts',
        ...span(mixed, "'../Title.ucf';", "'../Title.ucf'".length),
        code: 'mixed-frameworks',
        severity: 'warning',
        message:
          '../Title.ucf is imported as vue and as react in this file; TypeScript keeps one resolution per specifier, so ' +
          "every import of it here gets the last one's types. Import each framework from its own small re-export file",
      };
      const json = await runMfTsc(root, ['pages/mixed.ts', '--format', 'json']);
      expect(json.code).toBe(1);
      expect(report(json.stdout)).toMatchObject({findings: [missing, warning], errorCount: 1, warningCount: 1});
      expect(await runMfTsc(root, ['pages/mixed.ts'])).toEqual({
        code: 1,
        stdout: `${line(missing)}\n${line(warning)}\nmf-tsc: checked 1 file with tsconfig.json: 1 error, 1 warning\n`,
        stderr: '',
      });
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

  it(
    'names a file no tsconfig holds, a path with no tsconfig above it and a folder with no file to check',
    withTempDir(async (dir) => {
      assertNoConfigAbove(dir);
      await withCopy(BROKEN, async (root) => {
        addFile(root, 'notes/Loose.ts', 'export const loose = 1;\n');
        expect(await runMfTsc(root, ['notes/Loose.ts'])).toEqual(
          fails('notes/Loose.ts is not part of tsconfig.json; add it to "include" or pass -p')
        );
        const alone = join(dir, 'Alone.ts');
        writeFileSync(alone, 'export const alone = 1;\n');
        expect(await runMfTsc(root, [alone])).toEqual(
          fails(`${rootRelativePath(root, alone)} has no tsconfig.json above it; add one or pass -p`)
        );
        expect(await runMfTsc(root, [dir])).toEqual(
          fails(`${rootRelativePath(root, dir)} has no tsconfig.json above or in it; add one or pass -p`)
        );
        mkdirSync(join(root, 'empty'));
        expect(await runMfTsc(root, ['empty'])).toEqual(fails('empty holds no file of tsconfig.json'));
      });
    })
  );

  it(
    'says when there is no tsconfig above the current folder',
    withTempDir(async (dir) => {
      assertNoConfigAbove(dir);
      // The repo's own typescript, installed in the temp folder.
      const typescript = dirname(realpathSync(createRequire(import.meta.url).resolve('typescript/package.json')));
      mkdirSync(join(dir, 'node_modules'));
      symlinkSync(typescript, join(dir, 'node_modules', 'typescript'), 'junction');
      expect(await runMfTsc(dir)).toEqual(fails('no tsconfig.json in . or above it; add one or pass -p'));
    })
  );

  it("names the tsconfig's own errors: a missing -p file, an unknown option, two of them", async () => {
    await withCopy(BROKEN, async (root) => {
      const missing = join(root, 'missing.json').replaceAll('\\', '/');
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
    await withCopy(
      BROKEN,
      async (root) => {
        assertNoTypeScriptFor(root);
        // No global install either: Node also looks in NODE_PATH.
        expect(await runMfTsc(root, [], {NODE_PATH: undefined})).toEqual(
          fails(`typescript is not installed in ${realpathSync(root)}; add it to devDependencies`)
        );
      },
      copyAppOutside
    );
  });
});

describe('mf-tsc --help', () => {
  it('prints the options, an example and the exit codes, also as -h', async () => {
    const expected = {code: 0, stdout: HELP, stderr: ''};
    expect(await runMfTsc(REPO, ['--help'])).toEqual(expected);
    expect(await runMfTsc(REPO, ['-h'])).toEqual(expected);
  });
});
