// The real `mf-fmt` on copies of `lint-format/`: each block through oxfmt's `format()`, checked against the oxfmt CLI.
import {cpSync, mkdirSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {BLOCK_KINDS, findingOf, splitBlocks} from '@multifront/core';
import type {Finding} from '@multifront/core';
import {blockFile} from '@multifront/language-tools';
import {describe, expect, it} from 'vitest';
import {buildApp} from '../../build/lib/build.ts';
import {FIXTURES_DIR, copyAppOutside, readComponent} from '../../fixtures/index.ts';
import {runMfFmt, runMfTsc} from '../lib/commands.ts';
import {LINT_FORMAT, MESSY, SENT, contents, fails, outsideBlocks, oxfmtCli, read, report} from '../lib/format.ts';
import {assertNotInstalled, editFile, span, withCopy} from '../lib/tsc.ts';
import {locate} from '../lib/tsserver.ts';

const HELP = `Usage: mf-fmt [options] [paths...]

Formats each block of .ucf files with oxfmt and the project's .oxfmtrc.json.
Paths are .ucf files or folders; none formats every .ucf file under the current folder.

Options:
  --check             write nothing; list the files that are not formatted
  --format <format>   text or json (default: text)
  -h, --help          show this help

Example:
  mf-fmt --check src/Card.ucf

Exit codes: 0 no errors, 1 errors found, 2 the command could not run (bad usage, config or setup).
`;
const ORIGINAL = read(join(FIXTURES_DIR, 'apps', LINT_FORMAT), MESSY);
const FORMATTED_ONE = {code: 0, stdout: 'mf-fmt: formatted 1 of 1 files\n', stderr: ''};

function copyMessy(root: string, folders: string[]): void {
  for (const folder of folders) {
    mkdirSync(join(root, folder), {recursive: true});
    cpSync(join(root, MESSY), join(root, folder, MESSY));
  }
}

/** Each block oxfmt formats equals the oxfmt CLI's output for the same text, under the block file's name. */
function expectCliOutput(root: string, file: string): void {
  const before = contents(ORIGINAL);
  const after = contents(read(root, file));
  for (const [tag, ending] of Object.entries(SENT)) {
    const cli = oxfmtCli(root, `${file}.${tag}${ending}`, before[tag as keyof typeof before]!);
    expect(after[tag as keyof typeof after], `<${tag}> of ${file}`).toBe(`\n${cli}`);
  }
}

// The `mf-fmt` output of the fixture, from a copy of its own.
async function formattedText(): Promise<string> {
  let text = '';
  await withCopy(LINT_FORMAT, async (root) => {
    expect(await runMfFmt(root)).toEqual(FORMATTED_ONE);
    text = read(root, MESSY);
  });
  return text;
}

function firstDifference(one: string, other: string): number {
  let at = 0;
  while (one[at] === other[at]) at++;
  return at;
}

describe('mf-fmt on the fixture', () => {
  it('formats each block as the oxfmt CLI formats its block file, overrides and .editorconfig included', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      expect(await runMfFmt(root)).toEqual(FORMATTED_ONE);
      expectCliOutput(root, MESSY);
      // The `*.vue` override and the `[*.tsx]` section both reach their block.
      const after = contents(read(root, MESSY));
      expect(after.vue).toContain("import { ref } from 'vue';\n");
      expect(after.react).toContain("import { useState } from 'react'\n");
      expect(after.react).toContain('    return (\n');
    });
  });

  it('leaves the <svelte> block and all text outside the blocks byte for byte', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      await runMfFmt(root);
      const after = read(root, MESSY);
      expect(after).not.toBe(ORIGINAL);
      expect(contents(after).svelte).toBe(contents(ORIGINAL).svelte);
      expect(outsideBlocks(after)).toBe(outsideBlocks(ORIGINAL));
    });
  });

  it('changes nothing on a second run, and --check then passes', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      await runMfFmt(root);
      const once = read(root, MESSY);
      expect(await runMfFmt(root)).toEqual({code: 0, stdout: 'mf-fmt: formatted 0 of 1 files\n', stderr: ''});
      expect(read(root, MESSY)).toBe(once);
      expect(await runMfFmt(root, ['--check'])).toEqual({code: 0, stdout: 'mf-fmt: 0 of 1 files not formatted\n', stderr: ''});
    });
  });

  it('gives a copy that still type-checks and builds in every target', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      await runMfFmt(root);
      expect(await runMfTsc(root)).toEqual({
        code: 0,
        stdout: 'mf-tsc: checked 4 files with tsconfig.json: no errors\n',
        stderr: '',
      });
      const input = Object.fromEntries(['react', 'vue', 'svelte'].map((name) => [name, join(root, `${name}.ts`)]));
      const {chunks} = await buildApp(root, {build: {rolldownOptions: {input}}});
      expect(
        chunks
          .filter((chunk) => chunk.isEntry)
          .map((chunk) => chunk.name)
          .sort()
      ).toEqual(['react', 'svelte', 'vue']);
    });
  });
});

