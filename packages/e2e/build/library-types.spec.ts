import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {LIBRARY_DIR} from '../fixtures/index.ts';
import {
  buildFixtureLibrary,
  copyLibraryChecks,
  readOutput,
  resultOf,
  typeCheck,
  typeSpecifiersOf,
  withEditedLibrary,
} from './lib/library.ts';
import type {BuiltLibrary} from './lib/library.ts';

const TARGETS = ['react', 'vue'] as const;
const CARD = readFileSync(join(LIBRARY_DIR, 'src', 'Card.ucf'), 'utf8');
// Only in Card's `<react>` block, and only in its `<vue>` block.
const REACT_RETURN = '    return (\n';
const VUE_PROPS = '  defineProps<{ title: string }>()\n';

let library: BuiltLibrary;
let checks: string;

beforeAll(async () => {
  library = await buildFixtureLibrary();
  checks = await copyLibraryChecks(library.outDir);
});

afterAll(async () => {
  await library?.remove();
});

function edited(from: string, to: string): string {
  if (!CARD.includes(from)) throw new Error(`Card.ucf has no ${JSON.stringify(from)}`);
  return CARD.replace(from, to);
}

// The stage folder is deleted whether the build passed or not.
function stagesLeft(root: string): string[] {
  const cache = join(root, 'node_modules', '.cache', 'multifront');
  return existsSync(cache) ? readdirSync(cache) : [];
}

async function buildError(root: string, framework: 'react' | 'vue'): Promise<string> {
  const failed = await buildFixtureLibrary(root, {frameworks: [framework]}).then(
    async (built) => {
      await built.remove();
      return undefined;
    },
    (err: Error) => err.message
  );
  if (failed === undefined) throw new Error(`the ${framework} build passed`);
  return failed;
}

describe('buildLibrary(): .d.ts per target', () => {
  it('writes a .d.ts beside every JS file outside _virtual/, and no other', () => {
    for (const target of TARGETS) {
      const {files} = resultOf(library.results, target);
      const js = files.filter((file) => file.endsWith('.js') && !file.startsWith('_virtual/'));
      const declarations = files.filter((file) => file.endsWith('.d.ts'));
      expect(js.length, target).toBeGreaterThan(0);
      expect(declarations, target).toEqual(js.map((file) => file.replace(/\.js$/, '.d.ts')));
    }
  });

  it('leaves no .ucf, .tsx or .vue specifier in a .d.ts', () => {
    for (const target of TARGETS) {
      const result = resultOf(library.results, target);
      for (const file of result.files.filter((name) => name.endsWith('.d.ts'))) {
        const specifiers = typeSpecifiersOf(file, readOutput(result, file));
        for (const specifier of specifiers) expect(specifier, `${target}/${file}`).not.toMatch(/\.(ucf|tsx|vue)$/);
      }
    }
    expect(typeSpecifiersOf('index.d.ts', readOutput(resultOf(library.results, 'vue'), 'index.d.ts'))).toContain('./Card.js');
  });

  it('types the React package for real tsc: right props pass, a wrong prop and a <div> ref on Button fail', async () => {
    expect(await typeCheck('tsc', checks, 'tsconfig.react.json')).toBe('');
  });

  it('types the Vue package for real vue-tsc: right props and events pass, a wrong prop and payload fail', async () => {
    expect(await typeCheck('vue-tsc', checks, 'tsconfig.vue.json')).toBe('');
  });

  it('fails the build on a type error in a <react> block, naming the .ucf file', async () => {
    const card = edited(REACT_RETURN, `    const count: number = 'x'\n${REACT_RETURN}`);
    await withEditedLibrary([{file: 'src/Card.ucf', content: card}], async (root) => {
      const message = await buildError(root, 'react');
      expect(message).toContain('buildLibrary: the react types do not compile');
      expect(message).toContain('src/Card.ucf: error TS2322');
      expect(message).not.toContain('.cache');
      expect(message).not.toContain('Card.tsx');
      expect(stagesLeft(root)).toEqual([]);
    });
  });

  it('fails the build on a type error in a <vue> block, naming the .ucf file', async () => {
    const card = edited(VUE_PROPS, `${VUE_PROPS}  const count: number = 'x'\n`);
    await withEditedLibrary([{file: 'src/Card.ucf', content: card}], async (root) => {
      const message = await buildError(root, 'vue');
      expect(message).toContain('buildLibrary: the vue types do not compile');
      expect(message).toContain('src/Card.ucf: error TS2322');
      expect(message).not.toContain('.cache');
      expect(message).not.toContain('Card.vue');
      expect(stagesLeft(root)).toEqual([]);
    });
  });

  it('writes the .d.ts of a module only imported for its types', async () => {
    const card = edited(
      "  import type { ReactNode } from 'react'\n",
      "  import type { ReactNode } from 'react'\n  import type { CardTone } from './types.js'\n"
    ).replace('{ title: string; children?: ReactNode }', '{ title: string; children?: ReactNode; tone?: CardTone }');
    const types = "export type CardTone = 'info' | 'warn';\n";
    await withEditedLibrary(
      [
        {file: 'src/Card.ucf', content: card},
        {file: 'src/types.ts', content: types},
      ],
      async (root) => {
        const built = await buildFixtureLibrary(root, {frameworks: ['react']});
        try {
          const {files} = resultOf(built.results, 'react');
          expect(files).toContain('types.d.ts');
          expect(files).not.toContain('types.js');
          expect(typeSpecifiersOf('Card.d.ts', readOutput(resultOf(built.results, 'react'), 'Card.d.ts'))).toContain(
            './types.js'
          );
          const builtChecks = await copyLibraryChecks(built.outDir);
          expect(await typeCheck('tsc', builtChecks, 'tsconfig.react.json')).toBe('');
          expect(stagesLeft(root)).toEqual([]);
        } finally {
          await built.remove();
        }
      }
    );
  });

  it("extends the library's tsconfig.json, with the emit options forced", async () => {
    const tsconfig = JSON.stringify({
      compilerOptions: {
        module: 'esnext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
        declarationMap: true,
        noUnusedLocals: true,
      },
    });
    await withEditedLibrary([{file: 'tsconfig.json', content: tsconfig}], async (root) => {
      const built = await buildFixtureLibrary(root, {frameworks: ['react']});
      try {
        const {files} = resultOf(built.results, 'react');
        expect(files).toContain('Card.d.ts');
        expect(files.filter((file) => file.endsWith('.d.ts.map'))).toEqual([]);
      } finally {
        await built.remove();
      }
    });
    const card = edited(REACT_RETURN, `    const unused = 1\n${REACT_RETURN}`);
    await withEditedLibrary(
      [
        {file: 'tsconfig.json', content: tsconfig},
        {file: 'src/Card.ucf', content: card},
      ],
      async (root) => {
        expect(await buildError(root, 'react')).toContain('src/Card.ucf: error TS6133');
      }
    );
  });

  it('writes no .d.ts with dts: false', async () => {
    const built = await buildFixtureLibrary(LIBRARY_DIR, {frameworks: ['react'], dts: false});
    try {
      const {files} = resultOf(built.results, 'react');
      expect(files).toContain('Card.js');
      expect(files.filter((file) => file.endsWith('.d.ts'))).toEqual([]);
    } finally {
      await built.remove();
    }
  });
});
