import {existsSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createConsumerApp} from './lib/app.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('createConsumerApp', () => {
  it('installs the template and remove() deletes it', async () => {
    vi.stubEnv('MULTIFRONT_KEEP_CONSUMER_APPS', '');
    const app = await createConsumerApp('consumer-vite-react', []);
    expect(existsSync(join(app.dir, 'node_modules', 'vite', 'package.json'))).toBe(true);
    await app.remove();
    expect(existsSync(app.dir)).toBe(false);
  });

  it('keeps the app and prints its path with MULTIFRONT_KEEP_CONSUMER_APPS', async () => {
    vi.stubEnv('MULTIFRONT_KEEP_CONSUMER_APPS', '1');
    const stderr = vi.spyOn(process.stderr, 'write');
    const app = await createConsumerApp('consumer-vite-react', []);
    try {
      await app.remove();
      expect(existsSync(app.dir)).toBe(true);
      expect(stderr).toHaveBeenCalledWith(`kept consumer app: ${app.dir}\n`);
    } finally {
      await rm(app.dir, {recursive: true, force: true});
    }
  });
});
