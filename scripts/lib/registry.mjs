// The devx command table: one row per command renders the help and drives the dispatcher, so they cannot drift.
export const CLI = 'devx';

export const COMMANDS = [
  {name: 'build', summary: 'compile every package to its dist/ (tsc --build)', flags: [['--clean', 'delete the build output first']]},
  {name: 'typecheck', summary: 'type-check every package, and fail if a package is missing from the build graph or the test projects'},
  {name: 'lint', summary: 'oxlint over every package, then typecheck'},
  {name: 'format', summary: 'oxfmt over packages/**/*.ts and packages/**/*.md', flags: [['--check', 'report unformatted files, change nothing']]},
  {name: 'test', args: '[vitest args…]', summary: 'run every vitest project (extra args go to vitest)'},
  {name: 'agent-docs', summary: 'fail if an AGENTS.md, CLAUDE.md, skill or .agents/ file is over 100 lines or 120 chars per line'},
  {name: 'check', summary: 'everything CI runs: format --check, lint, agent-docs, test, the core tests again from packages/core, build'},
  {name: 'commitlint', args: '[commitlint args…]', summary: 'check commit messages against Conventional Commits (args go to commitlint, e.g. --from <ref> --to <ref>)'},
  {name: 'clean', summary: 'delete every dist/, coverage/ and *.tsbuildinfo', flags: [['--deps', 'also delete every node_modules'], ['--dry-run', 'list, delete nothing']]},
  {name: 'docs-images', args: '[names…]', summary: 'render docs/ and publicdocs/ assets/src/*.html to assets/*.png with Playwright'},
  {name: 'vsix', summary: 'write the .ucf grammars and bundle the extension, server and TypeScript plugin into packages/vscode/dist/, then pack packages/vscode/multifront-vscode-<version>.vsix'},
  {name: 'peer-floor', args: '<framework>', summary: "CI only: pin the lowest versions of @multifront/vite's <framework> peer ranges as pnpm overrides and reinstall (rewrites the lockfile)"},
  {name: 'consumer-pack', args: '<dir>', summary: 'build the e2e fixture library and pack one tarball per framework into <dir>, listed in <dir>/tarballs.json (CI hands it to the consumer job)'},
  {name: 'env', summary: 'print every env var the repo reads'},
];

export function renderHelp() {
  const width = Math.max(...COMMANDS.map((row) => `${row.name} ${row.args ?? ''}`.length));
  const lines = [`usage: pnpm ${CLI} <command> [flags]`, ''];
  for (const row of COMMANDS) {
    lines.push(`  ${`${row.name} ${row.args ?? ''}`.padEnd(width)}  ${row.summary}`);
    for (const [flag, help] of row.flags ?? []) lines.push(`  ${''.padEnd(width)}    ${flag.padEnd(12)} ${help}`);
  }
  return lines.join('\n');
}
