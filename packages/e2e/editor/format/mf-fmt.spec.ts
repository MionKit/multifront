// The real `mf-fmt` on copies of `lint-format/`: each block through oxfmt's `format()`, checked against the oxfmt CLI.
import {cpSync, mkdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {BLOCK_KINDS, findingOf, splitBlocks} from '@multifront/core';
import type {Finding} from '@multifront/core';
import {blockFile} from '@multifront/language-tools';
import {describe, expect, it} from 'vitest';
import {buildApp} from '../../build/lib/build.ts';
import {FIXTURES_DIR, componentPath, copyAppOutside, readComponent} from '../../fixtures/index.ts';
import {runMfFmt, runMfTsc} from '../lib/commands.ts';
import {
  LINT_FORMAT,
  MESSY,
  ORIGINAL,
  contents,
  copyInto,
  expectCliOutput,
  fails,
  formatConfigsAbove,
  linkOxfmt,
  outsideBlocks,
  oxfmtCli,
  read,
  report,
} from '../lib/format.ts';
import {addFile, assertNotInstalled, editFile, span, withCopy} from '../lib/tsc.ts';
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
const FORMATTED_ONE = {code: 0, stdout: 'mf-fmt: formatted 1 of 1 files\n', stderr: ''};
const INVALID_PRINT_WIDTH = 'Invalid printWidth: The line width should be between 1 and 320';

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
      const after = contents(read(root, MESSY));
      // The `*.vue` override, the excluded `*.tsx` one, the `./`-anchored one and the `[*.tsx]` section reach their block.
      expect(after.vue).toContain("import { ref } from 'vue';\n");
      expect(after.react).toContain("import { useState } from 'react'\n");
      expect(after.react).toContain('    return (\n');
      expect(after.style).toContain('\n  padding: $gap;\n');
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

  it('formats plain CSS and Less blocks as the oxfmt CLI does, leaves Stylus and an empty block as written', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      for (const name of ['Badge.ucf', 'editor/LessModule.ucf', 'langs/StylusPlain.ucf'])
        cpSync(componentPath(name), join(root, name));
      editFile(root, 'Badge.ucf', '.badge {\n  display: inline-block;', '.badge{display:inline-block;');
      editFile(root, MESSY, '</svelte>\n', '</svelte>\n\n<style>\n  \n</style>\n');
      const before = (file: string) => splitBlocks(read(join(FIXTURES_DIR, 'components'), file), file).styles[0]!.content;
      const sources = {
        css: read(root, 'Badge.ucf'),
        less: before('editor/LessModule.ucf'),
        stylus: before('langs/StylusPlain.ucf'),
      };
      expect(await runMfFmt(root)).toEqual({code: 0, stdout: 'mf-fmt: formatted 4 of 4 files\n', stderr: ''});
      const style = (file: string, index = 0) => splitBlocks(read(root, file), file).styles[index]!.content;
      const badge = splitBlocks(sources.css, 'Badge.ucf').styles[0]!.content;
      expect(style('Badge.ucf')).toBe(`\n${oxfmtCli(root, 'Badge.ucf.style.css', badge)}`);
      expect(style('editor/LessModule.ucf')).toBe(`\n${oxfmtCli(root, 'editor/LessModule.ucf.style.less', sources.less)}`);
      expect(style('langs/StylusPlain.ucf')).toBe(sources.stylus);
      expect(read(root, MESSY)).toContain('</svelte>\n\n<style></style>\n');
    });
  });
});

