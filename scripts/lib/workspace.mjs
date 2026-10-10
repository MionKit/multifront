// Reads the workspace packages straight from packages/*/package.json, so no list of them is kept by hand.
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {REPO_ROOT} from './env.mjs';

export function listPackages() {
  const root = join(REPO_ROOT, 'packages');
  return readdirSync(root, {withFileTypes: true})
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'package.json')))
    .map((entry) => {
      // Always `/`: matched as text against tsconfig.json and vitest.config.ts, also on Windows.
      const dir = `packages/${entry.name}`;
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, dir, 'package.json'), 'utf8'));
      return {dir, name: manifest.name, private: manifest.private === true};
    });
}
