// Pins the bottom of @multifront/vite's peer ranges for one framework, so CI tests the oldest supported versions.
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {REPO_ROOT} from './env.mjs';
import {listPackages} from './workspace.mjs';

// Per framework: its peers in packages/vite/package.json, and each package that takes a peer's floor (`follow`).
const FLOOR_PEERS = {
  react: {peers: ['react', 'react-dom', '@vitejs/plugin-react'], follow: {'@types/react': 'react', '@types/react-dom': 'react-dom'}},
  // `vue` pins its own compiler-sfc exactly, so the two move together.
  vue: {peers: ['@vitejs/plugin-vue', '@vue/compiler-sfc'], follow: {vue: '@vue/compiler-sfc'}},
};

export function floorOverrides(framework) {
  const row = Object.hasOwn(FLOOR_PEERS, framework ?? '') ? FLOOR_PEERS[framework] : undefined;
  if (!row) throw new Error(`peer-floor knows ${Object.keys(FLOOR_PEERS).join(', ')}; got ${framework ?? 'nothing'}`);
  const {peerDependencies = {}} = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'vite', 'package.json'), 'utf8'));
  const overrides = {};
  for (const name of row.peers) overrides[name] = lowestVersion(name, peerDependencies[name]);
  for (const [name, peer] of Object.entries(row.follow)) overrides[name] = overrides[peer];
  return overrides;
}

// Only single-comparator ranges: their lowest version is the one they name.
export function lowestVersion(name, range) {
  const version = /^(?:\^|~|>=)?(\d+\.\d+\.\d+)$/.exec(range?.trim() ?? '')?.[1];
  if (!version) throw new Error(`peer-floor cannot read the lowest version of ${name} ${range ?? '(no peer range)'}`);
  return version;
}

export function withOverrides(workspaceYaml, overrides) {
  if (/^overrides:/m.test(workspaceYaml)) throw new Error('peer-floor: pnpm-workspace.yaml already has overrides');
  const lines = Object.entries(overrides).map(([name, version]) => `  '${name}': ${version}`);
  return `${workspaceYaml.replace(/\n*$/, '\n')}\noverrides:\n${lines.join('\n')}\n`;
}

export function installedVersions(names) {
  const dirs = ['', ...listPackages().map((pkg) => pkg.dir)];
  const found = [];
  for (const name of names) {
    for (const dir of dirs) {
      const manifest = join(REPO_ROOT, dir, 'node_modules', name, 'package.json');
      if (existsSync(manifest)) found.push({name, dir: dir || '.', version: JSON.parse(readFileSync(manifest, 'utf8')).version});
    }
  }
  return found;
}
