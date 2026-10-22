// oxlint diagnostics through the real server, with a tsdk as VS Code passes one: what the real mf-lint reports.
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it, vi} from 'vitest';
import {edited} from '../../build/lib/library.ts';
import {copyAppOutside, FIXTURES_DIR, readComponent} from '../../fixtures/index.ts';
import {copyInto, formatting, LINT_FORMAT, read} from '../lib/format.ts';
import {asLintPoint, lintDiagnostics, lintPoints, mfLintFindings} from '../lib/lint.ts';
import {assertNotInstalled} from '../lib/tsc.ts';

const LINT = 'Lint.front';
const LINT_SOURCE = read(join(FIXTURES_DIR, 'apps', LINT_FORMAT), LINT);
const CONFIG = '.oxlintrc.json';
// The `<vue>` block's `debugger;`, blanked so every other range stays where it was.
const VUE_DEBUGGER = 'debugger;\n</script>';
const WITHOUT_VUE_DEBUGGER = edited(LINT_SOURCE, VUE_DEBUGGER, `${' '.repeat('debugger;'.length)}\n</script>`);
// oxlint's parse error: no oxlint code, rule URL or help.
const VUE_PARSE_ERROR = edited(
  LINT_SOURCE,
  '<script setup lang="ts">\nconst unused = \'é ü\'',
  '<script setup lang="ts">\nconst = 1'
);
const ruleUrl = (code: string) => `https://oxc.rs/docs/guide/usage/linter/rules/${code.replace(/^(\w+)\((.+)\)$/, '$1/$2')}.html`;

