// exit.spec.ts's SIGSEGV suite: crashes VS Code's main process, as the unexplained crash did.
const {execFileSync, spawn} = require('node:child_process');
const {mkdirSync, writeFileSync} = require('node:fs');
const {basename, dirname, join} = require('node:path');

function parentOf(pid) {
  return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {encoding: 'utf8'}).trim());
}

/** VS Code's main process: the first ancestor of this extension host with no `--type=` argument. */
function mainProcess() {
  for (let pid = parentOf(process.pid); pid > 1; pid = parentOf(pid)) {
    if (!execFileSync('ps', ['-o', 'args=', '-p', String(pid)], {encoding: 'utf8'}).includes('--type=')) return pid;
  }
  throw new Error('no VS Code main process above the extension host');
}

function lateFolder() {
  return join(dirname(process.env.MULTIFRONT_VSCODE_RESULTS), 'crashes', 'late');
}

/** Mimics Crashpad: outlives VS Code, names the run's folder in its args, writes into it. */
function leaveWriter(loop) {
  const script = `while ${loop}; do mkdir -p "$1" && : > "$1/$i"; i=$((i+1)); sleep 0.01; done`;
  spawn('sh', ['-c', `i=0; ${script}`, 'writer', lateFolder()], {detached: true, stdio: 'ignore'}).unref();
}

/** A file where `runInVsCode` would copy this run's dumps: CRASH_DIR in ../lib/vscode.ts. */
function blockDumpFolder() {
  const crashDir = join(__dirname, '..', '..', '.tmp', 'vscode-crashes');
  mkdirSync(crashDir, {recursive: true});
  writeFileSync(join(crashDir, basename(dirname(process.env.MULTIFRONT_VSCODE_RESULTS))), '');
}

function crashLeaving(leave) {
  return async () => {
    leave();
    process.kill(mainProcess(), 'SIGSEGV');
    // VS Code is gone before this ends; a run that outlives it fails exit.spec.ts on its missing results.
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  };
}

module.exports = {
  run: crashLeaving(() => leaveWriter('[ $i -lt 300 ]')),
  crashLeaving,
  leaveWriter,
  blockDumpFolder,
};
