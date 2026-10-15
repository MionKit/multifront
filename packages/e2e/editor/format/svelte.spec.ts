// The real `mf-fmt` with oxfmt's `svelte` option on: `<svelte>` blocks formatted as the oxfmt CLI formats them.
import {join} from 'node:path';
import type {Finding} from '@multifront/core';
import {describe, expect, it} from 'vitest';
import {buildApp} from '../../build/lib/build.ts';
import {FIXTURES_DIR, copyAppOutside} from '../../fixtures/index.ts';
import {runMfFmt} from '../lib/commands.ts';
import {
  LINT_FORMAT_SVELTE,
  MESSY,
  ORIGINAL,
  SENT,
  SENT_WITH_SVELTE,
  contents,
  copyInto,
  copyOxfmtWithoutSvelte,
  expectCliOutput,
  outsideBlocks,
  read,
  report,
} from '../lib/format.ts';
import {addFile, assertNotInstalled, editFile, span, withCopy} from '../lib/tsc.ts';

const MISSING_SVELTE: Finding = {
  code: 'missing-svelte',
  severity: 'warning',
  message: 'oxfmt cannot load svelte/compiler, so <svelte> blocks stay as written; add svelte to devDependencies',
};

describe('mf-fmt with the svelte option on', () => {
  it('starts from the same Messy.ucf as lint-format/', () => {
    expect(read(join(FIXTURES_DIR, 'apps', LINT_FORMAT_SVELTE), MESSY)).toBe(ORIGINAL);
  });

  it('formats the <svelte> block as the oxfmt CLI formats its block file, and every other block too', async () => {
    await withCopy(LINT_FORMAT_SVELTE, async (root) => {
      expect(await runMfFmt(root)).toEqual({code: 0, stdout: 'mf-fmt: formatted 1 of 1 files\n', stderr: ''});
      expectCliOutput(root, MESSY, '\n', SENT_WITH_SVELTE);
      const after = read(root, MESSY);
      expect(contents(after).svelte).not.toBe(contents(ORIGINAL).svelte);
      expect(outsideBlocks(after)).toBe(outsideBlocks(ORIGINAL));
    });
  });

  it('changes nothing on a second run, and the real Svelte build of the result succeeds', async () => {
    await withCopy(LINT_FORMAT_SVELTE, async (root) => {
      await runMfFmt(root);
      const once = read(root, MESSY);
      expect(await runMfFmt(root)).toEqual({code: 0, stdout: 'mf-fmt: formatted 0 of 1 files\n', stderr: ''});
      expect(read(root, MESSY)).toBe(once);
      expect(await runMfFmt(root, ['--check'])).toEqual({code: 0, stdout: 'mf-fmt: 0 of 1 files not formatted\n', stderr: ''});
      const {chunks} = await buildApp(root, {build: {rolldownOptions: {input: {svelte: join(root, 'svelte.ts')}}}});
      expect(chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.name)).toEqual(['svelte']);
    });
  });

  it('turns on for an object too, as oxfmt does', async () => {
    await withCopy(LINT_FORMAT_SVELTE, async (root) => {
      editFile(root, '.oxfmtrc.json', '"svelte": true', '"svelte": {}');
      expect(await runMfFmt(root)).toEqual({code: 0, stdout: 'mf-fmt: formatted 1 of 1 files\n', stderr: ''});
      expectCliOutput(root, MESSY, '\n', SENT_WITH_SVELTE);
      expect(contents(read(root, MESSY)).svelte).not.toBe(contents(ORIGINAL).svelte);
    });
  });

  it('resolves the option per block file: an override turning it off keeps that <svelte> block as written', async () => {
    await withCopy(LINT_FORMAT_SVELTE, async (root) => {
      copyInto(root, MESSY, ['nested']);
      editFile(
        root,
        '.oxfmtrc.json',
        '"svelte": true',
        '"svelte": true, "overrides": [{"files": ["nested/*.svelte"], "options": {"svelte": false}}]'
      );
      expect(await runMfFmt(root)).toEqual({code: 0, stdout: 'mf-fmt: formatted 2 of 2 files\n', stderr: ''});
      expectCliOutput(root, MESSY, '\n', SENT_WITH_SVELTE);
      expectCliOutput(root, 'nested/Messy.ucf');
      expect(contents(read(root, 'nested/Messy.ucf')).svelte).toBe(contents(ORIGINAL).svelte);
    });
  });

  it("reports <svelte> markup that does not parse on the block's opening tag and leaves the file as written", async () => {
    await withCopy(LINT_FORMAT_SVELTE, async (root) => {
      editFile(root, MESSY, 'onclick={()=>count++}>{label} {count}', 'onclick={()=>count++}>{label} {#if}');
      const source = read(root, MESSY);
      const run = await runMfFmt(root, [MESSY, '--format', 'json']);
      expect({code: run.code, stderr: run.stderr}).toEqual({code: 1, stderr: ''});
      expect(report(run.stdout)).toEqual({
        findings: [
          {
            file: MESSY,
            ...span(source, '<svelte>'),
            code: 'format-error',
            severity: 'error',
            message: '<svelte> does not parse: expected_whitespace: Expected whitespace',
            block: 'svelte',
          },
        ],
        errorCount: 1,
        warningCount: 0,
        files: 1,
        changed: [],
      });
      expect(read(root, MESSY)).toBe(source);
    });
  });
});

