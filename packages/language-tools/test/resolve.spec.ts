import {dirname, join} from 'node:path';
import ts from 'typescript';
import {describe, expect, it} from 'vitest';
import {readMultifrontOptions} from '@multifront/language-tools';
// Relative paths, not a package dependency: @multifront/e2e depends on language-tools.
import {EXPECTED_IMPORTS} from '../../e2e/fixtures/apps/imports/expected.ts';
import {FIXTURES_DIR} from '../../e2e/fixtures/index.ts';

const APP = join(FIXTURES_DIR, 'apps', 'imports');
const OPTIONS = join(FIXTURES_DIR, 'plugin-options');

describe('readMultifrontOptions', () => {
  it.each(EXPECTED_IMPORTS.map((row) => [`${row.file}:${row.line}`, row] as const))(
    '%s: the plugin entry of its tsconfig.json',
    (_key, row) => {
      const configFileName = ts.findConfigFile(dirname(join(APP, row.file)), ts.sys.fileExists)!;
      expect(readMultifrontOptions(ts, configFileName)).toEqual(row.options);
    }
  );

  it('follows extends to the entry of the parent', () => {
    expect(readMultifrontOptions(ts, join(OPTIONS, 'extends-only', 'tsconfig.json'))).toEqual({framework: 'react'});
  });

  it('drops values that are not a framework', () => {
    expect(readMultifrontOptions(ts, join(OPTIONS, 'invalid-values', 'tsconfig.json'))).toEqual({importers: {'.ts': 'vue'}});
  });

  it('a tsconfig.json without our entry gives no options', () => {
    expect(readMultifrontOptions(ts, join(FIXTURES_DIR, 'components', 'editor', 'tsconfig.json'))).toEqual({});
  });

  it('a missing tsconfig.json is an error, not empty options', () => {
    expect(() => readMultifrontOptions(ts, join(OPTIONS, 'missing', 'tsconfig.json'))).toThrow(/missing/);
  });
});
