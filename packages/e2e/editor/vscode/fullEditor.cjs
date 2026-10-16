// Milestone 7 exit test, run in real VS Code by exit.spec.ts with the packed .vsix installed, on an edited Card.ucf copy.
// `vscode` is required in `run`, so exit.spec.ts can load the check names outside VS Code.
const assert = require('node:assert/strict');
const {join} = require('node:path');
const {codeOf, expected, formattedText, positionOf, runChecks, show, until} = require('./harness.cjs');

let vscode;
// Typed as the last markup of <svelte>, unclosed, as VS Code holds it while typing.
const MARKUP_END = ['\n</svelte>', 0];

const card = () => join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'Card.ucf');

/** mf-* positions are 1-based, VS Code's 0-based. */
const rangeOf = ({line, column, end}) => `${line - 1}:${column - 1}-${end.line - 1}:${end.column - 1}`;
const vscodeRange = ({range}) => `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
const asText = (code, range) => `${code} at ${range}`;

function shownProblems(uri) {
  const {Error, Warning} = vscode.DiagnosticSeverity;
  return vscode.languages
    .getDiagnostics(uri)
    .filter(({severity}) => severity === Error || severity === Warning)
    .map((diagnostic) => {
      const code = String(codeOf(diagnostic));
      return asText(diagnostic.source === 'oxlint' ? code : `TS${code}`, vscodeRange(diagnostic));
    })
    .sort();
}

// VS Code's TypeScript extension marks an optional member's label with `?`; it inserts the bare name.
const label = ({label: itemLabel}) => (typeof itemLabel === 'string' ? itemLabel : itemLabel.label).replace(/\?$/, '');

/** Inserts each `[text, needle, shift]` into the unsaved buffer, `shift` past the needle (default: after it), in one edit. */
async function type(document, inserts) {
  const workspaceEdit = new vscode.WorkspaceEdit();
  for (const [text, needle, shift = needle.length] of inserts) workspaceEdit.insert(document.uri, positionOf(document, needle, shift), text);
  assert.ok(await vscode.workspace.applyEdit(workspaceEdit), 'the edit did not apply');
}

async function labelsAt(document, needle, wanted, what) {
  const at = positionOf(document, needle, needle.length);
  let labels = [];
  return until(async () => {
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, at);
    labels = list.items.map(label);
    return wanted.every((name) => labels.includes(name)) && labels;
  }, `${what} listing ${wanted.join(', ')}`).catch((err) => {
    throw new Error(`${err.message}; listed: ${labels.slice(0, 40).join(', ')}`);
  });
}

async function revert(document) {
  await vscode.window.showTextDocument(document, {preview: false});
  await vscode.commands.executeCommand('workbench.action.files.revert');
}

const checks = [
  {
    name: '3. Card.ucf shows the same two findings as mf-tsc and mf-lint, at the same ranges',
    async run() {
      const document = await show(card());
      assert.equal(document.languageId, 'ucf');
      const {tsc, lint} = expected();
      const wanted = [...tsc, ...lint].map((finding) => asText(finding.code, rangeOf(finding))).sort();
      assert.equal(wanted.length, 2, `mf-tsc and mf-lint found ${wanted.join(', ')}`);
      await until(() => JSON.stringify(shownProblems(document.uri)) === JSON.stringify(wanted), `exactly ${wanted.join(', ')}`).catch(
        (err) => {
          throw new Error(`${err.message}; shown: ${shownProblems(document.uri).join(', ')}`);
        }
      );
    },
  },
  {
    name: '4. Format Document on Card.ucf gives byte for byte what mf-fmt writes on a second copy',
    async run() {
      const formatted = await formattedText(await show(card()));
      assert.equal(formatted, expected().formatted);
    },
  },
  {
    name: '5. completion after <input bi in the <svelte> markup lists bind:value',
    async run() {
      const document = await show(card());
      try {
        await type(document, [['\n  <input bi', ...MARKUP_END]]);
        await labelsAt(document, '<input bi', ['bind:value'], 'completion after <input bi');
      } finally {
        await revert(document);
      }
    },
  },
  {
    name: '5. completion after <Icon in the <svelte> markup lists name and size',
    async run() {
      const document = await show(card());
      try {
        const script = '<svelte>\n  <script lang="ts">';
        await type(document, [
          ["\n    import Icon from './Icon.ucf'", script],
          ['\n  <Icon ', ...MARKUP_END],
        ]);
        await labelsAt(document, '<Icon ', ['name', 'size'], 'completion after <Icon ');
      } finally {
        await revert(document);
      }
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
