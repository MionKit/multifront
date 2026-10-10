// Extension test file for exit.spec.ts's run with VS Code's TypeScript extension disabled.
const {start, withoutTypescript} = require('./suite.cjs');

module.exports = {run: () => start(withoutTypescript)};
