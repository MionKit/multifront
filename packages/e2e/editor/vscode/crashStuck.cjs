// exit.spec.ts: a crash whose leftover writer never stops; the harness kills it.
const {crashLeaving, leaveWriter} = require('./crash.cjs');

module.exports = {run: crashLeaving(() => leaveWriter(':'))};
