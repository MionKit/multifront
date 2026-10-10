#!/usr/bin/env node
// devx: the repo's dev CLI. A zero-dependency dispatcher over the same tools CI calls (tsc, oxlint, oxfmt,
// vitest), so local runs and CI cannot drift. Run it as `pnpm devx <command>`.
import {spawnSync} from 'node:child_process';
import {copyFileSync, cpSync, existsSync, globSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {agentDocs} from './lib/agent-docs.mjs';
import {loadEnv, REGISTRY, REPO_ROOT} from './lib/env.mjs';
import {CLI, COMMANDS, renderHelp} from './lib/registry.mjs';
import {floorOverrides, installedVersions, withOverrides} from './lib/peer-floor.mjs';
import {listPackages} from './lib/workspace.mjs';
import {renderDocsImages} from './docs-images.mjs';

class CliError extends Error {}

// The JS entry, not the `.bin` shim: Windows shims are `.cmd` files that need a shell.
function bin(pkg, name = pkg) {
  const dir = join(REPO_ROOT, 'node_modules', pkg);
  const manifest = join(dir, 'package.json');
  const entry = existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).bin?.[name];
  if (!entry || !existsSync(join(dir, entry))) throw new CliError(`${CLI}: ${pkg} is not installed, run pnpm install`);
  return join(dir, entry);
}

function run(entry, args, {cwd = REPO_ROOT, node = []} = {}) {
  const result = spawnSync(process.execPath, [...node, entry, ...args], {stdio: 'inherit', cwd});
  if (result.error) throw new CliError(`${CLI}: failed to launch ${entry}: ${result.error.message}`);
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
    if (args.includes('--clean')) run(bin('typescript', 'tsc'), ['--build', 'tsconfig.json', '--clean']);
    run(bin('typescript', 'tsc'), ['--build', 'tsconfig.json']);
  },
  typecheck() {
    checkTree();
    for (const pkg of listPackages()) run(bin('typescript', 'tsc'), ['-p', join(pkg.dir, 'tsconfig.json')]);
  },
  lint() {
    run(bin('oxlint'), []);
    handlers.typecheck();
  },
  format(args) {
    const check = args.includes('--check');
    run(bin('oxfmt'), [check ? '--check' : '--write', 'packages/**/*.{ts,md}', '*.ts']);
  },
  'agent-docs'() {
    const offenders = agentDocs();
    if (offenders.length) throw new CliError(`${CLI}: agent docs over the limit (see the compact-agent-docs skill):\n  ${offenders.join('\n  ')}`);
  },
  test(args) {
    run(bin('vitest'), ['run', ...args]);
  },
  commitlint(args) {
    run(bin('@commitlint/cli', 'commitlint'), args);
  },
  check() {
    handlers.format(['--check']);
    handlers.lint();
    handlers['agent-docs']();
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
  vsix() {
    const {version} = JSON.parse(readFileSync(join(REPO_ROOT, 'version.json'), 'utf8'));
    // vsce takes the version as given, and it names the output file.
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) throw new CliError(`${CLI}: version.json has no valid version`);
    const extension = join(REPO_ROOT, 'packages', 'vscode');
    // So stale build output is not packed.
    rmSync(join(extension, 'dist'), {recursive: true, force: true});
    run(join(REPO_ROOT, 'scripts', 'lib', 'write-grammar.mjs'), [], {node: ['--conditions=source']});
    run(join(REPO_ROOT, 'scripts', 'lib', 'bundle-vscode.mjs'), []);
    // vsce reads a license only from the extension folder, and prompts without one.
    copyFileSync(join(REPO_ROOT, 'LICENSE'), join(extension, 'LICENSE'));
    // vsce packs node_modules only for `npm list` dependencies, which workspace links break.
    // So pack a copy of the shipped files whose one dependency is the plugin pack.
    const manifest = JSON.parse(readFileSync(join(extension, 'package.json'), 'utf8'));
    const stage = mkdtempSync(join(tmpdir(), 'multifront-vsix-'));
    try {
      for (const pattern of manifest.files) {
        for (const path of globSync(pattern, {cwd: extension})) cpSync(join(extension, path), join(stage, path), {recursive: true});
      }
      writeFileSync(join(stage, 'package.json'), `${JSON.stringify({...manifest, dependencies: {'multifront-typescript-plugin-pack': version}}, null, 2)}\n`);
      const out = join(extension, `multifront-vscode-${version}.vsix`);
      // vsce would otherwise run `npm version` on package.json.
      run(bin('@vscode/vsce', 'vsce'), ['package', version, '--no-update-package-json', '--out', out], {cwd: stage});
    } finally {
      rmSync(stage, {recursive: true, force: true});
    }
  },
  'peer-floor'([framework]) {
    if (!process.env.CI) throw new CliError(`${CLI}: peer-floor rewrites pnpm-workspace.yaml and the lockfile, so it runs only in CI (CI set), on a throwaway checkout`);
    const workspace = join(REPO_ROOT, 'pnpm-workspace.yaml');
    let overrides;
    let written;
    try {
      overrides = floorOverrides(framework);
      written = withOverrides(readFileSync(workspace, 'utf8'), overrides);
    } catch (error) {
      throw new CliError(`${CLI}: ${error.message}`);
    }
    writeFileSync(workspace, written);
    // pnpm is not a package in node_modules: CI puts it on PATH.
    const install = spawnSync('pnpm', ['install', '--no-frozen-lockfile'], {stdio: 'inherit', cwd: REPO_ROOT});
    if (install.error) throw new CliError(`${CLI}: failed to launch pnpm: ${install.error.message}`);
    if (install.status !== 0) throw new CliError('');
    const installed = installedVersions(Object.keys(overrides));
    const wrong = installed.filter((copy) => copy.version !== overrides[copy.name]);
    const missing = Object.keys(overrides).filter((name) => !installed.some((copy) => copy.name === name));
    if (wrong.length || missing.length) {
      const lines = [...wrong.map((copy) => `${copy.dir}: ${copy.name} ${copy.version}, expected ${overrides[copy.name]}`), ...missing.map((name) => `${name} is not installed`)];
      throw new CliError(`${CLI}: peer-floor did not install the floor:\n  ${lines.join('\n  ')}`);
    }
    for (const copy of installed) console.log(`peer-floor: ${copy.name} ${copy.version} (${copy.dir})`);
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
