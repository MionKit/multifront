// Builds `<svelte>` fixtures and renders them on the server, for the svelte kind's tests.
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {basename, dirname, join, relative, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Parser} from 'htmlparser2';
import MagicString from 'magic-string';
import {parseSync} from 'oxc-parser';
import type * as SvelteCompilerModule from 'svelte/compiler';
import type {Component} from 'svelte';
import {render} from 'svelte/server';
import {expect} from 'vitest';
import {
  DiagnosticsError,
  SCOPE_HELPER_ID,
  buildTarget,
  createBuildContext,
  loadVueCompiler,
  scopeHelperCode,
  splitBlocks,
} from '@multifront/core';
import type {BuildContext, LibraryMode, VirtualFile} from '@multifront/core';
// A relative path, not a package dependency: @multifront/e2e depends on core.
import {FIXTURES_DIR, TMP_DIR, componentPath, readComponent} from '../../../e2e/fixtures/index.ts';

const compiler = loadVueCompiler(import.meta.dirname);
export const svelte = createRequire(import.meta.url)('svelte/compiler') as typeof SvelteCompilerModule;
const REPO_ROOT = join(FIXTURES_DIR, '..', '..', '..');

export async function svelteBuild(name: string, production = false, library?: LibraryMode) {
  const {filename, source} = readComponent(name);
  const split = splitBlocks(source, filename);
  const ctx = await createBuildContext(split, {root: FIXTURES_DIR, compiler, production, library});
  try {
    return {split, source, ctx, file: buildTarget(split, ctx, 'svelte'), thrown: []};
  } catch (err) {
    expect(err).toBeInstanceOf(DiagnosticsError);
    return {split, source, ctx, file: undefined, thrown: (err as DiagnosticsError).diagnostics};
  }
}

let tmp: string | undefined;

async function tmpDir(): Promise<string> {
  await mkdir(TMP_DIR, {recursive: true});
  tmp ??= await mkdtemp(join(TMP_DIR, 'svelte-render-'));
  return tmp;
}

/** For the spec's `afterAll`. */
export async function removeRendered(): Promise<void> {
  if (tmp) await rm(tmp, {recursive: true, force: true});
}

// TMP_DIR is under the repo so `svelte` resolves; plain JS, so Node's own import.
export async function loadServerModule(name: string, code: string): Promise<unknown> {
  const path = join(await tmpDir(), `${name}.js`);
  await writeFile(path, code);
  return ((await import(/* @vite-ignore */ pathToFileURL(path).href)) as {default: unknown}).default;
}

/** Imports point at what the Vite plugin would serve. */
async function serverModule(file: VirtualFile, ctx: BuildContext, name: string): Promise<unknown> {
  // Svelte hashes the `<svelte:head>` marker from the filename relative to `rootDir`, the cwd by default.
  const {js} = svelte.compile(file.code, {generate: 'server', filename: `${ctx.filename}.svelte.svelte`, rootDir: REPO_ROOT});
  const text = new MagicString(js.code);
  for (const node of parseSync('Shape.js', js.code, {sourceType: 'module'}).program.body) {
    if (node.type !== 'ImportDeclaration') continue;
    const id = node.source.value;
    const module = Object.values(ctx.modules).find((candidate) => candidate.id === id);
    const point = async (written: string, code: string) => {
      await writeFile(join(await tmpDir(), written), code);
      text.overwrite(node.source.start, node.source.end, JSON.stringify(`./${written}`));
    };
    if (ctx.styles.some((style) => style.id === id)) text.remove(node.start, node.end);
    else if (module) await point(`${name}.classes${module.index}.js`, `export default ${JSON.stringify(module.classes)};`);
    else if (id === SCOPE_HELPER_ID) await point(`${name}.scope.js`, scopeHelperCode(!ctx.production));
    else if (id.endsWith('.front')) {
      const fixture = relative(componentPath(''), join(dirname(ctx.filename), id))
        .split(sep)
        .join('/');
      const child = await svelteBuild(fixture, ctx.production);
      if (!child.file) throw new DiagnosticsError(child.thrown);
      const childName = `${name}.${basename(fixture, '.front')}`;
      await serverModule(child.file, child.ctx, childName);
      text.overwrite(node.source.start, node.source.end, JSON.stringify(`./${childName}.js`));
    }
  }
  return loadServerModule(name, text.toString());
}

export async function renderBuild(file: VirtualFile, ctx: BuildContext, name: string, props: Record<string, unknown>) {
  const component = await serverModule(file, ctx, name);
  // A compiled component of unknown props: the fixture's own declare what it takes.
  return render(component as Component<Record<string, unknown>>, {props});
}

/** `top`: the tag sits at the top level of the HTML. */
export function startTags(html: string, stamp: string) {
  const tags: {name: string; stamps: number; classes: string[]; style?: string; top: boolean}[] = [];
  let depth = 0;
  // Not parse5: it would drop a repeated attribute. Void elements close at once.
  const parser = new Parser({
    onopentagname: (name) => void tags.push({name, stamps: 0, classes: [], top: depth++ === 0}),
    onattribute: (name, value) => {
      const tag = tags.at(-1)!;
      if (name === stamp) tag.stamps++;
      if (name === 'class') tag.classes.push(...value.split(/\s+/).filter(Boolean));
      if (name === 'style') tag.style = value;
    },
    onclosetag: () => void depth--,
  });
  parser.write(html);
  parser.end();
  return tags;
}
