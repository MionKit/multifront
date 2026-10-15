// The real `mf-tsc` checks `.vue` files in the same program, their `.ucf` imports in the Vue target, as `vue-tsc` would.
import {readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {typeCheck} from '../../build/lib/library.ts';
import {runMfTsc} from '../lib/commands.ts';
import {BAD_PAGE, BROKEN, VALID, addFile, editFile, line, report, span, withCopy} from '../lib/tsc.ts';

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

describe('mf-tsc on .vue files', () => {
  it('checks Page.vue of the valid app alone', async () => {
    await withCopy(VALID, async (root) => {
      expect(await runMfTsc(root, ['Page.vue'])).toEqual({
        code: 0,
        stdout: 'mf-tsc: checked 1 file with tsconfig.json: no errors\n',
        stderr: '',
      });
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
  it("follows strictTemplates through extends and each project's own config, never in a .ucf <vue> block", async () => {
    await withCopy(VALID, async (root) => {
      editFile(root, 'Page.vue', '<Greeting name="Ada" :count="2" />', '<Greeting name="Ada" :count="2" extra="x" />');
      // The same unknown prop inside a `.ucf` `<vue>` block, which keeps our own Vue options.
      editFile(root, 'Greeting.ucf', 'defineProps<', "import Badge from './Badge.ucf'\n  defineProps<");
      editFile(root, 'Greeting.ucf', 'Hello {{ name }}</p>', 'Hello {{ name }} <Badge label="a" extra="x" /></p>');
      expect(await runMfTsc(root)).toMatchObject({code: 0, stderr: ''});
      // The create-vue layout: the options in the referenced project, through its `extends`.
      renameSync(join(root, 'tsconfig.json'), join(root, 'tsconfig.app.json'));
      editFile(root, 'tsconfig.app.json', '"compilerOptions"', '"extends": "./vue.json",\n  "compilerOptions"');
      writeFileSync(join(root, 'vue.json'), '{"vueCompilerOptions": {"strictTemplates": true}}\n');
      writeFileSync(join(root, 'tsconfig.json'), '{"files": [], "references": [{"path": "./tsconfig.app.json"}]}\n');
      const source = readFileSync(join(root, 'Page.vue'), 'utf8');
      const where = [{file: 'Page.vue', ...span(source, 'extra')}];
      const located = (stdout: string) => report(stdout).findings.map(({file, line, column, end}) => ({file, line, column, end}));
      const whole = await runMfTsc(root, ['--format', 'json']);
      expect(whole.code).toBe(1);
      expect(located(whole.stdout)).toEqual(where);
      expect(located((await runMfTsc(root, ['-p', 'tsconfig.app.json', 'Page.vue', '--format', 'json'])).stdout)).toEqual(where);
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
      const theirs = (await typeCheck('vue-tsc', dir, 'tsconfig.json')).split('\n').flatMap((text) => {
        const [, file, row, column, severity, code] = VUE_TSC_LINE.exec(text) ?? [];
        return file ? [{file, line: Number(row), column: Number(column), code, severity}] : [];
      });
      const ours = report((await runMfTsc(dir, ['--format', 'json'])).stdout).findings.map(
        ({file, line, column, code, severity}) => ({file, line, column, code, severity})
      );
      expect(theirs.map(({code}) => code)).toEqual(['TS2322', 'TS2551']);
      expect(ours).toEqual(theirs);
    });
  });
});
