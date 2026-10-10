import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import ts from 'typescript';
import {describe, expect, it} from 'vitest';
import {readMultifrontOptions} from '@multifront/language-tools';
// Relative paths, not a package dependency: @multifront/e2e depends on language-tools.
import {EXPECTED_IMPORTS} from '../../e2e/fixtures/apps/imports/expected.ts';
import {FIXTURES_DIR} from '../../e2e/fixtures/index.ts';

const APP = join(FIXTURES_DIR, 'apps', 'imports');

function nearestTsconfig(fileName: string): string {
  let dir = dirname(fileName);
  while (!existsSync(join(dir, 'tsconfig.json'))) dir = dirname(dir);
  return join(dir, 'tsconfig.json');
}

describe('readMultifrontOptions', () => {
  it.each(EXPECTED_IMPORTS.map((row) => [`${row.file}:${row.line}`, row] as const))(
    '%s: the plugin entry of its tsconfig.json',
    (_key, row) => {
      expect(readMultifrontOptions(ts, nearestTsconfig(join(APP, row.file)))).toEqual(row.options);
    }
  );

  it('a tsconfig.json without our entry gives no options', () => {
    expect(readMultifrontOptions(ts, join(FIXTURES_DIR, 'components', 'editor', 'tsconfig.json'))).toEqual({});
  });
});
