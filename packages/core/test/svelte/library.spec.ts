import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {DiagnosticsError, buildTarget, createBuildContext, loadVueCompiler, splitBlocks} from '@multifront/core';
import type {LibraryMode, VirtualFile} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {FIXTURES_DIR, componentPath, listComponents} from '../../../e2e/fixtures/index.ts';
import {svelte} from './render.ts';

const compiler = loadVueCompiler(import.meta.dirname);
const LIBRARY_SRC = join(FIXTURES_DIR, 'library', 'src');
const COMPONENTS: LibraryMode = {src: componentPath('')};
// Every `<svelte>` shape, plus the library fixture's components, built as the library build builds them.
const FIXTURES = [
  ...['svelte/shapes', 'svelte/roots', 'svelte/imports', 'svelte/library'].flatMap((folder) =>
    listComponents(folder).map((name) => ({filename: componentPath(name), library: COMPONENTS}))
  ),
  ...['Card.ucf', 'Panel.ucf', 'Icon.ucf', 'forms/Field.ucf'].map((name) => ({
    filename: join(LIBRARY_SRC, name),
    library: {src: LIBRARY_SRC},
  })),
];

async function built(filename: string, library?: LibraryMode) {
  const split = splitBlocks(readFileSync(filename, 'utf8'), filename);
  const ctx = await createBuildContext(split, {root: FIXTURES_DIR, compiler, production: true, library});
  try {
    return {ctx, file: buildTarget(split, ctx, 'svelte') as VirtualFile | undefined, thrown: undefined};
  } catch (err) {
    if (!(err instanceof DiagnosticsError)) throw err;
    return {ctx, file: undefined, thrown: err.diagnostics};
  }
}

function compiled(code: string): string[] {
  try {
    return svelte.compile(code, {generate: 'client'}).warnings.map(({code: warning}) => warning);
  } catch (err) {
    return [`error: ${(err as {code?: string}).code}`];
  }
}

// The string-literal specifiers of the scripts and markup, `import()` included.
function specifiers(code: string): string[] {
  const root = svelte.parse(code, {modern: true});
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    const node = value as {type?: unknown; source?: {type?: string; value?: unknown}};
    if (node.type !== 'Literal' && node.source?.type === 'Literal' && typeof node.source.value === 'string')
      found.push(node.source.value);
    for (const child of Object.values(node)) visit(child);
  };
  visit([root.module, root.instance, root.fragment]);
  return found;
}

describe.each(FIXTURES)('library mode: $filename', ({filename, library}) => {
  it('builds where the app build does, and compiles with the same Svelte warnings', async () => {
    const app = await built(filename);
    const shipped = await built(filename, library);
    expect(shipped.thrown).toEqual(app.thrown);
    if (!app.file) return;
    expect(compiled(shipped.file!.code)).toEqual(compiled(app.file.code));
  });

  it('imports real files beside it: its CSS, the shipped helper, `.svelte` for each `.ucf`; class maps inlined', async () => {
    const {ctx, file} = await built(filename, library);
    if (!file) return;
    expect(file.code).not.toMatch(/\?ucf|virtual:/);
    const found = specifiers(file.code);
    expect(found.filter((specifier) => specifier.endsWith('.ucf'))).toEqual([]);
    const css = `./${filename
      .split('/')
      .pop()!
      .replace(/\.ucf$/, '.css')}`;
    expect(found.includes(css)).toBe(ctx.styles.length > 0);
    const depth = filename.slice(library.src.length + 1).split('/').length - 1;
    const helper = `${depth === 0 ? './' : '../'.repeat(depth)}_ucf/scopeAttrs.js`;
    expect(found.filter((specifier) => specifier.endsWith('scopeAttrs.js'))).toEqual(
      file.code.includes('__ucfScopeAttrs(') ? [helper] : []
    );
    // One inlined map per class map the app build imports.
    const inlined = [...file.code.matchAll(/^const __ucf\w+ = (\{.*\});$/gm)].map(([, json]) => JSON.parse(json!) as unknown);
    const imported = (await built(filename)).file!.code.match(/^import __ucf\w+ from "[^"]*&module&lang\.js";$/gm) ?? [];
    expect(inlined).toHaveLength(imported.length);
    for (const classes of inlined) expect(Object.values(ctx.modules).map((module) => module.classes)).toContainEqual(classes);
  });
});

describe('library mode: .ucf imports', () => {
  it('ships static and dynamic imports, in the script and the markup, as .svelte', async () => {
    const {file} = await built(componentPath('svelte/library/DynamicImport.ucf'), COMPONENTS);
    expect(specifiers(file!.code)).toEqual(['../../imports/Icon.svelte', '../../imports/UsesIcon.svelte']);
    const card = await built(join(LIBRARY_SRC, 'Card.ucf'), {src: LIBRARY_SRC});
    expect(specifiers(card.file!.code)).toEqual(
      expect.arrayContaining(['./Card.css', './_ucf/scopeAttrs.js', './Icon.svelte', './utils/cx.js'])
    );
  });
});
