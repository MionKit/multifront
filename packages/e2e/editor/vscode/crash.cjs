// exit.spec.ts's SIGSEGV suite: crashes VS Code's main process, as the unexplained crash did.
const {execFileSync, spawn} = require('node:child_process');
const {dirname, join} = require('node:path');

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

/** Like Crashpad: outlives VS Code in its own process group, writing into the run's folder for about 3 s. */
function leaveWriter() {
  const folder = join(dirname(process.env.MULTIFRONT_VSCODE_RESULTS), 'crashes', 'late');
  const script = 'i=0; while [ $i -lt 300 ]; do mkdir -p "$1" && : > "$1/$i"; i=$((i+1)); sleep 0.01; done';
  spawn('sh', ['-c', script, 'writer', folder], {detached: true, stdio: 'ignore'}).unref();
}

module.exports = {
  run: async () => {
    leaveWriter();
    process.kill(mainProcess(), 'SIGSEGV');
    // VS Code is gone before this ends; a run that outlives it fails exit.spec.ts on its missing results.
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  },
};
