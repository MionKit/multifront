// Step 7.13, run in real VS Code by vsix.spec.ts with the packed .vsix installed, on a types-every-target/ copy.
// `vscode` is required in `run`, so vsix.spec.ts can load the check names outside VS Code.
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {basename, dirname, join} = require('node:path');
const {codeOf, hoverText, positionOf, runChecks, show, until} = require('./harness.cjs');

let vscode;

/** What vsix.spec.ts got from the real mf-tsc, mf-lint and mf-fmt on the same files. */
const expected = () => JSON.parse(readFileSync(process.env.MULTIFRONT_VSCODE_DATA, 'utf8'));
const workspaceFile = (name) => join(vscode.workspace.workspaceFolders[0].uri.fsPath, name);

/** mf-* positions are 1-based, VS Code's 0-based. */
function sameRange({range}, {line, column, end}) {
  return (
    range.start.line === line - 1 &&
    range.start.character === column - 1 &&
    range.end.line === end.line - 1 &&
    range.end.character === end.column - 1
  );
}

const describe = ({code, line, column}) => `${code} at ${line}:${column}`;

const checks = [
  {
    name: 'Greeting.ucf opens with language id ucf, served by the installed extension',
    async run() {
      const greeting = await show(workspaceFile('Greeting.ucf'));
      assert.equal(greeting.languageId, 'ucf');
      const extension = vscode.extensions.getExtension('mionkit.multifront-vscode');
      assert.ok(extension, 'mionkit.multifront-vscode is not loaded');
      await until(() => extension.isActive, 'the extension to activate');
      // Installed: `<extensions-dir>/<publisher>.<name>-<version>`, not the empty development folder.
      assert.equal(basename(extension.extensionPath), 'mionkit.multifront-vscode-0.0.0');
      assert.equal(basename(dirname(extension.extensionPath)), 'extensions');
    },
  },
  {
    name: "Greeting.ucf's diagnostics hold every mf-lint finding, from oxlint",
    async run() {
      const {lint} = expected();
      assert.ok(lint.length > 0, 'mf-lint found nothing');
      const uri = vscode.Uri.file(workspaceFile('Greeting.ucf'));
      const missing = () =>
        lint.filter((finding) => {
          const found = vscode.languages.getDiagnostics(uri);
          return !found.some((diagnostic) => diagnostic.source === 'oxlint' && codeOf(diagnostic) === finding.code && sameRange(diagnostic, finding));
        });
      await until(() => missing().length === 0, `oxlint diagnostics ${lint.map(describe).join(', ')}`);
    },
  },
  {
    name: "Greeting.ucf's diagnostics hold every mf-tsc finding, from tsserver with the plugin",
    async run() {
      const {tsc} = expected();
      assert.ok(tsc.length > 0, 'mf-tsc found nothing');
      const uri = vscode.Uri.file(workspaceFile('Greeting.ucf'));
      const missing = () =>
        tsc.filter((finding) => {
          const found = vscode.languages.getDiagnostics(uri);
          return !found.some((diagnostic) => `TS${codeOf(diagnostic)}` === finding.code && sameRange(diagnostic, finding));
        });
      await until(() => missing().length === 0, `TypeScript diagnostics ${tsc.map(describe).join(', ')}`);
    },
  },
  {
    name: 'Format Document on Greeting.ucf gives what mf-fmt writes',
    async run() {
      const greeting = await show(workspaceFile('Greeting.ucf'));
      const options = {tabSize: 2, insertSpaces: true};
      const edits = await until(
        async () => {
          const found = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', greeting.uri, options);
          return found?.length > 0 && found;
        },
        'formatting edits'
      );
      // Last edit first, so the earlier offsets still hold.
      const sorted = edits.map((edit) => ({start: greeting.offsetAt(edit.range.start), end: greeting.offsetAt(edit.range.end), text: edit.newText}));
      sorted.sort((first, second) => second.start - first.start);
      const formatted = sorted.reduce((text, {start, end, text: newText}) => text.slice(0, start) + newText + text.slice(end), greeting.getText());
      assert.notEqual(formatted, greeting.getText(), 'formatting changed nothing');
      assert.equal(formatted, expected().formatted);
    },
  },
  {
    name: 'hover on <Greeting in main.tsx shows the React props, from the installed TypeScript plugin',
    async run() {
      const main = await show(workspaceFile('main.tsx'));
      const at = positionOf(main, '<Greeting', 1);
      await until(async () => {
        const text = hoverText(await vscode.commands.executeCommand('vscode.executeHoverProvider', main.uri, at));
        return !text.includes('(loading...)') && text.includes('name: string') && text.includes('count?: number') && text;
      }, 'a hover with name: string and count?: number');
    },
  },
];

// VS Code calls `run` with the tests root, which no check needs.
module.exports = {
  checks,
  run: () => {
    vscode = require('vscode');
    return runChecks(checks);
  },
};