describe('mf-fmt --check', () => {
  it('names the file at its first unformatted character, writes nothing and exits 1', async () => {
    const at = firstDifference(ORIGINAL, await formattedText());
    const block = splitBlocks(ORIGINAL, MESSY).blocks.find(({start, end}) => start <= at && at < end)!.type;
    const before = ORIGINAL.slice(0, at).split('\n');
    const position = {line: before.length, column: before.at(-1)!.length + 1};
    const finding: Finding = {
      file: MESSY,
      ...position,
      end: position,
      code: 'unformatted',
      severity: 'error',
      message: `not formatted; run mf-fmt ${MESSY}`,
      block,
    };
    await withCopy(LINT_FORMAT, async (root) => {
      expect(await runMfFmt(root, ['--check'])).toEqual({
        code: 1,
        stdout: `${MESSY}:${position.line}:${position.column}: error unformatted: ${finding.message}\nmf-fmt: 1 of 1 files not formatted\n`,
        stderr: '',
      });
      const json = await runMfFmt(root, ['--check', '--format', 'json']);
      expect(json.code).toBe(1);
      expect(report(json.stdout)).toEqual({findings: [finding], errorCount: 1, warningCount: 0, files: 1, changed: [MESSY]});
      expect(read(root, MESSY)).toBe(ORIGINAL);
    });
  });
});

describe('mf-fmt on one file or one folder', () => {
  it('formats only the named file or the files below the named folder, never a dot folder or an ignored one', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      copyMessy(root, ['nested', '.hidden', 'old']);
      expect(await runMfFmt(root, ['nested'])).toEqual(FORMATTED_ONE);
      expect(read(root, MESSY)).toBe(ORIGINAL);
      expect(read(root, 'nested/Messy.ucf')).not.toBe(ORIGINAL);
      const json = await runMfFmt(root, [MESSY, '--format', 'json']);
      expect({code: json.code, stderr: json.stderr}).toEqual({code: 0, stderr: ''});
      expect(report(json.stdout)).toEqual({findings: [], errorCount: 0, warningCount: 0, files: 1, changed: [MESSY]});
      expect(await runMfFmt(root, [MESSY, MESSY])).toEqual({code: 0, stdout: 'mf-fmt: formatted 0 of 1 files\n', stderr: ''});
      expect(await runMfFmt(root)).toEqual({code: 0, stdout: 'mf-fmt: formatted 0 of 2 files\n', stderr: ''});
      expect(read(root, '.hidden/Messy.ucf')).toBe(ORIGINAL);
      expect(read(root, 'old/Messy.ucf')).toBe(ORIGINAL);
    });
  });

  it('follows the .oxfmtrc.json nearest above each file, inheriting nothing from the one above it', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      copyMessy(root, ['nested']);
      writeFileSync(join(root, 'nested', '.oxfmtrc.json'), '{"printWidth": 40}\n');
      expect(await runMfFmt(root)).toEqual({code: 0, stdout: 'mf-fmt: formatted 2 of 2 files\n', stderr: ''});
      expectCliOutput(root, MESSY);
      expectCliOutput(root, 'nested/Messy.ucf');
      expect(contents(read(root, 'nested/Messy.ucf')).react).not.toBe(contents(read(root, MESSY)).react);
    });
  });
});

describe('mf-fmt on blocks it cannot format', () => {
  async function expectFormatError(edit: [string, string], needle: string, length: number, shift: number, message: string) {
    await withCopy(LINT_FORMAT, async (root) => {
      editFile(root, MESSY, ...edit);
      const source = read(root, MESSY);
      const run = await runMfFmt(root, ['--format', 'json']);
      expect({code: run.code, stderr: run.stderr}).toEqual({code: 1, stderr: ''});
      const block = message.slice(1, message.indexOf('>')) as Finding['block'];
      expect(report(run.stdout)).toEqual({
        findings: [
          {file: MESSY, ...span(source, needle, length, shift), code: 'format-error', severity: 'error', message, block},
        ],
        errorCount: 1,
        warningCount: 0,
        files: 1,
        changed: [],
      });
      expect(read(root, MESSY)).toBe(source);
    });
  }

  it("reports a <react> parse error at oxfmt's span in the .ucf file, and leaves the file as written", async () => {
    await expectFormatError(
      ['setCount(count+1)', 'setCount(count+)'],
      'count+)',
      1,
      'count+'.length,
      '<react> does not parse: Unexpected token'
    );
  });

  it("reports a <vue> error that has only Prettier's line and column, at that point", async () => {
    await expectFormatError(
      ['{{ count }}</button>', '{{ count }}</span>'],
      '</span>',
      0,
      0,
      '<vue> does not parse: Unexpected closing tag "span". It may happen when the tag has already been closed by another tag. ' +
        'For more info see https://www.w3.org/TR/html5/syntax.html#closing-elements-that-have-implied-end-tags'
    );
  });

  it("reports the splitter's errors and leaves the file as written", async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      const {source} = readComponent('invalid/DuplicateReact.ucf');
      const file = join(root, 'DuplicateReact.ucf');
      writeFileSync(file, source);
      const split = splitBlocks(source, file);
      expect(split.errors.map(({code}) => code)).toEqual(['duplicate-target', 'duplicate-target']);
      const run = await runMfFmt(root, ['DuplicateReact.ucf', '--format', 'json']);
      expect({code: run.code, stderr: run.stderr}).toEqual({code: 1, stderr: ''});
      expect(report(run.stdout).findings).toEqual(
        split.errors.map((error) => ({...findingOf(error, split), file: 'DuplicateReact.ucf'}))
      );
      expect(read(root, 'DuplicateReact.ucf')).toBe(source);
    });
  });
});

