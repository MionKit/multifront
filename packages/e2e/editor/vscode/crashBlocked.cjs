// exit.spec.ts: a crash whose dumps cannot be kept: a file blocks their folder.
const {blockDumpFolder, crashLeaving} = require('./crash.cjs');

module.exports = {run: crashLeaving(blockDumpFolder)};
