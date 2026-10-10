// Runs inside VS Code's extension host, as plain CommonJS: the host loads an extension test file with require.
// `runInVsCode()` in ../lib/vscode.ts starts it and reads the JSON results file it writes.
const {execFileSync} = require('node:child_process');
const {writeFileSync} = require('node:fs');
const {join} = require('node:path');

/** Runs every check in order and writes `[{name, error?}]` to MULTIFRONT_VSCODE_RESULTS; never throws. */
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

/** Polls `probe` until it returns a truthy value; language features answer late, or with `(loading...)` first. */
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

/** Opens `path` in its own tab: VS Code checks only documents open in a tab, and a preview tab is replaced by the next. */
async function show(path) {
  const vscode = require('vscode');
  const document = await vscode.workspace.openTextDocument(path);
  await vscode.window.showTextDocument(document, {preview: false});
  return document;
}

/** The position `shift` characters past the first `needle` at or after `from`. */
function positionOf(document, needle, shift = 0, from = 0) {
  const index = document.getText().indexOf(needle, from);
  if (index < 0) throw new Error(`${needle} not found in ${document.fileName}`);
  return document.positionAt(index + shift);
}

/** Pids of the extension's language servers that are children of this extension host. */
function serverProcesses(extensionPath) {
  const server = join(extensionPath, 'dist', 'server.cjs');
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], {encoding: 'utf8'})
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([, ppid, ...args]) => Number(ppid) === process.pid && args.includes(server) && args.includes('--node-ipc'))
    .map(([pid]) => Number(pid));
}

/** Hover text, every content part joined. */
function hoverText(hovers) {
  return hovers.flatMap(({contents}) => contents.map((part) => (typeof part === 'string' ? part : part.value))).join('\n');
}

/** A diagnostic's code as a number or string; TypeScript's may come as `{value, target}`. */
function codeOf({code}) {
  return typeof code === 'object' && code !== null ? code.value : code;
}

module.exports = {runChecks, until, show, positionOf, serverProcesses, hoverText, codeOf};
