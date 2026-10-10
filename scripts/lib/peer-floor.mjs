// peer-floor: pins the bottom of @multifront/vite's peer ranges for one framework, so CI tests the oldest supported versions.
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {REPO_ROOT} from './env.mjs';
import {listPackages} from './workspace.mjs';

// Per framework: its peers in packages/vite/package.json, and each types package with the peer whose floor it takes.
export const FLOOR_PEERS = {
  react: {peers: ['react', 'react-dom', '@vitejs/plugin-react'], types: {'@types/react': 'react', '@types/react-dom': 'react-dom'}},
};

export function floorOverrides(framework) {
  const row = FLOOR_PEERS[framework];
  if (!row) throw new Error(`peer-floor knows ${Object.keys(FLOOR_PEERS).join(', ')}; got ${framework ?? 'nothing'}`);
  const {peerDependencies = {}} = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'vite', 'package.json'), 'utf8'));
  const overrides = {};
  for (const name of row.peers) overrides[name] = lowestVersion(name, peerDependencies[name]);
  for (const [name, peer] of Object.entries(row.types)) overrides[name] = overrides[peer];
  return overrides;
}

// Only single-comparator ranges: their lowest version is the one they name.
function lowestVersion(name, range) {
  const version = /^(?:\^|~|>=)?(\d+\.\d+\.\d+)$/.exec(range?.trim() ?? '')?.[1];
  if (!version) throw new Error(`peer-floor cannot read the lowest version of ${name} ${range ?? '(no peer range)'}`);
  return version;
}

export function withOverrides(workspaceYaml, overrides) {
  if (/^overrides:/m.test(workspaceYaml)) throw new Error('peer-floor: pnpm-workspace.yaml already has overrides');
  const lines = Object.entries(overrides).map(([name, version]) => `  '${name}': ${version}`);
  return `${workspaceYaml.replace(/\n*$/, '\n')}\noverrides:\n${lines.join('\n')}\n`;
}

// Every copy pnpm linked into the root or a workspace package, with the version it holds.
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