describe('lint diagnostics on lint-format/', () => {
  const {state, warnings} = formatting(LINT_FORMAT);
  const lint = (text?: string, file = LINT) => lintDiagnostics(state.server, join(state.root, file), text);

  /** Notifies the server as VS Code's file watcher would. */
  async function setConfig(text: string): Promise<void> {
    const file = join(state.root, CONFIG);
    writeFileSync(file, text);
    const refreshed = state.server.nextDiagnosticRefresh();
    await state.server.didChangeWatchedFiles([{uri: pathToFileURL(file).href, type: 2}]);
    await refreshed;
  }

  it("give what the real mf-lint reports, worded as oxlint's own server words them, and log nothing", async () => {
    const findings = await mfLintFindings(state.root, LINT);
    expect(findings).toHaveLength(4);
    const diagnostics = await lint();
    expect(lintPoints(diagnostics)).toEqual(findings.map(asLintPoint));
    diagnostics.forEach((diagnostic, index) => {
      const {code, message} = findings[index]!;
      expect(diagnostic.codeDescription).toEqual({href: ruleUrl(code)});
      const [first, help] = diagnostic.message.split('\nhelp: ');
      expect({first, help: typeof help}).toEqual({first: message, help: 'string'});
      expect(help).not.toBe('');
    });
    expect(warnings()).toEqual([]);
  });

  it("give oxlint's own message, mf-lint's code and no rule link, for a finding with neither help nor URL", async () => {
    writeFileSync(join(state.root, 'Broken.front'), VUE_PARSE_ERROR);
    const findings = await mfLintFindings(state.root, 'Broken.front');
    const parseErrors = findings.filter(({block}) => block === 'vue');
    expect(parseErrors).toEqual([
      expect.objectContaining({code: 'lint-parse-error', message: 'Unexpected token', severity: 'error'}),
    ]);
    const diagnostics = await lint(undefined, 'Broken.front');
    expect(lintPoints(diagnostics)).toEqual(findings.map(asLintPoint));
    const parseError = diagnostics.find(({range}) => range.start.line === asLintPoint(parseErrors[0]!).range.start.line)!;
    expect(parseError).toMatchObject({severity: 1, source: 'oxlint', code: 'lint-parse-error', message: 'Unexpected token'});
    expect(parseError).not.toHaveProperty('codeDescription');
  });

  it('watch every .oxlintrc.json and .oxlintrc.jsonc', async () => {
    await vi.waitFor(() =>
      expect(state.server.registrations).toContainEqual({
        id: expect.any(String),
        method: 'workspace/didChangeWatchedFiles',
        registerOptions: {watchers: [{globPattern: '**/.oxlintrc.json'}, {globPattern: '**/.oxlintrc.jsonc'}]},
      })
    );
  });

  it('follow the unsaved buffer, not the file on disk', async () => {
    const findings = await mfLintFindings(state.root, LINT);
    try {
      const points = lintPoints(await lint(WITHOUT_VUE_DEBUGGER));
      expect(points).toEqual(findings.filter(({block}) => block !== 'vue').map(asLintPoint));
      expect(await mfLintFindings(state.root, LINT)).toEqual(findings);
    } finally {
      await lint(LINT_SOURCE);
    }
  });

  it('lint a file outside every workspace folder from its own folder, as mf-lint run there', async () => {
    const findings = await mfLintFindings(state.other, LINT);
    expect(findings).toHaveLength(4);
    expect(lintPoints(await lintDiagnostics(state.server, join(state.other, LINT)))).toEqual(findings.map(asLintPoint));
  });

  it('follow a change of .oxlintrc.json on disk', async () => {
    const config = read(state.root, CONFIG);
    try {
      await setConfig(edited(config, '"no-debugger": "error"', '"no-debugger": "off"').replace('"no-debugger": "warn"', ''));
      const codes = lintPoints(await lint()).map(({code}) => code);
      expect(codes).toEqual(['eslint(no-unused-vars)']);
    } finally {
      await setConfig(config);
    }
    expect(await lint()).toHaveLength(4);
  });

  it('skip a file oxlint is not run on: clean, ignored, untitled, or one whose blocks do not split', async () => {
    const from = state.server.log.length;
    expect(await lint(undefined, 'Clean.front')).toEqual([]);
    copyInto(state.root, LINT, ['old']);
    expect(await lint(undefined, `old/${LINT}`)).toEqual([]);
    const untitled = await state.server.openUntitledDocument('front', LINT_SOURCE);
    expect(await state.server.sendDocumentDiagnosticRequest(untitled.uri)).toEqual({kind: 'full', items: []});
    const duplicate = join(state.root, 'DuplicateReact.front');
    writeFileSync(duplicate, readComponent('invalid/DuplicateReact.front').source);
    const document = await state.server.openTextDocument(duplicate, 'front');
    const report = await state.server.sendDocumentDiagnosticRequest(document.uri);
    const items = report.kind === 'full' ? report.items : [];
    expect(items.map(({source, code}) => [source, code])).toContainEqual(['multifront', 'duplicate-target']);
    expect(items.filter(({source}) => source === 'oxlint')).toEqual([]);
    expect(warnings(from)).toEqual([]);
  });

  it("log oxlint's message once per reason for a config it rejects, again after a lint succeeds", async () => {
    const config = read(state.root, CONFIG);
    const from = state.server.log.length;
    const prefix = `multifront: no linting in ${state.root} (oxlint: `;
    try {
      await setConfig('{"rules": ');
      expect(await lint()).toEqual([]);
      expect(await lint(WITHOUT_VUE_DEBUGGER)).toEqual([]);
      expect(warnings(from)).toEqual([expect.stringMatching(/\S\)$/)]);
      await setConfig(config);
      expect(await lint(LINT_SOURCE)).toHaveLength(4);
      await setConfig('{"rules": ');
      expect(await lint()).toEqual([]);
      const logged = warnings(from);
      expect(logged).toHaveLength(2);
      for (const line of logged) expect(line.startsWith(prefix)).toBe(true);
    } finally {
      await setConfig(config);
    }
    expect(await lint(LINT_SOURCE)).toHaveLength(4);
  });
});

describe('lint diagnostics with no oxlint in the project', () => {
  const {state, warnings} = formatting(LINT_FORMAT, {
    copy: copyAppOutside,
    prepare: (root) => assertNotInstalled(root, 'oxlint'),
  });

  it('give none, log one line, and the server keeps answering', async () => {
    const file = join(state.root, LINT);
    expect(await lintDiagnostics(state.server, file)).toEqual([]);
    const document = await state.server.openTextDocument(file, 'front');
    expect(await state.server.sendDocumentDiagnosticRequest(document.uri)).toMatchObject({kind: 'full'});
    expect(await lintDiagnostics(state.server, file, WITHOUT_VUE_DEBUGGER)).toEqual([]);
    const missing = `oxlint is not installed in ${state.root}; add it to devDependencies`;
    expect(warnings()).toEqual([`multifront: no linting in ${state.root} (${missing})`]);
    expect(state.server.process.exitCode).toBeNull();
  });
});
