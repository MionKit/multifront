// The milestone 2 exit test, run inside the real VS Code by exit.spec.ts, on the workspace fixtures/apps/imports/.
// `vscode` is required inside each check, so exit.spec.ts can read the check names outside VS Code.
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {codeOf, hoverText, positionOf, runChecks, serverProcesses, show, until} = require('./harness.cjs');

const CARD_SIGNATURE = 'Card({ title }: { title: string })';

function paths() {
  const vscode = require('vscode');
  const app = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const components = join(app, '..', '..', 'components');
  return {app: join(app, 'src', 'App.tsx'), component: (name) => join(components, name)};
}

function extension() {
  const vscode = require('vscode');
  // Found by name: the id gains a publisher in M7.
  const found = vscode.extensions.all.find(({packageJSON}) => packageJSON.name === 'multifront-vscode');
  assert.ok(found, 'multifront-vscode is not loaded');
  return found;
}

/** First token with text `text` inside `blockScope`. */
function token(tokens, text, blockScope) {
  const found = tokens.find(({c, t}) => c.trim() === text && t.split(' ').includes(blockScope));
  assert.ok(found, `no ${text} token in ${blockScope}`);
  return found.t.split(' ');
}

function blockRange(document, tag) {
  const text = document.getText();
  const start = text.indexOf(`<${tag}>`) + `<${tag}>`.length;
  return {start, end: text.indexOf(`</${tag}>`, start)};
}

/** Where a definition result lands: Location or LocationLink. */
function target(definitions) {
  assert.equal(definitions.length, 1, `one definition expected, got ${definitions.length}`);
  const [definition] = definitions;
  return {fsPath: (definition.targetUri ?? definition.uri).fsPath, start: (definition.targetSelectionRange ?? definition.targetRange ?? definition.range).start};
}

async function cardPropsHover(document, needle) {
  const vscode = require('vscode');
  const at = positionOf(document, needle, 1);
  return until(async () => {
    const text = hoverText(await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, at));
    return !text.includes('(loading...)') && text.includes('title: string') && text;
  }, `a hover on ${needle} in ${document.fileName} with title: string`);
}

function diagnosticsOnLine(uri, line) {
  const vscode = require('vscode');
  return vscode.languages.getDiagnostics(uri).filter(({range}) => range.start.line === line);
}

