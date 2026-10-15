// Extension test file for exit.spec.ts's SIGSEGV run: crashes VS Code's main process, as the unexplained crash did.
const {execFileSync} = require('node:child_process');

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

module.exports = {
  run: async () => {
    process.kill(mainProcess(), 'SIGSEGV');
    // VS Code is gone before this ends; a run that outlives it fails exit.spec.ts on its missing results.
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  },
};
