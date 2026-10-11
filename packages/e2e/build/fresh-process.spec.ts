import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {beforeEach, describe, expect, it, onTestFinished} from 'vitest';
import {copyApp, removeApp} from '../fixtures/index.ts';
import {startViteCli} from './lib/freshProcess.ts';

let root: string;

beforeEach(async () => {
  root = await copyApp('vue');
  await writeFile(join(root, 'package.json'), '{"type": "module"}\n');
  return () => removeApp(root);
});

function cli() {
  const vite = startViteCli(root, ['--port', '0'], {NODE_ENV: 'development'});
  onTestFinished(() => vite.stop());
  return vite;
}

describe('a vite CLI started by startViteCli()', () => {
  it('fails a wait for output it never prints with the pattern and the output so far', async () => {
    const vite = cli();
    await vite.waitForOutput(/Local:/);
    await expect(vite.waitForOutput(/never printed/, 1, 1000)).rejects.toThrow(
      /^no 1 × \/never printed\/ after 1000 ms:\n[^]*Local:/
    );
  });

  it('stops even when its server.close() never settles', async () => {
    // The interval keeps Node alive: a bare pending promise would let it exit.
    await writeFile(
      join(root, 'vite.config.ts'),
      `import vue from '@vitejs/plugin-vue';
import {multifront} from '@multifront/vite';
import {defineConfig} from 'vite';

export default defineConfig({plugins: [vue(), multifront(), {name: 'never-closes', closeBundle: () => new Promise(() => setInterval(() => {}, 1000))}]});
`
    );
    const vite = cli();
    await vite.waitForOutput(/Local:/);
    const start = Date.now();
    await vite.stop();
    // At least the grace period: the polite stop really stalled.
    expect(Date.now() - start).toBeGreaterThanOrEqual(5000);
    expect(Date.now() - start).toBeLessThan(15_000);
  });
});
