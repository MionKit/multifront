import {execFile} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {LIBRARY_DIR, TMP_DIR, removeLibrary} from '../fixtures/index.ts';
import {buildFixtureLibrary, resultOf, withEditedLibrary} from '../build/lib/library.ts';
import type {BuiltLibrary} from '../build/lib/library.ts';
import {REPO_ROOT} from './lib/app.ts';
import {attw, fixtureTarballs, packLibrary, publint, tarFiles} from './lib/pack.ts';

const TARGETS = ['react', 'vue'] as const;
const FIXTURE = JSON.parse(readFileSync(join(LIBRARY_DIR, 'package.json'), 'utf8')) as Record<string, unknown>;
const COMPONENTS = {
  react: ['Badge', 'Button', 'Card', 'Counter', 'Icon', 'Panel', 'Tooltip', 'forms/Field'],
  vue: ['Badge', 'Button', 'Card', 'Counter', 'Icon', 'Panel', 'Tooltip', 'VueOnly', 'forms/Field'],
};
const PEERS = {react: {react: '^19.0.0', 'react-dom': '^19.0.0'}, vue: {vue: '^3.5.0'}};
const PLAIN = `<react lang="tsx">
  export default function Plain() {
    return <p>plain</p>
  }
</react>
`;

let library: BuiltLibrary;
let tarballs: Awaited<ReturnType<typeof packLibrary>>;

beforeAll(async () => {
  library = await buildFixtureLibrary();
  tarballs = await packLibrary(library.outDir);
});

afterAll(async () => {
  await library?.remove();
});

function packageJsonOf(outDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8')) as Record<string, unknown>;
}

function typedEntry(name: string) {
  return {types: `./${name}.d.ts`, default: `./${name}.js`};
}

describe('packLibrary', () => {
  it('packs one tarball per built framework', () => {
    expect(Object.keys(tarballs).sort()).toEqual(['react', 'svelte', 'vue']);
  });

  it.each(TARGETS)('%s: the tarball holds every written file, and no .front or node_modules', async (target) => {
    const files = await tarFiles(tarballs[target]!);
    expect(files).toEqual(resultOf(library.results, target).files.map((file) => `package/${file}`));
    const expected = ['Card.js', 'Card.d.ts', 'Card.css', 'styles.css', 'index.js', 'index.d.ts', 'package.json'];
    for (const file of [...expected, 'README.md', 'LICENSE']) expect(files).toContain(`package/${file}`);
    expect(files.filter((file) => file.includes('.front') || file.includes('node_modules'))).toEqual([]);
  });

  it.each(TARGETS)('%s: the tarball passes publint, warnings included', async (target) => {
    const {code, output} = await publint(tarballs[target]!);
    expect(code, output).toBe(0);
    expect(output).toContain('All good!');
  });

  it.each(TARGETS)('%s: the tarball passes attw for ESM consumers', async (target) => {
    const {code, output} = await attw(tarballs[target]!);
    expect(code, output).toBe(0);
  });
});