describe('mf-fmt with the svelte option on and no svelte for oxfmt', () => {
  it('warns once per run, keeps every <svelte> block as written and formats the other blocks', async () => {
    await withCopy(
      LINT_FORMAT_SVELTE,
      async (root) => {
        copyOxfmtWithoutSvelte(root);
        assertNotInstalled(root, 'svelte');
        copyInto(root, MESSY, ['nested']);
        // No global install either: Node also looks in NODE_PATH.
        const env = {NODE_PATH: undefined};
        expect(await runMfFmt(root, ['--check', '--format', 'json'], env).then(({stdout}) => report(stdout))).toEqual({
          // A finding with no file sorts first.
          findings: [
            MISSING_SVELTE,
            ...[MESSY, 'nested/Messy.ucf'].map((file) => expect.objectContaining({file, code: 'unformatted'})),
          ],
          errorCount: 2,
          warningCount: 1,
          files: 2,
          changed: [MESSY, 'nested/Messy.ucf'],
        });
        expect(await runMfFmt(root, [], env)).toEqual({
          code: 0,
          stdout: `warning missing-svelte: ${MISSING_SVELTE.message}\nmf-fmt: formatted 2 of 2 files\n`,
          stderr: '',
        });
        for (const file of [MESSY, 'nested/Messy.ucf']) {
          const [before, after] = [contents(ORIGINAL), contents(read(root, file))];
          expect(after.svelte, file).toBe(before.svelte);
          for (const tag of Object.keys(SENT) as (keyof typeof SENT)[])
            expect(after[tag], `<${tag}> of ${file}`).not.toBe(before[tag]);
        }
        const json = await runMfFmt(root, ['--format', 'json'], env);
        expect({code: json.code, stderr: json.stderr}).toEqual({code: 0, stderr: ''});
        expect(report(json.stdout)).toEqual({findings: [MISSING_SVELTE], errorCount: 0, warningCount: 1, files: 2, changed: []});
        // Beside a block oxfmt cannot parse, which leaves that file as written.
        editFile(root, 'nested/Messy.ucf', 'setCount(count + 1)', 'setCount(count +)');
        const broken = await runMfFmt(root, ['nested', '--format', 'json'], env);
        expect(broken.code).toBe(1);
        expect(report(broken.stdout).findings).toEqual([
          MISSING_SVELTE,
          expect.objectContaining({file: 'nested/Messy.ucf', code: 'format-error', block: 'react'}),
        ]);
        addFile(root, 'Plain.ucf', '<react>\nexport default function Plain() {\n  return <p />;\n}\n</react>\n');
        const plain = await runMfFmt(root, ['Plain.ucf', '--format', 'json'], env);
        expect({code: plain.code, stderr: plain.stderr}).toEqual({code: 0, stderr: ''});
        expect(report(plain.stdout)).toMatchObject({findings: [], warningCount: 0});
      },
      copyAppOutside
    );
  });
});