describe('mf-fmt that cannot run', () => {
  it('names an unknown option, a file that is not .ucf, a missing path, a folder with nothing to format and an ignored file', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      copyMessy(root, ['old']);
      mkdirSync(join(root, 'empty'));
      expect(await runMfFmt(root, ['--nope'])).toEqual(fails("unknown option '--nope'; use --check, --format or --help"));
      expect(await runMfFmt(root, ['react.ts'])).toEqual(fails('react.ts is not a .ucf file; format it with oxfmt'));
      expect(await runMfFmt(root, ['nope.ucf'])).toEqual(fails('nope.ucf does not exist'));
      expect(await runMfFmt(root, ['empty'])).toEqual(fails('empty holds no .ucf file'));
      expect(await runMfFmt(root, ['old'])).toEqual(fails('old holds no .ucf file'));
      expect(await runMfFmt(root, ['old/Messy.ucf'])).toEqual(fails('old/Messy.ucf is ignored by .oxfmtrc.json'));
    });
  });

  it('names an .oxfmtrc.json that is not JSON, not an object, or holds a value oxfmt rejects', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      const config = join(root, '.oxfmtrc.json');
      writeFileSync(config, '{\n  semi: false\n}\n');
      const text = read(root, '.oxfmtrc.json');
      const {line, offset} = locate(text, 'semi');
      const position = `at position ${text.indexOf('semi')} (line ${line} column ${offset})`;
      expect(await runMfFmt(root)).toEqual(fails(`.oxfmtrc.json: Expected property name or '}' in JSON ${position}`));
      writeFileSync(config, '[]\n');
      expect(await runMfFmt(root)).toEqual(fails('.oxfmtrc.json: not a JSON object'));
      writeFileSync(config, '{"printWidth": 1000}\n');
      expect(await runMfFmt(root)).toEqual(
        fails('.oxfmtrc.json: Invalid printWidth: The line width should be between 1 and 320')
      );
      expect(read(root, MESSY)).toBe(ORIGINAL);
    });
  });

  it('says when the project has no oxfmt to load', async () => {
    await withCopy(
      LINT_FORMAT,
      async (root) => {
        assertNotInstalled(root, 'oxfmt');
        // No global install either: Node also looks in NODE_PATH.
        expect(await runMfFmt(root, [], {NODE_PATH: undefined})).toEqual(
          fails(`oxfmt is not installed in ${realpathSync(root)}; add it to devDependencies`)
        );
      },
      copyAppOutside
    );
  });
});

describe('mf-fmt --help', () => {
  it('prints the options, an example and the exit codes, also as -h', async () => {
    const expected = {code: 0, stdout: HELP, stderr: ''};
    expect(await runMfFmt(FIXTURES_DIR, ['--help'])).toEqual(expected);
    expect(await runMfFmt(FIXTURES_DIR, ['-h'])).toEqual(expected);
  });
});

describe('blockFile', () => {
  // A new block kind fails here until it names its block file.
  const ENDINGS: Record<string, string> = {style: '.css', vue: '.vue', react: '.tsx', svelte: '.svelte'};

  it('names the block file of every block kind, and of each <style lang>', () => {
    for (const {tag} of BLOCK_KINDS) {
      const [block] = splitBlocks(`<${tag}></${tag}>\n`, 'Card.ucf').blocks;
      expect(blockFile('Card.ucf', block!), tag).toBe(`Card.ucf.${tag}${ENDINGS[tag]}`);
    }
    for (const lang of ['scss', 'less', 'stylus']) {
      const [block] = splitBlocks(`<style lang="${lang}"></style>\n`, 'Card.ucf').blocks;
      expect(blockFile('src/Card.ucf', block!)).toBe(`src/Card.ucf.style.${lang}`);
    }
  });
});
