import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {scopeId} from '@multifront/core';
import type {LibraryResult} from '@multifront/vite';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {LIBRARY_DIR} from '../fixtures/index.ts';
import {buildFixtureLibrary, specifiersOf, withEditedLibrary} from './lib/library.ts';
import type {BuiltLibrary} from './lib/library.ts';

type Framework = 'react' | 'vue';

// Every styled component, dependencies first: Icon before Card (Card renders it), Counter before Panel.
const CSS_ORDER: Record<Framework, string[]> = {
  react: ['Badge', 'Button', 'Icon', 'Card', 'Counter', 'Panel', 'Tooltip', 'forms/Field'],
  vue: ['Badge', 'Button', 'Icon', 'Card', 'Counter', 'Panel', 'Tooltip', 'VueOnly', 'forms/Field'],
};
const FRAMEWORKS = ['react', 'vue'] as const;

let library: BuiltLibrary;

beforeAll(async () => {
  library = await buildFixtureLibrary();
});

afterAll(async () => {
  await library?.remove();
});

function resultOf(results: LibraryResult[], target: Framework): LibraryResult {
  const result = results.find((entry) => entry.target === target);
  if (!result) throw new Error(`no ${target} build`);
  return result;
}

function read(result: LibraryResult, file: string): string {
  return readFileSync(join(result.outDir, file), 'utf8');
}

function cssImports(result: LibraryResult, file: string): string[] {
  return specifiersOf(file, read(result, file)).filter((specifier) => specifier.endsWith('.css'));
}

describe('buildLibrary(): CSS as real files', () => {
  it('writes one CSS file per component with styles, plus styles.css', () => {
    for (const target of FRAMEWORKS) {
      const css = resultOf(library.results, target).files.filter((file) => file.endsWith('.css'));
      expect(css, target).toEqual([...CSS_ORDER[target].map((name) => `${name}.css`), 'styles.css'].sort());
    }
  });

  it("starts each component's JS with an import of its own CSS file", () => {
    for (const target of FRAMEWORKS) {
      const result = resultOf(library.results, target);
      for (const name of CSS_ORDER[target]) {
        const file = `${name}.js`;
        expect(read(result, file).startsWith(`import "./${name.split('/').pop()}.css";\n`), `${target}/${file}`).toBe(true);
        expect(cssImports(result, file), `${target}/${file}`).toEqual([`./${name.split('/').pop()}.css`]);
      }
    }
  });

  it('imports no CSS from plain modules, the index, the virtual modules or a component without styles', async () => {
    for (const target of FRAMEWORKS) {
      const result = resultOf(library.results, target);
      const components = new Set(CSS_ORDER[target].map((name) => `${name}.js`));
      const others = result.files.filter((file) => file.endsWith('.js') && !components.has(file));
      expect(others).toContain('index.js');
      expect(others).toContain('utils/cx.js');
      for (const file of others) expect(cssImports(result, file), `${target}/${file}`).toEqual([]);
    }
    const plain =
      '<vue>\n  <template><p>plain</p></template>\n</vue>\n\n<react>\n  export default () => <p>plain</p>\n</react>\n';
    await withEditedLibrary([{file: 'src/Plain.ucf', content: plain}], async (root) => {
      const built = await buildFixtureLibrary(root);
      try {
        for (const target of FRAMEWORKS) {
          const result = resultOf(built.results, target);
          expect(result.files).toContain('Plain.js');
          expect(result.files).not.toContain('Plain.css');
          expect(cssImports(result, 'Plain.js')).toEqual([]);
        }
      } finally {
        await built.remove();
      }
    });
  });

  it("holds the component's compiled CSS, scoped with core's scope id, module rules first", () => {
    const attribute = `[data-v-${scopeId('src/Card.ucf', readFileSync(join(LIBRARY_DIR, 'src', 'Card.ucf'), 'utf8'), true)}]`;
    for (const target of FRAMEWORKS) {
      const css = read(resultOf(library.results, target), 'Card.css');
      expect(css, target).toContain(`.card${attribute}:hover {`);
      expect(css, target).not.toContain('&');
      expect(css.indexOf('--card-padding: 16px'), target).toBeGreaterThan(-1);
      expect(css.indexOf('--card-padding: 16px'), target).toBeLessThan(css.indexOf(attribute));
    }
  });

  it('joins every component CSS file in styles.css, dependencies first, the same on every build', async () => {
    const again = await buildFixtureLibrary();
    try {
      for (const target of FRAMEWORKS) {
        const result = resultOf(library.results, target);
        const joined = CSS_ORDER[target].map((name) => read(result, `${name}.css`)).join('');
        expect(read(result, 'styles.css'), target).toBe(joined);
        const second = resultOf(again.results, target);
        for (const file of result.files.filter((name) => name.endsWith('.css'))) {
          expect(read(second, file), `${target}/${file}`).toBe(read(result, file));
        }
      }
    } finally {
      await again.remove();
    }
  });

  it('injects no CSS at runtime', () => {
    for (const target of FRAMEWORKS) {
      const result = resultOf(library.results, target);
      for (const file of result.files.filter((name) => name.endsWith('.js'))) {
        const code = read(result, file);
        for (const injection of ["createElement('style')", 'createElement("style")', '__vite_style__', '__vite__updateStyle']) {
          expect(code, `${target}/${file}`).not.toContain(injection);
        }
      }
    }
  });
});

describe('buildLibrary() CSS errors', () => {
  it('fails on a component that would be written as styles.css', async () => {
    const icon = readFileSync(join(LIBRARY_DIR, 'src', 'Icon.ucf'), 'utf8');
    await withEditedLibrary([{file: 'src/styles.ucf', content: icon}], async (root) => {
      await expect(buildFixtureLibrary(root)).rejects.toThrow(
        'src/styles.ucf would be written as styles.css, the name of the combined CSS file'
      );
    });
  });

  it('fails on a plain CSS file imported from code', async () => {
    const cx = readFileSync(join(LIBRARY_DIR, 'src', 'utils', 'cx.ts'), 'utf8');
    const edits = [
      {file: 'src/utils/cx.css', content: '.cx {\n  color: red;\n}\n'},
      {file: 'src/utils/cx.ts', content: `import './cx.css';\n\n${cx}`},
    ];
    await withEditedLibrary(edits, async (root) => {
      await expect(buildFixtureLibrary(root)).rejects.toThrow(
        'src/utils/cx.css is imported by src/utils/cx.ts: a library package ships CSS from .ucf <style> blocks only'
      );
    });
  });
});
