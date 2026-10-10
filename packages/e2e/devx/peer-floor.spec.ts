import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';

type PeerFloor = {
  floorOverrides: (framework: string) => Record<string, string>;
  withOverrides: (workspaceYaml: string, overrides: Record<string, string>) => string;
};

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const WORKSPACE = join(REPO_ROOT, 'pnpm-workspace.yaml');
const {floorOverrides, withOverrides} = (await import(
  pathToFileURL(join(REPO_ROOT, 'scripts', 'lib', 'peer-floor.mjs')).href
)) as PeerFloor;

const REACT_FLOOR = {
  react: '19.0.0',
  'react-dom': '19.0.0',
  '@vitejs/plugin-react': '6.0.0',
  '@types/react': '19.0.0',
  '@types/react-dom': '19.0.0',
};

function devx(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'devx.mjs'), ...args], {encoding: 'utf8', env});
}

describe('peer-floor', () => {
  it('reads the bottom of the react peer ranges of @multifront/vite', () => {
    expect(floorOverrides('react')).toEqual(REACT_FLOOR);
  });

  it('appends the overrides to the real pnpm-workspace.yaml, once', () => {
    const written = withOverrides(readFileSync(WORKSPACE, 'utf8'), REACT_FLOOR);
    expect(
      written.endsWith(
        "\noverrides:\n  'react': 19.0.0\n  'react-dom': 19.0.0\n  '@vitejs/plugin-react': 6.0.0\n  '@types/react': 19.0.0\n  '@types/react-dom': 19.0.0\n"
      )
    ).toBe(true);
    expect(() => withOverrides(written, REACT_FLOOR)).toThrow('already has overrides');
  });

  it('refuses to run outside CI and changes nothing', () => {
    const before = readFileSync(WORKSPACE, 'utf8');
    const {CI: _ci, ...local} = process.env;
    const result = devx(local, 'peer-floor', 'react');
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(
      'devx: peer-floor rewrites pnpm-workspace.yaml and the lockfile, so it runs only in CI (CI set), on a throwaway checkout'
    );
    expect(readFileSync(WORKSPACE, 'utf8')).toBe(before);
  });

  it('names the frameworks it knows for any other one, and changes nothing', () => {
    const before = readFileSync(WORKSPACE, 'utf8');
    const result = devx({...process.env, CI: '1'}, 'peer-floor', 'angular');
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('devx: peer-floor knows react; got angular');
    expect(readFileSync(WORKSPACE, 'utf8')).toBe(before);
  });
});
