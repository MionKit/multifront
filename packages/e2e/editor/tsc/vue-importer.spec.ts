// The real `mf-tsc` checks `.vue` files in the same program, their `.ucf` imports in the Vue target, as `vue-tsc` would.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Finding} from '@multifront/core';
import {describe, expect, it} from 'vitest';
import {typeCheck} from '../../build/lib/library.ts';
import {runMfTsc} from '../lib/commands.ts';
import {BAD_PAGE, BROKEN, VALID, addFile, editFile, line, report, span, withCopy} from '../lib/tsc.ts';
import {offsetAt} from '../lib/tsserver.ts';

const PLAIN_VUE = `<script setup lang="ts">
const count: number = 'one'
const label = 'a'
</script>

<template>
  <span>{{ count }} {{ label.toFixed(2) }}</span>
</template>
`;
const PLAIN_TSCONFIG = `{
  "compilerOptions": {
    "target": "es2022",
    "module": "preserve",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["*.vue"]
}
`;
const EXTRA_PAGE = `<script setup lang="ts">
const count: number = 'one'
</script>
`;
// `vue-tsc --pretty false`: `Plain.vue(2,7): error TS2322: Type 'string' is not assignable to type 'number'.`
const VUE_TSC_LINE = /^(.+)\((\d+),(\d+)\): (error|warning) (TS\d+): /;

type Located = Pick<Finding, 'file' | 'line' | 'column' | 'code' | 'severity'>;

const located = ({file, line, column, code, severity}: Finding): Located => ({file, line, column, code, severity});

describe('mf-tsc on .vue files', () => {
  it('checks the valid app with its Page.vue, and Page.vue alone', async () => {
    await withCopy(VALID, async (root) => {
      expect(await runMfTsc(root)).toEqual({
        code: 0,
        stdout: 'mf-tsc: checked 5 files with tsconfig.json: no errors\n',
        stderr: '',
      });
      expect(await runMfTsc(root, ['Page.vue'])).toEqual({
        code: 0,
        stdout: 'mf-tsc: checked 1 file with tsconfig.json: no errors\n',
        stderr: '',
      });
    });
  });

  it('reports a wrong prop in a .vue template at the prop, with no block or framework', async () => {
    await withCopy(BROKEN, async (root) => {
      const whole = report((await runMfTsc(root, ['--format', 'json'])).stdout);
      const [finding] = whole.findings.filter(({file}) => file === 'BadPage.vue');
      expect(finding).toEqual(BAD_PAGE.finding());
      const source = readFileSync(join(root, 'BadPage.vue'), 'utf8');
      const start = offsetAt(source, {line: finding!.line!, offset: finding!.column!});
      expect(source.slice(start, offsetAt(source, {line: finding!.end!.line, offset: finding!.end!.column}))).toBe('label');
    });
  });

  it('checks only the named .vue file', async () => {
    await withCopy(BROKEN, async (root) => {
      expect(await runMfTsc(root, ['BadPage.vue'])).toEqual({
        code: 1,
        stdout: `${line(BAD_PAGE.finding())}\nmf-tsc: checked 1 file with tsconfig.json: 1 error\n`,
        stderr: '',
      });
      expect(line(BAD_PAGE.finding())).toBe("BadPage.vue:6:21: error TS2322: Type 'number' is not assignable to type 'string'.");
      const run = await runMfTsc(root, ['BadPage.vue', '--format', 'json']);
      expect(report(run.stdout)).toEqual({
        findings: [BAD_PAGE.finding()],
        errorCount: 1,
        warningCount: 0,
        projects: [{tsconfig: 'tsconfig.json', files: 1}],
      });
    });
  });

  it("resolves a .vue file's .ucf import to the Vue target, with our code when it has none", async () => {
    await withCopy(BROKEN, async (root) => {
      editFile(root, 'BadPage.vue', "import OnlyReactExport from './OnlyReactExport.ucf'", "import Title from './Title.ucf'");
      editFile(root, 'BadPage.vue', '<OnlyReactExport :label="1" />', '<Title text="a" />');
      const source = readFileSync(join(root, 'BadPage.vue'), 'utf8');
      const run = await runMfTsc(root, ['BadPage.vue', '--format', 'json']);
      expect(report(run.stdout).findings).toEqual([
        {
          file: 'BadPage.vue',
          ...span(source, "'./Title.ucf'"),
          code: 'missing-target-block',
          severity: 'error',
          message: './Title.ucf has no <vue> block; BadPage.vue imports it as vue',
        },
      ]);
    });
  });
});

describe("mf-tsc with the tsconfig's vueCompilerOptions", () => {
  it('follows strictTemplates: an unknown prop is an error only with it on', async () => {
    await withCopy(VALID, async (root) => {
      editFile(root, 'Page.vue', '<Greeting name="Ada" :count="2" />', '<Greeting name="Ada" :count="2" extra="x" />');
      expect((await runMfTsc(root, ['Page.vue'])).code).toBe(0);
      editFile(root, 'tsconfig.json', '"include"', '"vueCompilerOptions": {"strictTemplates": true},\n  "include"');
      const run = await runMfTsc(root, ['Page.vue', '--format', 'json']);
      expect(run.code).toBe(1);
      const source = readFileSync(join(root, 'Page.vue'), 'utf8');
      expect(report(run.stdout).findings.map(({file, line, column, end}) => ({file, line, column, end}))).toEqual([
        {file: 'Page.vue', ...span(source, 'extra')},
      ]);
    });
  });

  it('checks the files of its extra extensions as .vue files', async () => {
    await withCopy(VALID, async (root) => {
      addFile(root, 'Extra.page', EXTRA_PAGE);
      editFile(root, 'tsconfig.json', '"include"', '"vueCompilerOptions": {"extensions": [".vue", ".page"]},\n  "include"');
      const run = await runMfTsc(root, ['--format', 'json']);
      expect(run.code).toBe(1);
      expect(report(run.stdout).findings).toEqual([
        {
          file: 'Extra.page',
          ...span(EXTRA_PAGE, 'count'),
          code: 'TS2322',
          severity: 'error',
          message: "Type 'string' is not assignable to type 'number'.",
        },
      ]);
    });
  });
});

describe('mf-tsc and vue-tsc', () => {
  it('report the same codes at the same places in a plain .vue file', async () => {
    await withCopy(BROKEN, async (root) => {
      addFile(root, 'plain/Plain.vue', PLAIN_VUE);
      addFile(root, 'plain/tsconfig.json', PLAIN_TSCONFIG);
      const dir = join(root, 'plain');
      const theirs = (await typeCheck('vue-tsc', dir, 'tsconfig.json')).split('\n').flatMap((text): Located[] => {
        const [, file, line, column, severity, code] = VUE_TSC_LINE.exec(text) ?? [];
        return file ? [{file, line: Number(line), column: Number(column), code: code!, severity: severity as 'error'}] : [];
      });
      const ours = report((await runMfTsc(dir, ['--format', 'json'])).stdout).findings.map(located);
      expect(theirs.map(({code}) => code)).toEqual(['TS2322', 'TS2551']);
      expect(ours).toEqual(theirs);
    });
  });
});
