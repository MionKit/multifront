#!/usr/bin/env node
// devx: the repo's dev CLI. A zero-dependency dispatcher over the same tools CI calls (tsc, oxlint, oxfmt,
// vitest), so local runs and CI cannot drift. Run it as `pnpm devx <command>`.
import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {join, relative} from 'node:path';
import {loadEnv, REGISTRY, REPO_ROOT} from './lib/env.mjs';
import {CLI, COMMANDS, renderHelp} from './lib/registry.mjs';
import {listPackages} from './lib/workspace.mjs';
import {renderDocsImages} from './docs-images.mjs';

class CliError extends Error {}

const bin = (name) => join(REPO_ROOT, 'node_modules', '.bin', name);

function run(cmd, args) {
  const result = spawnSync(cmd, args, {stdio: 'inherit', cwd: REPO_ROOT});
  if (result.error) throw new CliError(`${CLI}: failed to launch ${cmd}: ${result.error.message}`);
  if (result.status !== 0) throw new CliError('');
}

// Fails when a package is missing from the root build graph or the root test projects: tsc and vitest skip it silently.
function checkTree() {
  const references = readFileSync(join(REPO_ROOT, 'tsconfig.json'), 'utf8');
  const projects = readFileSync(join(REPO_ROOT, 'vitest.config.ts'), 'utf8');
  const problems = [];
  for (const pkg of listPackages()) {
    if (!references.includes(`./${pkg.dir}/tsconfig.build.json`) && !pkg.private) problems.push(`${pkg.dir} is not referenced by tsconfig.json`);
    if (!projects.includes(`'${pkg.dir}/vitest.config.ts'`)) problems.push(`${pkg.dir} is not a project in vitest.config.ts`);
  }
  if (problems.length) throw new CliError(`${CLI}: ${problems.join('\n  ')}`);
}

const handlers = {
  build(args) {
    if (args.includes('--clean')) run(bin('tsc'), ['--build', 'tsconfig.json', '--clean']);
    run(bin('tsc'), ['--build', 'tsconfig.json']);
  },
  typecheck() {
    checkTree();
    for (const pkg of listPackages()) run(bin('tsc'), ['-p', join(pkg.dir, 'tsconfig.json')]);
  },
  lint() {
    run(bin('oxlint'), []);
    handlers.typecheck();
  },
  format(args) {
    const check = args.includes('--check');
    run(bin('oxfmt'), [check ? '--check' : '--write', 'packages/**/*.{ts,md}', '*.ts']);
  },
  test(args) {
    run(bin('vitest'), ['run', ...args]);
  },
  commitlint(args) {
    run(bin('commitlint'), args);
  },
  check() {
    handlers.format(['--check']);
    handlers.lint();
    handlers.test([]);
    handlers.build([]);
  },
  clean(args) {
    const dryRun = args.includes('--dry-run');
    const names = new Set(['dist', 'coverage', ...(args.includes('--deps') ? ['node_modules'] : [])]);
    const targets = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const path = join(dir, entry.name);
        if (entry.isDirectory() && names.has(entry.name)) targets.push(path);
        else if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(path);
        else if (entry.isFile() && entry.name.endsWith('.tsbuildinfo')) targets.push(path);
      }
    };
    walk(REPO_ROOT);
    if (names.has('node_modules') && existsSync(join(REPO_ROOT, 'node_modules'))) targets.push(join(REPO_ROOT, 'node_modules'));
    for (const path of targets) {
      console.log(`${dryRun ? 'would delete' : 'delete'} ${relative(REPO_ROOT, path)}`);
      if (!dryRun) rmSync(path, {recursive: true, force: true});
    }
  },
  'docs-images'(args) {
    return renderDocsImages(args);
  },
  env() {
    for (const row of REGISTRY) console.log(`${row.name.padEnd(28)} ${row.scope.padEnd(9)} ${row.desc}`);
  },
};

async function main(argv) {
  const [command, ...args] = argv;
  if (!command || ['help', '-h', '--help'].includes(command)) return console.log(renderHelp());
  if (!COMMANDS.some((row) => row.name === command)) throw new CliError(`${CLI}: unknown command '${command}'\n\n${renderHelp()}`);
  await handlers[command](args);
}

loadEnv();
try {
  await main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof CliError)) throw error;
  if (error.message) console.error(error.message);
  process.exitCode = 1;
}
