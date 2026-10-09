import {createRequire} from 'node:module';
import vue from '@vitejs/plugin-vue';
import {build, type Plugin} from 'vite';
import {describe, expect, it} from 'vitest';
import {getVueCompiler, multifront} from '@multifront/vite';

const require = createRequire(import.meta.url);
const PROBE_ID = 'virtual:probe';

// Builds one virtual module that reports which compiler multifront got from plugin-vue.
async function probe(plugins: Plugin[]): Promise<string> {
  const mf = plugins.find((plugin) => plugin.name === 'multifront')!;
  const probePlugin: Plugin = {
    name: 'probe',
    resolveId: (id) => (id.endsWith(PROBE_ID) ? `\0${PROBE_ID}` : undefined),
    load(id) {
      if (id !== `\0${PROBE_ID}`) return;
      const {vueCompiler} = mf.api as {vueCompiler: object};
      return `export default ${JSON.stringify(vueCompiler === require('vue/compiler-sfc') ? 'same' : 'other')};`;
    },
  };
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [...plugins, probePlugin],
    build: {write: false, lib: {entry: PROBE_ID, formats: ['es']}},
  });
  const output = Array.isArray(result) ? result[0]! : result;
  return 'output' in output ? output.output[0].code : '';
}

describe('getVueCompiler', () => {
  it('borrows the compiler plugin-vue resolved', async () => {
    expect(await probe([multifront(), vue()])).toContain('"same"');
  });

  it('resolves the compiler itself when plugin-vue is absent', () => {
    expect(getVueCompiler([], new URL('..', import.meta.url).pathname)).toHaveProperty('compileStyleAsync');
  });
});

describe('multifront options', () => {
  it('rejects a default framework that is not enabled', () => {
    expect(() => multifront({frameworks: ['react'], framework: 'vue'})).toThrow(/not one of the enabled frameworks/);
  });
});
