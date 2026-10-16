// exit.spec.ts: a crash whose dumps cannot be kept, as a file sits where their folder goes.
const {blockDumpFolder, crashLeaving} = require('./crash.cjs');

module.exports = {run: crashLeaving(blockDumpFolder)};
