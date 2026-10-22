// The demo imports Counter.front as React and as Vue: each target's modules hold only its own framework.
import {join} from 'node:path';
import type {Plugin} from 'vite';
import {beforeAll, describe, expect, it} from 'vitest';
import {FIXTURES_DIR, componentPath} from '../fixtures/index.ts';
import {buildApp} from './lib/build.ts';
import {expectNoAttribute} from './lib/references.ts';

const ROOT = join(FIXTURES_DIR, 'apps', 'demo');
const COUNTER = componentPath('Counter.front');
const REACT_ID = `${COUNTER}.react.tsx`;
const VUE_HELPERS = /openBlock|createElementBlock|createElementVNode/;

let output: Awaited<ReturnType<typeof buildApp>>;
const imports = new Map<string, readonly string[]>();
const withFramework: string[] = [];

// Leaves out our `?front&` style modules: they belong to no framework.
const isVueModule = (id: string) => id === COUNTER || id.startsWith(`${COUNTER}?vue&`);

beforeAll(async () => {
  const spy: Plugin = {
    name: 'counter-imports',
    generateBundle() {
      for (const id of this.getModuleIds()) {
        if (id.startsWith(COUNTER)) imports.set(id, this.getModuleInfo(id)!.importedIds);
        if (id.includes('framework=')) withFramework.push(id);
      }
    },
  };
  output = await buildApp(ROOT, {plugins: [spy]});
});

function renderedCode(matches: (id: string) => boolean): string[] {
  return output.chunks.flatMap((chunk) =>
    Object.entries(chunk.modules).flatMap(([id, module]) => (matches(id) ? [module.code ?? ''] : []))
  );
}

function importedPackages(matches: (id: string) => boolean): string[] {
  return [...imports]
    .filter(([id]) => matches(id))
    .flatMap(([, ids]) => ids.flatMap((id) => /.*node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(id)?.[1] ?? []));
}

describe('vite build of the demo, Counter.front as React and as Vue', () => {
  it('keeps Vue out of the React module', () => {
    expect(imports.has(REACT_ID)).toBe(true);
    expect(importedPackages((id) => id === REACT_ID).sort()).toEqual(['react', 'react']);
    expect(imports.get(REACT_ID)!.some((id) => id.includes('react/jsx-runtime'))).toBe(true);
    const [code] = renderedCode((id) => id === REACT_ID);
    expect(code).toContain('jsx');
    expect(code).not.toMatch(VUE_HELPERS);
  });

  it('keeps the JSX runtime out of the Vue modules', () => {
    expect(imports.has(COUNTER)).toBe(true);
    expect(new Set(importedPackages(isVueModule))).toEqual(new Set(['vue']));
    const code = renderedCode(isVueModule).join('\n');
    expect(code).toContain('createElementBlock');
    expect(code).not.toContain('jsx');
  });

  it('leaves no framework attribute, in the code or in a module id', () => {
    expect(withFramework).toEqual([]);
    for (const chunk of output.chunks) expectNoAttribute(chunk.code);
  });
});
