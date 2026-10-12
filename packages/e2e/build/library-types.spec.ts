import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {LIBRARY_DIR, copyLibraryOutside, removeLibrary} from '../fixtures/index.ts';
import {
  buildFixtureLibrary,
  buildInFreshNode,
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
const FIELD = readFileSync(join(LIBRARY_DIR, 'src', 'forms', 'Field.ucf'), 'utf8');
// Only in Card's `<react>` block, and only in its `<vue>` block.
const REACT_RETURN = '    return (\n';
const REACT_IMPORTS = "  import type { ReactNode } from 'react'\n  import Icon from './Icon.ucf'\n";
const VUE_PROPS = '  defineProps<{ title: string }>()\n';
const OPTIONAL_PEERS = ['typescript', '@multifront/language-tools', 'vue-tsc'];

let library: BuiltLibrary;
let checks: string;

beforeAll(async () => {
  library = await buildFixtureLibrary();
  checks = await copyLibraryChecks(library.outDir);
});

afterAll(async () => {
  await library?.remove();
});

function edited(source: string, from: string, to: string): string {
  if (!source.includes(from)) throw new Error(`the fixture has no ${JSON.stringify(from)}`);
  return source.replace(from, to);
}

// The stage folder is deleted whether the build passed or not.
function stagesLeft(root: string): string[] {
  const cache = join(root, 'node_modules', '.cache', 'multifront');
  return existsSync(cache) ? readdirSync(cache) : [];
}

async function withBuilt(root: string, framework: 'react' | 'vue', check: (built: BuiltLibrary) => Promise<void>): Promise<void> {
  const built = await buildFixtureLibrary(root, {frameworks: [framework]});
  try {
    await check(built);
  } finally {
    await built.remove();
  }
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
    const card = edited(CARD, REACT_RETURN, `    const count: number = 'x'\n${REACT_RETURN}`);
    await withEditedLibrary([{file: 'src/Card.ucf', content: card}], async (root) => {
      const build = buildFixtureLibrary(root, {frameworks: ['react']});
      await expect(build).rejects.toThrow('buildLibrary: the react types do not compile:\nsrc/Card.ucf: error TS2322');
      await expect(build).rejects.not.toThrow('.cache');
      await expect(build).rejects.not.toThrow('Card.tsx');
      expect(stagesLeft(root)).toEqual([]);
    });
  });

  it('fails the build on a type error in a <vue> block, naming the .ucf file', async () => {
    const card = edited(CARD, VUE_PROPS, `${VUE_PROPS}  const count: number = 'x'\n`);
    await withEditedLibrary([{file: 'src/Card.ucf', content: card}], async (root) => {
      const build = buildFixtureLibrary(root, {frameworks: ['vue']});
      await expect(build).rejects.toThrow('buildLibrary: the vue types do not compile:\nsrc/Card.ucf: error TS2322');
      await expect(build).rejects.not.toThrow('.cache');
      await expect(build).rejects.not.toThrow('Card.vue');
      expect(stagesLeft(root)).toEqual([]);
    });
  });

  it('keeps the position of an error in a plain module', async () => {
    const cx = readFileSync(join(LIBRARY_DIR, 'src', 'utils', 'cx.ts'), 'utf8');
    await withEditedLibrary([{file: 'src/utils/cx.ts', content: `${cx}export const broken: number = 'x';\n`}], async (root) => {
      const build = buildFixtureLibrary(root, {frameworks: ['react']});
      const line = cx.split('\n').length;
      await expect(build).rejects.toThrow(`src/utils/cx.ts(${line},14): error TS2322`);
      await expect(build).rejects.not.toThrow('.cache');
    });
  });

  it('writes the .d.ts of a module only imported for its types', async () => {
    const card = edited(CARD, REACT_IMPORTS, `${REACT_IMPORTS}  import type { CardTone } from './types.js'\n`).replace(
      '{ title: string; children?: ReactNode }',
      '{ title: string; children?: ReactNode; tone?: CardTone }'
    );
    const types = "export type CardTone = 'info' | 'warn';\n";
    const edits = [
      {file: 'src/Card.ucf', content: card},
      {file: 'src/types.ts', content: types},
    ];
    await withEditedLibrary(edits, async (root) => {
      await withBuilt(root, 'react', async (built) => {
        const result = resultOf(built.results, 'react');
        expect(result.files).toContain('types.d.ts');
        expect(result.files).not.toContain('types.js');
        expect(typeSpecifiersOf('Card.d.ts', readOutput(result, 'Card.d.ts'))).toContain('./types.js');
        expect(await typeCheck('tsc', await copyLibraryChecks(built.outDir), 'tsconfig.react.json')).toBe('');
      });
      expect(stagesLeft(root)).toEqual([]);
    });
  });

  it('names a syntax error the JS build never saw, in a module only imported for its types', async () => {
    const card = edited(CARD, REACT_IMPORTS, `${REACT_IMPORTS}  import type { CardTone } from './types.js'\n`);
    const edits = [
      {file: 'src/Card.ucf', content: card},
      {file: 'src/types.ts', content: 'export type CardTone = ;\n'},
    ];
    await withEditedLibrary(edits, async (root) => {
      const build = buildFixtureLibrary(root, {frameworks: ['react']});
      await expect(build).rejects.toThrow('buildLibrary: the react types do not compile:\nsrc/types.ts(1,24): error TS1110');
      await expect(build).rejects.not.toThrow('.cache');
      await expect(build).rejects.not.toThrow('node_modules');
      expect(stagesLeft(root)).toEqual([]);
    });
  });

  it('writes the .d.ts of a plain JavaScript module', async () => {
    const card = edited(CARD, REACT_IMPORTS, `${REACT_IMPORTS}  import { upper } from './utils/upper.js'\n`).replace(
      '<Icon /> {title}',
      '<Icon /> {upper(title)}'
    );
    const upper = 'export function upper(text) {\n  return text.toUpperCase();\n}\n';
    const edits = [
      {file: 'src/Card.ucf', content: card},
      {file: 'src/utils/upper.js', content: upper},
    ];
    await withEditedLibrary(edits, async (root) => {
      await withBuilt(root, 'react', async (built) => {
        const {files} = resultOf(built.results, 'react');
        expect(files).toContain('utils/upper.js');
        expect(files).toContain('utils/upper.d.ts');
      });
    });
  });

  it('rewrites an escaped .ucf specifier by its value', async () => {
    const card = edited(CARD, REACT_IMPORTS, REACT_IMPORTS.replace("'./Icon.ucf'", "'./Ic\\u006fn.ucf'"));
    await withEditedLibrary([{file: 'src/Card.ucf', content: card}], async (root) => {
      await withBuilt(root, 'react', async (built) => {
        expect(resultOf(built.results, 'react').files).toContain('Card.d.ts');
      });
    });
  });

  it('points a nested Vue declaration at the component it types by ../Name.js', async () => {
    const vueProps = '  defineProps<{ label: string }>()\n';
    const field = edited(
      FIELD,
      vueProps,
      "  import Icon from '../Icon.ucf'\n\n  defineProps<{ label: string; icon?: typeof Icon }>()\n"
    );
    await withEditedLibrary([{file: 'src/forms/Field.ucf', content: field}], async (root) => {
      await withBuilt(root, 'vue', async (built) => {
        const specifiers = typeSpecifiersOf('Field.d.ts', readOutput(resultOf(built.results, 'vue'), 'forms/Field.d.ts'));
        expect(specifiers).toContain('../Icon.js');
        expect(specifiers.filter((specifier) => specifier.endsWith('.vue'))).toEqual([]);
      });
    });
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
      await withBuilt(root, 'react', async (built) => {
        const {files} = resultOf(built.results, 'react');
        expect(files).toContain('Card.d.ts');
        expect(files.filter((file) => file.endsWith('.d.ts.map'))).toEqual([]);
      });
    });
    const card = edited(CARD, REACT_RETURN, `    const unused = 1\n${REACT_RETURN}`);
    const edits = [
      {file: 'tsconfig.json', content: tsconfig},
      {file: 'src/Card.ucf', content: card},
    ];
    await withEditedLibrary(edits, async (root) => {
      await expect(buildFixtureLibrary(root, {frameworks: ['react']})).rejects.toThrow('src/Card.ucf: error TS6133');
    });
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

describe('buildLibrary(): the type tools come from the library', () => {
  it.each([
    ['typescript', 'react'],
    ['@multifront/language-tools', 'react'],
    ['vue-tsc', 'vue'],
  ] as const)('names %s when the library has not installed it', async (peer, framework) => {
    const root = await copyLibraryOutside([peer]);
    try {
      const message = await buildInFreshNode(root, {frameworks: [framework], vite: {logLevel: 'silent'}});
      expect(message).toBe(`buildLibrary: the ${framework} types need ${peer}; install it, or set dts: false`);
      expect(stagesLeft(root)).toEqual([]);
    } finally {
      await removeLibrary(root);
    }
  });

  it('builds both packages with dts: false and none of them installed, and with all of them', async () => {
    const without = await copyLibraryOutside(OPTIONAL_PEERS);
    const all = await copyLibraryOutside([]);
    try {
      expect(await buildInFreshNode(without, {dts: false, vite: {logLevel: 'silent'}})).toBe('');
      expect(await buildInFreshNode(all, {vite: {logLevel: 'silent'}})).toBe('');
    } finally {
      await removeLibrary(without);
      await removeLibrary(all);
    }
  });
});
