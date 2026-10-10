import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';

type PeerFloor = {
  floorOverrides: (framework: string) => Record<string, string>;
  lowestVersion: (name: string, range: string | undefined) => string;
  withOverrides: (workspaceYaml: string, overrides: Record<string, string>) => string;
  installedVersions: (names: string[]) => {name: string; dir: string; version: string}[];
};

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const WORKSPACE = join(REPO_ROOT, 'pnpm-workspace.yaml');
const {floorOverrides, lowestVersion, withOverrides, installedVersions} = (await import(
  pathToFileURL(join(REPO_ROOT, 'scripts', 'lib', 'peer-floor.mjs')).href
)) as PeerFloor;

const REACT_FLOOR = {
  react: '19.0.0',
  'react-dom': '19.0.0',
  '@vitejs/plugin-react': '6.0.0',
  '@types/react': '19.0.0',
  '@types/react-dom': '19.0.0',
};

// The react-floor CI job has already added its overrides to the working copy.
const COMMITTED_WORKSPACE = spawnSync('git', ['show', 'HEAD:pnpm-workspace.yaml'], {cwd: REPO_ROOT, encoding: 'utf8'}).stdout;

const {CI: _ci, ...LOCAL_ENV} = process.env;

function devx(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'devx.mjs'), ...args], {encoding: 'utf8', env});
}

describe('peer-floor', () => {
  it('reads the bottom of the react peer ranges of @multifront/vite', () => {
    expect(floorOverrides('react')).toEqual(REACT_FLOOR);
  });

  it('reads only ranges that name their lowest version', () => {
    expect(lowestVersion('react', '>=19.1.0')).toBe('19.1.0');
    expect(() => lowestVersion('react', '^18.0.0 || ^19.0.0')).toThrow(
      'peer-floor cannot read the lowest version of react ^18.0.0 || ^19.0.0'
    );
    expect(() => lowestVersion('react', undefined)).toThrow('peer-floor cannot read the lowest version of react (no peer range)');
  });

  it('appends the overrides to the committed pnpm-workspace.yaml, once', () => {
    expect(COMMITTED_WORKSPACE).toContain('packages:');
    const written = withOverrides(COMMITTED_WORKSPACE, REACT_FLOOR);
    expect(
      written.endsWith(
        "\noverrides:\n  'react': 19.0.0\n  'react-dom': 19.0.0\n  '@vitejs/plugin-react': 6.0.0\n  '@types/react': 19.0.0\n  '@types/react-dom': 19.0.0\n"
      )
    ).toBe(true);
    expect(() => withOverrides(written, REACT_FLOOR)).toThrow('already has overrides');
  });

  it('finds every installed copy of a package, and none of a missing one', () => {
    const copies = installedVersions(['react', 'multifront-not-a-package']);
    expect(copies.map((copy) => copy.dir).sort()).toEqual(['.', 'packages/vite']);
    expect(copies.every((copy) => copy.name === 'react' && copy.version === copies[0]!.version)).toBe(true);
  });

  it.each([
    [
      'outside CI',
      LOCAL_ENV,
      ['react'],
      'devx: peer-floor rewrites pnpm-workspace.yaml and the lockfile, so it runs only in CI (CI set), on a throwaway checkout',
    ],
    ['for an unknown framework', {...process.env, CI: '1'}, ['angular'], 'devx: peer-floor knows react; got angular'],
    ['for an inherited key', {...process.env, CI: '1'}, ['toString'], 'devx: peer-floor knows react; got toString'],
    ['with no framework', {...process.env, CI: '1'}, [], 'devx: peer-floor knows react; got nothing'],
  ])('refuses to run %s and changes nothing', (_case, env, args, message) => {
    const before = readFileSync(WORKSPACE, 'utf8');
    const result = devx(env, 'peer-floor', ...args);
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(message);
    expect(readFileSync(WORKSPACE, 'utf8')).toBe(before);
  });
});
