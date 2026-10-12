import {readFile, readdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {TraceMap, decodedMappings, originalPositionFor} from '@jridgewell/trace-mapping';
import type {EncodedSourceMap} from '@jridgewell/trace-mapping';
import {locate, splitBlocks} from '@multifront/core';
import {build, mergeConfig, type Rolldown} from 'vite';
import {beforeAll, describe, expect, it} from 'vitest';
import {copyApp, readComponent, removeApp, saveFile} from '../fixtures/index.ts';
import {APP_CONFIG_LOADER, buildApp, hotUpdatesOf, withDevServer, withNodeEnv} from './lib/build.ts';

type BuildError = Rolldown.BundleError & Pick<Rolldown.RollupError, 'loc'>;

// The shared components, seen from the copied app's root.
const COUNTER_PATH = '../../components/Counter.ucf';
const counter = readComponent('Counter.ucf').source;
const templateError = readComponent('vue/TemplateError.ucf').source;

let root: string;

beforeAll(async () => {
  root = await copyApp('vue');
  await writeFile(
    join(root, 'src', 'template-error.ts'),
    "export {default} from '../../../components/vue/TemplateError.ucf' with {framework: 'vue'};\n"
  );
  return () => removeApp(root);
});

/** Line 1-based, column 0-based in UTF-16 code units, as source maps count. */
function positionOf(text: string, search: string | RegExp, shift = 0): {line: number; column: number} {
  const offset = typeof search === 'string' ? text.indexOf(search) : (search.exec(text)?.index ?? -1);
  if (offset < 0) throw new Error(`not found: ${search}`);
  return locate(text, offset + shift);
}

/** A copy of its own: compiler-sfc's parse cache would hand another run's descriptor to the same path. */
async function withOwnCopy<Result>(run: (copy: string) => Promise<Result>): Promise<Result> {
  const copy = await copyApp('vue');
  try {
    return await run(copy);
  } finally {
    await removeApp(copy);
  }
}

describe('a production build of the vue app with build.sourcemap', () => {
  let chunk: Rolldown.OutputChunk;
  let map: TraceMap;

  beforeAll(async () => {
    const {chunks} = await buildApp(root, {build: {sourcemap: true}});
    chunk = chunks.find((candidate) => candidate.moduleIds.includes(join(root, COUNTER_PATH)))!;
    map = new TraceMap(chunk.map!.toString());
  });

  const trace = (generated: string | RegExp, shift = 0) => originalPositionFor(map, positionOf(chunk.code, generated, shift));

  it('maps a template expression to its line and column in Counter.ucf', () => {
    // After the non-ASCII `title` on the same line: columns count UTF-16 code units.
    const expected = positionOf(counter, '{{ count }}', '{{ '.length);
    expect(trace('toDisplayString(count.value)')).toMatchObject({source: expect.stringMatching(/\/Counter\.ucf$/), ...expected});
  });

  it('maps a <script setup> statement to its line and column in Counter.ucf', () => {
    const expected = positionOf(counter, 'const count = ref(');
    // compiler-sfc 3.5.27 and later mark the call pure.
    expect(trace(/const count = (?:\/\* @__PURE__ \*\/ )?ref\(__props\.start/)).toMatchObject({
      source: expect.stringMatching(/\/Counter\.ucf$/),
      ...expected,
    });
  });

  // plugin-vue's sub-request maps start from the SFC code it parsed, where the other targets are blanked.
  it('gives every source entry of Counter.ucf the text of the file', () => {
    const {sources, sourcesContent} = chunk.map!;
    const texts = sources.flatMap((source, index) => (source.endsWith('/Counter.ucf') ? [sourcesContent?.[index]] : []));
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect(text).toBe(counter);
  });

  it('maps nothing into the blanked parts of Counter.ucf', () => {
    const {blocks} = splitBlocks(counter, 'Counter.ucf');
    const kept = blocks.flatMap((block) => {
      if (block.type === 'vue') return [[block.contentStart, block.contentEnd]];
      return block.type === 'style' ? [[block.start, block.end]] : [];
    });
    const lineStarts = [0, ...[...counter.matchAll(/\n/g)].map((match) => match.index + 1)];
    const sources = chunk.map!.sources;
    const outside: string[] = [];
    let mapped = 0;
    for (const line of decodedMappings(map)) {
      for (const [, sourceIndex, sourceLine, sourceColumn] of line) {
        if (sourceIndex === undefined || !sources[sourceIndex]!.endsWith('/Counter.ucf')) continue;
        mapped++;
        const offset = lineStarts[sourceLine!]! + sourceColumn!;
        if (!kept.some(([start, end]) => offset >= start! && offset < end!)) outside.push(`${sourceLine! + 1}:${sourceColumn}`);
      }
    }
    expect(mapped).toBeGreaterThan(0);
    expect(outside).toEqual([]);
  });
});

function devStyleCss(copy: string, edit?: (source: string) => string): Promise<string> {
  const file = join(copy, COUNTER_PATH);
  const hot = hotUpdatesOf(file);
  return withDevServer(copy, {css: {devSourcemap: true}, plugins: [hot.plugin]}, async (server) => {
    const main = await server.environments.client.transformRequest(`/@fs${file}`);
    const url = /["']([^"']*[?&]type=style&index=0&scoped=[^"']*)["']/.exec(main!.code)![1]!;
    await server.environments.client.transformRequest(url);
    if (edit) {
      const updated = hot.next();
      await saveFile(file, edit(counter));
      await updated;
    }
    const style = await server.environments.client.transformRequest(url);
    return JSON.parse(/const __vite__css = ("(?:[^"\\]|\\.)*")/.exec(style!.code)![1]!) as string;
  });
}

function expectRuleMapped(css: string, source: string): void {
  const encoded = /sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([\w+/=]+)/.exec(css)![1]!;
  const raw = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as EncodedSourceMap;
  expect(originalPositionFor(new TraceMap(raw), positionOf(css, '.counter[data-v-'))).toMatchObject({
    source: expect.stringMatching(/\/Counter\.ucf$/),
    ...positionOf(source, '.counter {'),
  });
  expect(raw.sourcesContent).toEqual([source]);
}

describe('a dev server with css.devSourcemap', () => {
  it("maps the scoped style sub-module's rule to its line in Counter.ucf, with the file's text", async () => {
    expectRuleMapped(await withOwnCopy((copy) => devStyleCss(copy)), counter);
  });

  it('keeps the text of Counter.ucf after a <style> hot update', async () => {
    const edit = (source: string) => source.replace('rgb(120, 40, 160)', 'rgb(10, 20, 30)');
    const css = await withOwnCopy((copy) => devStyleCss(copy, edit));
    expect(css).toContain('rgb(10, 20, 30)');
    expectRuleMapped(css, edit(counter));
  });

  it('maps to the new line after a <react> hot update that adds one above the styles', async () => {
    const edit = (source: string) => source.replace('  export default function', '  // one more line\n  export default function');
    expect(edit(counter)).not.toBe(counter);
    expectRuleMapped(await withOwnCopy((copy) => devStyleCss(copy, edit)), edit(counter));
  });
});

describe('a watch build with build.sourcemap', () => {
  // Same length: the SFC code stays the same, so plugin-vue keeps its compiled script and that script's map.
  const edited = counter.replace('className="label">Clicks', 'className="label">Clocks');

  it('gives the rebuilt script the text of Counter.ucf after a <react>-only edit', async () => {
    expect(edited).not.toBe(counter);
    const texts = await withOwnCopy((copy) =>
      withNodeEnv('production', async () => {
        const outDir = join(copy, 'dist-watch');
        const config = {root: copy, logLevel: 'silent' as const, configLoader: APP_CONFIG_LOADER};
        const options = {build: {watch: {}, outDir, minify: false, sourcemap: true}};
        const watcher = (await build(mergeConfig(config, options))) as Rolldown.RolldownWatcher;
        const builds: (string | null | undefined)[][] = [];
        try {
          await new Promise<void>((resolve, reject) => {
            watcher.on('event', async (event) => {
              if (event.code === 'ERROR') return reject(event.error);
              if (event.code !== 'BUNDLE_END') return;
              await event.result.close();
              const assets = join(outDir, 'assets');
              const [file] = (await readdir(assets)).filter((name) => name.endsWith('.js.map'));
              const map = JSON.parse(await readFile(join(assets, file!), 'utf8')) as EncodedSourceMap;
              builds.push(
                map.sources.flatMap((source, index) => (source?.endsWith('/Counter.ucf') ? [map.sourcesContent?.[index]] : []))
              );
              if (builds.length === 1) await saveFile(join(copy, COUNTER_PATH), edited);
              else resolve();
            });
          });
        } finally {
          await watcher.close();
        }
        return builds;
      })
    );
    expect(texts[0]!.length).toBeGreaterThan(0);
    for (const text of texts[0]!) expect(text).toBe(counter);
    expect(texts[1]!.length).toBeGreaterThan(0);
    for (const text of texts[1]!) expect(text).toBe(edited);
  });
});

describe('a template error', () => {
  it('fails the build naming TemplateError.ucf at the line and column of the bad tag', async () => {
    const input = join(root, 'src', 'template-error.ts');
    const error = (await buildApp(root, {build: {rolldownOptions: {input}}}).then(
      () => undefined,
      (err: unknown) => err
    )) as BuildError | undefined;
    const {line, column} = positionOf(templateError, '<span>');
    // Vue counts columns from 1.
    expect(error?.message).toMatch(new RegExp(`/vue/TemplateError\\.ucf:${line}:${column + 1}\\b`));
    expect(error?.errors?.[0]?.loc).toEqual({
      file: join(root, '../../components/vue/TemplateError.ucf'),
      line,
      column: column + 1,
    });
  });
});
