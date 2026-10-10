// Plain CommonJS: VS Code's extension host loads extension test files with require.
// `runInVsCode()` in ../lib/vscode.ts reads the JSON results file it writes.
const {execFileSync} = require('node:child_process');
const {writeFileSync} = require('node:fs');
const {join} = require('node:path');

/** Never throws: a failed check is recorded, so VS Code exits 0 and the spec still reads every result. */
async function runChecks(checks) {
  const results = [];
  for (const check of checks) {
    try {
      await check.run();
      results.push({name: check.name});
    } catch (err) {
      results.push({name: check.name, error: err instanceof Error ? (err.stack ?? err.message) : String(err)});
    }
  }
  writeFileSync(process.env.MULTIFRONT_VSCODE_RESULTS, JSON.stringify(results, null, 2));
}

/** Language features answer late, or with `(loading...)` first. */
async function until(probe, what, ms = 60_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const value = await probe();
      if (value) return value;
      last = value;
    } catch (err) {
      last = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

/** VS Code checks only documents open in a tab, and the next file replaces a preview tab. */
async function show(path) {
  const vscode = require('vscode');
  const document = await vscode.workspace.openTextDocument(path);
  await vscode.window.showTextDocument(document, {preview: false});
  return document;
}

function positionOf(document, needle, shift = 0, from = 0) {
  const index = document.getText().indexOf(needle, from);
  if (index < 0) throw new Error(`${needle} not found in ${document.fileName}`);
  return document.positionAt(index + shift);
}

/** Pids of the extension's language servers that are children of this extension host. */
function serverProcesses(extensionPath) {
  // Matched on the whole line: a path may hold spaces.
  const server = ` ${join(extensionPath, 'dist', 'server.cjs')} --node-ipc`;
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], {encoding: 'utf8'})
    .split('\n')
    .filter((line) => line.includes(server))
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, ppid]) => ppid === process.pid)
    .map(([pid]) => pid);
}

function hoverText(hovers) {
  return hovers.flatMap(({contents}) => contents.map((part) => (typeof part === 'string' ? part : part.value))).join('\n');
}

/** TypeScript's diagnostic code may come as `{value, target}`. */
function codeOf({code}) {
  return typeof code === 'object' && code !== null ? code.value : code;
}

module.exports = {runChecks, until, show, positionOf, serverProcesses, hoverText, codeOf};