describe('mf-fmt with other configs', () => {
  it('reads only the .editorconfig when there is no .oxfmtrc.json, its sections as oxfmt matches them and every field it takes', async () => {
    await withCopy(
      LINT_FORMAT,
      async (root) => {
        expect(formatConfigsAbove(root), 'an oxfmt config above the temp copy changes what both tools find').toEqual([]);
        linkOxfmt(root);
        // mf-lint's fixtures: only `.oxfmtrc.json` keeps them out of the count.
        for (const file of ['.oxfmtrc.json', 'Lint.ucf', 'Clean.ucf']) rmSync(join(root, file));
        writeFileSync(
          join(root, '.editorconfig'),
          [
            'root = true',
            '[*]',
            'indent_style = tab',
            'tab_width = 3',
            'end_of_line = crlf',
            'insert_final_newline = false',
            'quote_type = single',
            // oxfmt's reader: a name with no `*` matches only at the top, a leading `/` never, `*` crosses folders.
            '[Messy.ucf.style.scss]',
            'indent_style = space',
            'indent_size = 6',
            '[/Messy.ucf.react.tsx]',
            'indent_style = space',
            '[nested*.vue]',
            'max_line_length = 40',
            '',
          ].join('\n')
        );
        copyInto(root, MESSY, ['nested']);
        expect(await runMfFmt(root, [], {NODE_PATH: undefined})).toEqual({
          code: 0,
          stdout: 'mf-fmt: formatted 2 of 2 files\n',
          stderr: '',
        });
        expectCliOutput(root, MESSY, '\r\n');
        expectCliOutput(root, 'nested/Messy.ucf', '\r\n');
        const [own, nested] = [contents(read(root, MESSY)), contents(read(root, 'nested/Messy.ucf'))];
        expect(own.react).toContain("from 'react';\r\n");
        expect(own.react).toContain('\r\n\tconst [count');
        expect(own.style).toContain('\r\n      padding: $gap;');
        expect(nested.style).toContain('\r\n\tpadding: $gap;');
        expect(nested.vue).not.toBe(own.vue);
      },
      copyAppOutside
    );
  });

  it('formats the files of a folder by their own .oxfmtrc.jsonc, inheriting nothing from the one above it', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      copyInto(root, MESSY, ['nested']);
      writeFileSync(join(root, 'nested', '.oxfmtrc.jsonc'), '{\n  "printWidth": 40, // narrower than the app\n}\n');
      expect(await runMfFmt(root)).toEqual({code: 0, stdout: 'mf-fmt: formatted 2 of 2 files\n', stderr: ''});
      expectCliOutput(root, MESSY);
      expectCliOutput(root, 'nested/Messy.ucf');
      expect(contents(read(root, 'nested/Messy.ucf')).react).not.toBe(contents(read(root, MESSY)).react);
    });
  });
});

describe('mf-fmt --check', () => {
  it('names each file at its first unformatted character, writes nothing and exits 1', async () => {
    let formatted = '';
    await withCopy(LINT_FORMAT, async (root) => {
      await runMfFmt(root);
      formatted = read(root, MESSY);
    });
    const at = firstDifference(ORIGINAL, formatted);
    const block = splitBlocks(ORIGINAL, MESSY).blocks.find(({start, end}) => start <= at && at < end)!.type;
    const before = ORIGINAL.slice(0, at).split('\n');
    const position = {line: before.length, column: before.at(-1)!.length + 1};
    const finding = (file: string): Finding => ({
      file,
      ...position,
      end: position,
      code: 'unformatted',
      severity: 'error',
      message: `not formatted; run mf-fmt ${file}`,
      block,
    });
    await withCopy(LINT_FORMAT, async (root) => {
      expect(await runMfFmt(root, ['--check'])).toEqual({
        code: 1,
        stdout: `${MESSY}:${position.line}:${position.column}: error unformatted: ${finding(MESSY).message}\nmf-fmt: 1 of 1 files not formatted\n`,
        stderr: '',
      });
      const json = await runMfFmt(root, ['--check', '--format', 'json']);
      expect(json.code).toBe(1);
      expect(report(json.stdout)).toEqual({
        findings: [finding(MESSY)],
        errorCount: 1,
        warningCount: 0,
        files: 1,
        changed: [MESSY],
      });
      copyInto(root, MESSY, ['nested']);
      const both = await runMfFmt(root, ['--check', '--format', 'json']);
      const changed = [MESSY, 'nested/Messy.ucf'];
      expect(report(both.stdout)).toEqual({findings: changed.map(finding), errorCount: 2, warningCount: 0, files: 2, changed});
      expect((await runMfFmt(root, ['--check'])).stdout.split('\n').at(-2)).toBe('mf-fmt: 2 of 2 files not formatted');
      expect(read(root, MESSY)).toBe(ORIGINAL);
    });
  });
});

