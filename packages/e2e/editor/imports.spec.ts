import {dirname} from 'node:path';
import {rewriteImportAttributes} from '@multifront/core';
import type {Diagnostic, TargetRule} from '@multifront/core';
import ts from 'typescript';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {EXPECTED_IMPORTS} from '../fixtures/apps/imports/expected.ts';
import {APP_DIR, CARD, edit, onLine, PLUGIN, readApp} from './lib/cases.ts';
import {E2E_DIR, locate, open, startTsserver, tsLocation, VUE_PLUGIN, VUE_PLUGIN_DIR} from './lib/tsserver.ts';
import type {Component, TsDefinitions, Tsserver} from './lib/tsserver.ts';

// tsserver serves no .svelte importer before M6; mixed.ts has its own cases in tsserver.spec.ts.
const ROWS = EXPECTED_IMPORTS.filter((row) => !row.file.endsWith('.svelte') && row.file !== 'src/mixed.ts');
// Our plugin alone, as every React-only project runs it; beside Vue's, which reads `.vue` importers as Vue - Official
// does, on one shared @volar/typescript copy.
const SETUPS = [
  {name: 'our plugin alone', plugins: [PLUGIN], rows: ROWS.filter(({file}) => !file.endsWith('.vue'))},
  {name: "our plugin beside Vue's", plugins: [PLUGIN, VUE_PLUGIN], rows: ROWS},
];
const RULE_REASON: Record<TargetRule, string> = {
  block: 'the block it sits in',
  attribute: 'its framework attribute',
  importer: "the importer's extension",
  default: 'the default framework',
};
const NON_LITERAL = readApp('no-default/non-literal.ts');

// The build's one error for the file, as tsserver must report it.
function rewriteError({filename, source}: Component) {
  const {errors} = rewriteImportAttributes(source, filename);
  expect(errors).toHaveLength(1);
  const [{line, message, start, end}] = errors as [Diagnostic];
  return {line, expected: {start: tsLocation(source, start), end: tsLocation(source, end), text: message}};
}

describe.each(SETUPS)('$name, on every row of the imports app, as the build resolves them', ({plugins, rows}) => {
  const files = [...new Set(rows.map(({file}) => file))];
  let server: Tsserver;

  beforeAll(async () => {
    server = startTsserver({cwd: APP_DIR, plugins, probeLocations: [E2E_DIR, VUE_PLUGIN_DIR]});
    await open(server, [...files.map(readApp), CARD]);
  });

  afterAll(async () => {
    await server?.stop();
  });

  it.each(files)('%s is in the project of its nearest tsconfig.json', async (file) => {
    const {filename} = readApp(file);
    const info = await server.request<ts.server.protocol.ProjectInfo>('projectInfo', {file: filename, needFileNameList: false});
    expect(info.configFileName).toBe(ts.findConfigFile(dirname(filename), ts.sys.fileExists));
  });

  it.each(rows)('$file line $line: $expect', async (row) => {
    const component = readApp(row.file);
    const at = locate(component.source, `'${row.specifier}'`);
    const diagnostics = onLine(await server.diagnostics(component.filename), row.line);
    if (row.expect === 'framework-attribute-not-literal') {
      const {expected} = rewriteError(component);
      expect(diagnostics).toMatchObject([{code: row.expect, source: 'multifront', category: 'error', ...expected}]);
    } else if (!('rule' in row)) {
      expect(diagnostics).toMatchObject([{code: row.expect, source: 'multifront', category: 'error', start: at}]);
    } else if (row.expect === 'react' || row.expect === 'vue') {
      expect(diagnostics).toEqual([]);
      const definitions = await server.request<TsDefinitions>('definition', {
        file: component.filename,
        line: at.line,
        offset: at.offset + 1,
      });
      expect(definitions.map(({file}) => file)).toEqual([CARD.filename]);
    } else {
      expect(diagnostics).toMatchObject([{code: 'target-not-built', source: 'multifront', category: 'error', start: at}]);
      expect(diagnostics[0]!.text).toContain(`imported as ${row.expect} (by ${RULE_REASON[row.rule]})`);
    }
  });

  it('import() options that are no object literal: the rewrite message, at the options, in the unsaved buffer', async () => {
    const line = NON_LITERAL.source.split('\n').find((text) => text.includes('{with: {framework}}'))!;
    const newText = `const options = {with: {framework}};\n${line.replace('{with: {framework}}', 'options')}`;
    const edited = {...NON_LITERAL, source: NON_LITERAL.source.replace(line, newText)};
    const error = rewriteError(edited);
    expect(error.expected.text).not.toBe(rewriteError(NON_LITERAL).expected.text);
    const revert = await edit(server, NON_LITERAL, line, newText);
    try {
      const diagnostics = onLine(await server.diagnostics(NON_LITERAL.filename), error.line);
      expect(diagnostics).toMatchObject([{code: 'framework-attribute-not-literal', category: 'error', ...error.expected}]);
    } finally {
      await revert();
    }
  });

  it('a file that does not parse gets no rewrite error: the import reads as it did, no-target here', async () => {
    const last = NON_LITERAL.source.trimEnd().split('\n').at(-1)!;
    const edited = {...NON_LITERAL, source: NON_LITERAL.source.replace(last, `${last}\nconst = ;`)};
    expect(rewriteImportAttributes(edited.source, edited.filename).errors).toEqual([]);
    const revert = await edit(server, NON_LITERAL, last, `${last}\nconst = ;`);
    try {
      const at = locate(NON_LITERAL.source, "'../../../components/Card.ucf'");
      const diagnostics = onLine(await server.diagnostics(NON_LITERAL.filename), at.line);
      expect(diagnostics).toMatchObject([{code: 'no-target', source: 'multifront', category: 'error', start: at}]);
    } finally {
      await revert();
    }
  });
});