const checks = [
  {
    name: 'activate: showing Card.ucf activates the extension, which forks its bundled server over IPC',
    async run() {
      await show(paths().component('Card.ucf'));
      const ext = extension();
      await until(() => ext.isActive, 'the extension to activate');
      await until(() => serverProcesses(ext.extensionPath).length === 1, 'one dist/server.cjs --node-ipc child of the extension host');
    },
  },
  {
    name: '1. Card.ucf opens with language id ucf',
    async run() {
      assert.equal((await show(paths().component('Card.ucf'))).languageId, 'ucf');
    },
  },
  {
    name: '1. captureSyntaxTokens gives TSX, SCSS, Vue and Svelte scopes in their blocks',
    async run() {
      const vscode = require('vscode');
      const card = await show(paths().component('Card.ucf'));
      const tokens = await vscode.commands.executeCommand('_workbench.captureSyntaxTokens', card.uri);
      const react = token(tokens, 'export', 'meta.embedded.block.react');
      assert.ok(react.includes('keyword.control.export.tsx'), react.join(' '));
      const style = token(tokens, 'padding', 'meta.embedded.block.style.scss');
      assert.ok(style.includes('meta.property-list.scss') && style.includes('support.type.property-name.css'), style.join(' '));
      const vue = token(tokens, '{{', 'meta.embedded.block.vue');
      assert.ok(vue.includes('punctuation.definition.interpolation.begin.html.vue'), vue.join(' '));
      const svelte = token(tokens, 'let', 'meta.embedded.block.svelte');
      assert.ok(svelte.includes('meta.script.svelte') && svelte.includes('storage.type.ts'), svelte.join(' '));
    },
  },
  {
    name: '2. completion after $style. in <react> lists card',
    async run() {
      const vscode = require('vscode');
      const card = await show(paths().component('Card.ucf'));
      const at = positionOf(card, '$style.card', '$style.'.length, blockRange(card, 'react').start);
      await until(async () => {
        const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', card.uri, at);
        return list.items.some(({label}) => (typeof label === 'string' ? label : label.label) === 'card');
      }, 'card in the completion list');
    },
  },
  {
    name: '2. definition on $style.card in <react> lands on .card',
    async run() {
      const vscode = require('vscode');
      const card = await show(paths().component('Card.ucf'));
      const at = positionOf(card, '$style.card', '$style.c'.length, blockRange(card, 'react').start);
      const landed = target(
        await until(async () => {
          const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', card.uri, at);
          return definitions.length > 0 && definitions;
        }, 'a definition of $style.card')
      );
      assert.equal(landed.fsPath, card.uri.fsPath);
      assert.equal(card.offsetAt(landed.start), card.getText().indexOf('.card {') + 1);
    },
  },
  {
    name: '2. hover on <Card in editor/Profile.ucf shows its props',
    async run() {
      await cardPropsHover(await show(paths().component('editor/Profile.ucf')), '<Card');
    },
  },
  {
    name: "3. hover on a property in Panel.ucf's <style> shows its CSS docs",
    async run() {
      const vscode = require('vscode');
      const panel = await show(paths().component('Panel.ucf'));
      const at = positionOf(panel, 'padding: $pad', 2);
      await until(async () => {
        const text = hoverText(await vscode.commands.executeCommand('vscode.executeHoverProvider', panel.uri, at));
        return text.includes('the padding area');
      }, 'the CSS docs of padding');
    },
  },
  {
    name: '4. editor/TypeError.ucf has its type error on its line',
    async run() {
      const typeError = await show(paths().component('editor/TypeError.ucf'));
      const line = positionOf(typeError, 'label:').line;
      await until(() => diagnosticsOnLine(typeError.uri, line).some((diagnostic) => codeOf(diagnostic) === 2322), 'TS2322 on the label line');
    },
  },
  {
    name: '4. invalid/DuplicateReact.ucf has duplicate-target from multifront',
    async run() {
      const vscode = require('vscode');
      const duplicate = await show(paths().component('invalid/DuplicateReact.ucf'));
      await until(
        () => vscode.languages.getDiagnostics(duplicate.uri).some((diagnostic) => codeOf(diagnostic) === 'duplicate-target' && diagnostic.source === 'multifront'),
        'a multifront duplicate-target diagnostic'
      );
    },
  },
  {
    name: '5. hover on <Card in src/App.tsx shows the props from Card.ucf',
    async run() {
      await cardPropsHover(await show(paths().app), '<Card');
    },
  },
  {
    name: "5. definition on <Card in src/App.tsx lands inside Card.ucf's <react>",
    async run() {
      const vscode = require('vscode');
      const app = await show(paths().app);
      const at = positionOf(app, '<Card', 1);
      const landed = target(
        await until(async () => {
          const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', app.uri, at);
          return definitions.length > 0 && definitions;
        }, 'a definition of Card')
      );
      assert.equal(landed.fsPath, paths().component('Card.ucf'));
      const card = await vscode.workspace.openTextDocument(landed.fsPath);
      const offset = card.offsetAt(landed.start);
      const react = blockRange(card, 'react');
      assert.ok(offset >= react.start && offset < react.end, `offset ${offset} is outside <react> ${react.start}-${react.end}`);
    },
  },
  {
    name: '6. an unsaved prop rename in Card.ucf shows as an error in src/App.tsx before any save',
    async run() {
      const vscode = require('vscode');
      const app = await show(paths().app);
      const line = positionOf(app, '<Card').line;
      const cardPath = paths().component('Card.ucf');
      const onDisk = readFileSync(cardPath, 'utf8');
      const card = await show(cardPath);
      const edit = new vscode.WorkspaceEdit();
      const start = positionOf(card, CARD_SIGNATURE);
      edit.replace(card.uri, new vscode.Range(start, start.translate(0, CARD_SIGNATURE.length)), 'Card({ heading }: { heading: string })');
      assert.ok(await vscode.workspace.applyEdit(edit), 'the edit was refused');
      try {
        await until(() => diagnosticsOnLine(app.uri, line).some((diagnostic) => codeOf(diagnostic) === 2322), 'TS2322 on the <Card line of App.tsx');
        assert.ok(card.isDirty, 'Card.ucf was saved');
        assert.equal(readFileSync(cardPath, 'utf8'), onDisk);
      } finally {
        await vscode.window.showTextDocument(card, {preview: false});
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
      assert.equal(card.getText(), onDisk);
      await until(() => vscode.languages.getDiagnostics(app.uri).length === 0, 'App.tsx without diagnostics after the revert');
    },
  },
  {
    name: 'deactivate stops the bundled server',
    async run() {
      const {extensionPath} = extension();
      assert.equal(serverProcesses(extensionPath).length, 1, 'the server is not running');
      // The module the extension host loaded: require caches it by path.
      await require(join(extensionPath, 'dist', 'extension.cjs')).deactivate();
      await until(() => serverProcesses(extensionPath).length === 0, 'the server process to exit');
    },
  },
];

module.exports = {checks, run: () => runChecks(checks)};