describe('mf-fmt on one file or one folder', () => {
  it('checks only root <script>s of known lang: not one in a comment, a kebab-case tag or lang="coffee"', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      const source =
        '<vue lang="vue">\n<template><!-- <script>let a = ;</script> --><script-editor  v-model="code"></script-editor></template>\n' +
        '<script lang="coffee">square = (x) -> x * x</script>\n</vue>\n';
      addFile(root, 'Lookalikes.ucf', source);
      expect(await runMfFmt(root, ['Lookalikes.ucf'])).toEqual(FORMATTED_ONE);
      expect(read(root, 'Lookalikes.ucf')).toContain('<script lang="coffee">\nsquare = (x) -> x * x\n</script>');
    });
  });

  it('formats only the named file or the files below the named folder, never a dot folder or an ignored one', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      copyInto(root, MESSY, ['nested', '.hidden', 'old']);
      expect(await runMfFmt(root, ['nested'])).toEqual(FORMATTED_ONE);
      expect(read(root, MESSY)).toBe(ORIGINAL);
      // Under the app's config: the `./`-anchored override stays at the top, the `nested/*.vue` one reaches here.
      expectCliOutput(root, 'nested/Messy.ucf');
      const json = await runMfFmt(root, [MESSY, '--format', 'json']);
      expect({code: json.code, stderr: json.stderr}).toEqual({code: 0, stderr: ''});
      expect(report(json.stdout)).toEqual({findings: [], errorCount: 0, warningCount: 0, files: 1, changed: [MESSY]});
      const [own, nested] = [contents(read(root, MESSY)), contents(read(root, 'nested/Messy.ucf'))];
      expect(nested.style).not.toBe(own.style);
      expect(nested.vue).not.toBe(own.vue);
      expect(await runMfFmt(root, [MESSY, MESSY])).toEqual({code: 0, stdout: 'mf-fmt: formatted 0 of 1 files\n', stderr: ''});
      expect(await runMfFmt(root)).toEqual({code: 0, stdout: 'mf-fmt: formatted 0 of 2 files\n', stderr: ''});
      expect(read(root, '.hidden/Messy.ucf')).toBe(ORIGINAL);
      expect(read(root, 'old/Messy.ucf')).toBe(ORIGINAL);
    });
  });
});

