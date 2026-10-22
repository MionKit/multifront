import {resolve} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {multifront} from '@multifront/vite';
import {mergeConfig, type InlineConfig} from 'vite';
import {beforeEach, describe, expect, it} from 'vitest';
import {copyApp, readComponent, removeApp, saveFile} from '../fixtures/index.ts';
import {hotUpdatesOf, withDevServer} from './lib/build.ts';

const RERENDER = 'export const _rerender_only';
// Twice the watcher's 50 ms per-file change throttle.
const WATCHER_THROTTLE_MS = 100;

const counter = readComponent('Counter.front').source;
const globalProps = readComponent('vue/GlobalProps.front').source;

let root: string;
let components: string;

// Each test's copy is a new path: neither our record nor plugin-vue's cache knows it yet.
beforeEach(async () => {
  root = await copyApp('vue');
  components = resolve(root, '..', '..', 'components');
  return () => removeApp(root);
});

function mainAfterSaves(file: string, sources: string[], config: InlineConfig = {}) {
  const hot = hotUpdatesOf(file);
  return withDevServer(root, mergeConfig(config, {plugins: [hot.plugin]}), async (server) => {
    const environment = server.environments.client;
    const url = `/@fs${file}`;
    await environment.transformRequest(url);
    const results: ({code: string} | {error: string})[] = [];
    for (const source of sources) {
      await new Promise((done) => setTimeout(done, WATCHER_THROTTLE_MS));
      const updated = hot.next();
      await saveFile(file, source);
      await updated;
      results.push(
        await environment.transformRequest(url).then(
          (result) => ({code: result!.code}),
          (err: Error) => ({error: err.message})
        )
      );
    }
    return results;
  });
}

describe('the Vue main module of a .front file after a hot update', () => {
  it('re-renders after a template typo is fixed, as plugin-vue does for a .vue file', async () => {
    const typo = counter.replace('<span class="label">Clicks</span>', '<span class="label">Clicks</spam>');
    expect(typo).not.toBe(counter);
    const [broken, fixed] = await mainAfterSaves(resolve(components, 'Counter.front'), [typo, counter]);
    expect(broken).toEqual({error: expect.stringContaining('Invalid end tag')});
    expect(fixed).toEqual({code: expect.stringContaining(RERENDER)});
  });

  it('fails while the <vue> block is gone and builds again once it is back', async () => {
    const vueEnd = counter.indexOf('</vue>') + '</vue>'.length;
    const [gone, back] = await mainAfterSaves(resolve(components, 'Counter.front'), [counter.slice(vueEnd), counter]);
    expect(gone).toEqual({error: expect.stringContaining('<vue>')});
    expect(back).toEqual({code: expect.stringContaining('Clicks')});
  });

  it('re-renders a template edit when its props type resolves only through script.globalTypeFiles', async () => {
    const config: InlineConfig = {
      configFile: false,
      plugins: [vue({script: {globalTypeFiles: [resolve(components, 'vue', 'global-props.d.ts')]}}), multifront()],
    };
    const edited = globalProps.replace('<p class="global">', '<p class="global edited">');
    expect(edited).not.toBe(globalProps);
    const [main] = await mainAfterSaves(resolve(components, 'vue', 'GlobalProps.front'), [edited], config);
    expect(main).toEqual({code: expect.stringContaining('global edited')});
    expect(main).toEqual({code: expect.stringContaining(RERENDER)});
  });
});
