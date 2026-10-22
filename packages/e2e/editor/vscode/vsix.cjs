// Step 7.13, run in real VS Code by vsix.spec.ts with the packed .vsix installed, on a types-every-target/ copy.
// `vscode` is required in `run`, so vsix.spec.ts can load the check names outside VS Code.
const assert = require('node:assert/strict');
const {basename, dirname, join} = require('node:path');
const {codeOf, expected, formattedText, hoverAt, positionOf, runChecks, show, until} = require('./harness.cjs');

let vscode;

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

async function holdsEvery(key, what, matches) {
  const findings = expected()[key];
  assert.ok(findings.length > 0, `the real mf-${key} found nothing`);
  const uri = vscode.Uri.file(workspaceFile('Greeting.front'));
  const held = () => {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    return findings.every((finding) => diagnostics.some((diagnostic) => matches(diagnostic, finding) && sameRange(diagnostic, finding)));
  };
  await until(held, `${what} diagnostics ${findings.map(describe).join(', ')}`);
}

const checks = [
  {
    name: 'Greeting.front opens with language id front, served by the installed extension',
    async run() {
      const greeting = await show(workspaceFile('Greeting.front'));
      assert.equal(greeting.languageId, 'front');
      const extension = vscode.extensions.getExtension('mionkit.multifront-vscode');
      assert.ok(extension, 'mionkit.multifront-vscode is not loaded');
      await until(() => extension.isActive, 'the extension to activate');
      // Installed: `<extensions-dir>/<publisher>.<name>-<version>`, not the empty development folder.
      assert.equal(basename(extension.extensionPath), 'mionkit.multifront-vscode-0.0.0');
      assert.equal(basename(dirname(extension.extensionPath)), 'extensions');
    },
  },
  {
    name: "Greeting.front's diagnostics hold every mf-lint finding, from oxlint",
    run: () => holdsEvery('lint', 'oxlint', (diagnostic, {code}) => diagnostic.source === 'oxlint' && codeOf(diagnostic) === code),
  },
  {
    name: "Greeting.front's diagnostics hold every mf-tsc finding, from tsserver with the plugin",
    run: () => holdsEvery('tsc', 'TypeScript', (diagnostic, {code}) => `TS${codeOf(diagnostic)}` === code),
  },
  {
    name: 'Format Document on Greeting.front gives what mf-fmt writes',
    async run() {
      const greeting = await show(workspaceFile('Greeting.front'));
      const formatted = await formattedText(greeting);
      assert.notEqual(formatted, greeting.getText(), 'formatting changed nothing');
      assert.equal(formatted, expected().formatted);
    },
  },
  {
    name: 'hover on <Greeting in main.tsx shows the React props, from the installed TypeScript plugin',
    async run() {
      const main = await show(workspaceFile('main.tsx'));
      await hoverAt(main, positionOf(main, '<Greeting', 1), ['name: string', 'count?: number'], 'a hover on <Greeting in main.tsx');
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