describe('mf-fmt on blocks it cannot format', () => {
  async function formatErrors(edit: (root: string) => string): Promise<{source: string; findings: Finding[]}> {
    let result = {source: '', findings: [] as Finding[]};
    await withCopy(LINT_FORMAT, async (root) => {
      const file = edit(root);
      const source = read(root, file);
      const run = await runMfFmt(root, [file, '--format', 'json']);
      expect({code: run.code, stderr: run.stderr}).toEqual({code: 1, stderr: ''});
      expect(report(run.stdout)).toMatchObject({errorCount: 1, warningCount: 0, files: 1, changed: []});
      expect(read(root, file)).toBe(source);
      result = {source, findings: report(run.stdout).findings};
    });
    return result;
  }

  const formatError = (file: string, at: Pick<Finding, 'line' | 'column' | 'end'>, message: string): Finding => ({
    file,
    ...at,
    code: 'format-error',
    severity: 'error',
    message,
    block: message.slice(1, message.indexOf('>')) as Finding['block'],
  });

  it("reports a <react> parse error at oxfmt's span in the .ucf file, past text that is not ASCII", async () => {
    const {source, findings} = await formatErrors((root) => {
      editFile(root, MESSY, 'setCount(count+1)', "setCount('é ü'+count+)");
      return MESSY;
    });
    expect(findings).toEqual([
      formatError(MESSY, span(source, 'count+)', 1, 'count+'.length), '<react> does not parse: Unexpected token'),
    ]);
  });

  it("reports a <vue> error that has only Prettier's line and column, at that point, on a later line and on the first", async () => {
    const UNEXPECTED_SPAN =
      '<vue> does not parse: Unexpected closing tag "span". It may happen when the tag has already been closed by another tag. ' +
      'For more info see https://www.w3.org/TR/html5/syntax.html#closing-elements-that-have-implied-end-tags';
    const later = await formatErrors((root) => {
      editFile(root, MESSY, '{{ count }}</button>', '{{ count }}</span>');
      return MESSY;
    });
    expect(later.findings).toEqual([formatError(MESSY, span(later.source, '</span>', 0), UNEXPECTED_SPAN)]);
    const first = await formatErrors((root) => {
      addFile(root, 'FirstLine.ucf', '<vue><template><p>é</span></template></vue>\n');
      return 'FirstLine.ucf';
    });
    expect(first.findings).toEqual([formatError('FirstLine.ucf', span(first.source, '</span>', 0), UNEXPECTED_SPAN)]);
  });

  it('reports a <vue> <script> that does not parse at its span, past a generic holding `>` and text that is not ASCII', async () => {
    const {source, findings} = await formatErrors((root) => {
      editFile(root, MESSY, '<script setup lang="ts">', '<script setup lang="ts" generic="T extends Record<string, \'é\'>">');
      editFile(root, MESSY, 'const count=ref(0)', "const count=ref('é ü'+)");
      return MESSY;
    });
    expect(findings).toEqual([
      formatError(MESSY, span(source, "'é ü'+)", 1, "'é ü'+".length), '<vue> does not parse: Unexpected token'),
    ]);
  });

  it('reads a <vue> <script> with no lang as JavaScript and checks each root <script>, the broken one after a valid one', async () => {
    const {source, findings} = await formatErrors((root) => {
      addFile(
        root,
        'Scripts.ucf',
        '<vue lang="vue">\n<script>\nexport default {}\n</script>\n<script setup>\nconst a = 1 +;\n</script>\n</vue>\n'
      );
      return 'Scripts.ucf';
    });
    expect(findings).toEqual([formatError('Scripts.ucf', span(source, '+;', 1, 1), '<vue> does not parse: Unexpected token')]);
  });

  it('reports the config oxfmt rejects before a <vue> <script> that does not parse', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      addFile(root, 'Only.ucf', '<vue lang="vue">\n<script setup lang="ts">let a = ;</script>\n</vue>\n');
      writeFileSync(join(root, '.oxfmtrc.json'), '{"printWidth": 1000}\n');
      expect(await runMfFmt(root, ['Only.ucf'])).toEqual(fails(`.oxfmtrc.json: ${INVALID_PRINT_WIDTH}`));
    });
  });

  it("reports an error with no position at all on the block's opening tag", async () => {
    const {source, findings} = await formatErrors((root) => {
      addFile(root, 'Unclosed.ucf', '<vue lang="vue">\n<template><p a="1></p></template>\n</vue>\n');
      return 'Unclosed.ucf';
    });
    const message = "<vue> does not parse: TypeError: Cannot read properties of null (reading 'end')";
    expect(findings).toEqual([formatError('Unclosed.ucf', span(source, '<vue lang="vue">'), message)]);
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
      copyInto(root, MESSY, ['old']);
      mkdirSync(join(root, 'empty'));
      expect(await runMfFmt(root, ['--nope'])).toEqual(fails("unknown option '--nope'; use --check, --format or --help"));
      expect(await runMfFmt(root, ['react.ts'])).toEqual(fails('react.ts is not a .ucf file; format it with oxfmt'));
      expect(await runMfFmt(root, ['nope.ucf'])).toEqual(fails('nope.ucf does not exist'));
      expect(await runMfFmt(root, ['empty'])).toEqual(fails('empty holds no .ucf file'));
      expect(await runMfFmt(join(root, 'empty'))).toEqual(fails('. holds no .ucf file'));
      expect(await runMfFmt(root, ['old'])).toEqual(fails('old holds no .ucf file'));
      expect(await runMfFmt(root, ['old/Messy.ucf'])).toEqual(fails('old/Messy.ucf is ignored by .oxfmtrc.json'));
    });
  });

  it('names an .oxfmtrc.json that is not JSON, not an object, of the wrong shape, or holds a value oxfmt rejects', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      const config = join(root, '.oxfmtrc.json');
      writeFileSync(config, '{\n  semi: false\n}\n');
      const text = read(root, '.oxfmtrc.json');
      const {line, offset} = locate(text, 'semi');
      const position = `at position ${text.indexOf('semi')} (line ${line} column ${offset})`;
      expect(await runMfFmt(root)).toEqual(fails(`.oxfmtrc.json: Expected property name or '}' in JSON ${position}`));
      writeFileSync(config, '[]\n');
      expect(await runMfFmt(root)).toEqual(fails('.oxfmtrc.json: not a JSON object'));
      const overrides = fails('.oxfmtrc.json: overrides must be an array of {files, excludeFiles, options}');
      for (const shape of ['{}', '[null]', '[{"files": "*.vue"}]', '[{"files": ["*.vue"], "excludeFiles": "*.tsx"}]']) {
        writeFileSync(config, `{"overrides": ${shape}}\n`);
        expect(await runMfFmt(root), shape).toEqual(overrides);
      }
      writeFileSync(config, '{"ignorePatterns": "old/**"}\n');
      expect(await runMfFmt(root)).toEqual(fails('.oxfmtrc.json: ignorePatterns must be an array of strings'));
      writeFileSync(config, '{"printWidth": 1000}\n');
      expect(await runMfFmt(root)).toEqual(fails(`.oxfmtrc.json: ${INVALID_PRINT_WIDTH}`));
      expect(read(root, MESSY)).toBe(ORIGINAL);
    });
  });

  it('names the .editorconfig when the value oxfmt rejects comes from it', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      editFile(root, '.editorconfig', 'max_line_length = 100', 'max_line_length = 1000');
      expect(await runMfFmt(root)).toEqual(fails(`.editorconfig: ${INVALID_PRINT_WIDTH}`));
      expect(read(root, MESSY)).toBe(ORIGINAL);
    });
  });

  it('writes no file when a later file has a config oxfmt rejects', async () => {
    await withCopy(LINT_FORMAT, async (root) => {
      copyInto(root, MESSY, ['nested']);
      writeFileSync(join(root, 'nested', '.oxfmtrc.json'), '{"printWidth": 1000}\n');
      expect(await runMfFmt(root)).toEqual(fails(`nested/.oxfmtrc.json: ${INVALID_PRINT_WIDTH}`));
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
  const ENDINGS: Record<string, string> = {style: '.scss', vue: '.vue', react: '.tsx', svelte: '.svelte'};

  it('names the block file of every block kind, and of each <style lang>', () => {
    const messy = splitBlocks(ORIGINAL, MESSY);
    for (const {tag} of BLOCK_KINDS) {
      const block = messy.blocks.find(({type}) => type === tag);
      expect(ENDINGS[tag], `the block file ending of <${tag}>`).toBeDefined();
      expect(block, `a <${tag}> block in ${MESSY}`).toBeDefined();
      expect(blockFile(MESSY, block!), tag).toBe(`${MESSY}.${tag}${ENDINGS[tag]}`);
    }
    const styles = {'Badge.ucf': '.css', 'editor/LessModule.ucf': '.less', 'langs/StylusPlain.ucf': '.stylus'};
    for (const [name, ending] of Object.entries(styles)) {
      const {filename, source} = readComponent(name);
      const [style] = splitBlocks(source, filename).styles;
      expect(blockFile(name, style!)).toBe(`${name}.style${ending}`);
    }
  });
});