describe('package.json', () => {
  it.each(TARGETS)('%s: library metadata, an exports map per component and the peers only', (target) => {
    const exports = {
      '.': typedEntry('index'),
      ...Object.fromEntries(COMPONENTS[target].map((name) => [`./${name}`, typedEntry(name)])),
      './styles.css': './styles.css',
      './*.css': './*.css',
      './package.json': './package.json',
    };
    const expected = {
      name: `@mf-fixture/ui-${target}`,
      version: '1.2.3',
      description: FIXTURE.description,
      license: 'MIT',
      author: 'multifront fixtures',
      repository: FIXTURE.repository,
      homepage: FIXTURE.homepage,
      keywords: ['multifront', 'fixture'],
      type: 'module',
      sideEffects: ['*.css'],
      types: './index.d.ts',
      exports,
      peerDependencies: PEERS[target],
    };
    const packageJson = packageJsonOf(resultOf(library.results, target).outDir);
    expect(packageJson).toEqual(expected);
    expect(Object.keys(packageJson)).toEqual(Object.keys(expected));
    expect(Object.keys(packageJson.exports as object)).toEqual(Object.keys(exports));
  });

  it('takes the name and peers from packages, drops every other field and copies no missing doc', async () => {
    const manifest = {
      ...FIXTURE,
      description: null,
      main: './index.js',
      files: ['src'],
      exports: './src/index.ts',
      scripts: {build: 'vite build'},
      dependencies: {'left-pad': '1.3.0'},
      devDependencies: {'@multifront/vite': 'workspace:*'},
    };
    await withEditedLibrary([{file: 'package.json', content: JSON.stringify(manifest)}], async (root) => {
      await rm(join(root, 'README.md'));
      await rm(join(root, 'LICENSE'));
      const built = await buildFixtureLibrary(root, {
        frameworks: ['react'],
        dts: false,
        packages: {react: {name: '@acme/ui-react', peers: {react: '^19.1.0'}}},
      });
      try {
        const react = resultOf(built.results, 'react');
        const packageJson = packageJsonOf(react.outDir);
        expect(packageJson.name).toBe('@acme/ui-react');
        expect(packageJson.peerDependencies).toEqual({react: '^19.1.0', 'react-dom': '^19.0.0'});
        for (const field of ['description', 'main', 'files', 'scripts', 'dependencies', 'devDependencies', 'types']) {
          expect(packageJson).not.toHaveProperty(field);
        }
        const exports = packageJson.exports as Record<string, unknown>;
        expect(exports['.']).toEqual({default: './index.js'});
        expect(exports['./Card']).toEqual({default: './Card.js'});
        expect(react.files).toContain('package.json');
        expect(react.files).not.toContain('README.md');
        expect(react.files).not.toContain('LICENSE');
      } finally {
        await built.remove();
      }
    });
  });

  it('writes a manifest for a library with no package.json of its own', async () => {
    await withEditedLibrary([], async (root) => {
      await rm(join(root, 'package.json'));
      const built = await buildFixtureLibrary(root, {frameworks: ['react'], packages: {react: {name: '@acme/ui-react'}}});
      try {
        const packageJson = packageJsonOf(resultOf(built.results, 'react').outDir);
        expect(Object.keys(packageJson)).toEqual(['name', 'type', 'sideEffects', 'types', 'exports', 'peerDependencies']);
        expect(packageJson.name).toBe('@acme/ui-react');
      } finally {
        await built.remove();
      }
    });
  });

  it('exports only what exists: no index, no types, and the empty styles.css', async () => {
    await withEditedLibrary([{file: 'plain/Plain.front', content: PLAIN}], async (root) => {
      const built = await buildFixtureLibrary(root, {src: 'plain', frameworks: ['react'], dts: false});
      try {
        const packageJson = packageJsonOf(resultOf(built.results, 'react').outDir);
        expect(packageJson).not.toHaveProperty('types');
        expect(packageJson.exports).toEqual({
          './Plain': {default: './Plain.js'},
          './styles.css': './styles.css',
          './*.css': './*.css',
          './package.json': './package.json',
        });
        const tarball = (await packLibrary(built.outDir)).react!;
        const linted = await publint(tarball);
        expect(linted.code, linted.output).toBe(0);
        const checked = await attw(tarball);
        expect(checked.code, checked.output).toBe(0);
      } finally {
        await built.remove();
      }
    });
  });
});

const DEVX = join(REPO_ROOT, 'scripts', 'devx.mjs');

describe('pnpm devx consumer-pack', () => {
  it('packs every framework once into a folder that fixtureTarballs() reads back', async () => {
    await mkdir(TMP_DIR, {recursive: true});
    const dir = await mkdtemp(join(TMP_DIR, 'consumer-pack-'));
    try {
      await promisify(execFile)(process.execPath, [DEVX, 'consumer-pack', dir]);
      const names = JSON.parse(readFileSync(join(dir, 'tarballs.json'), 'utf8')) as Record<string, string>;
      expect(names).toEqual({
        vue: 'mf-fixture-ui-vue-1.2.3.tgz',
        react: 'mf-fixture-ui-react-1.2.3.tgz',
        svelte: 'mf-fixture-ui-svelte-1.2.3.tgz',
      });
      const {tarballs} = await fixtureTarballs(dir);
      expect(tarballs).toEqual(Object.fromEntries(Object.entries(names).map(([target, name]) => [target, join(dir, name)])));
      for (const tarball of Object.values(tarballs)) expect(existsSync(tarball!)).toBe(true);
    } finally {
      await removeLibrary(dir);
    }
  });

  it('refuses to run without a folder', async () => {
    const failed = await promisify(execFile)(process.execPath, [DEVX, 'consumer-pack']).then(
      () => ({code: 0, stderr: ''}),
      (err: {code: number; stderr: string}) => err
    );
    expect(failed.code).toBe(1);
    expect(failed.stderr.trim()).toBe('devx: consumer-pack needs a folder to write the tarballs to');
  });

  it('names the command to run when the folder has no tarballs.json', async () => {
    await expect(fixtureTarballs(LIBRARY_DIR)).rejects.toThrow(`run pnpm devx consumer-pack ${LIBRARY_DIR}`);
  });
});
