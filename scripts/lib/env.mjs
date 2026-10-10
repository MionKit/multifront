// The one place that loads the repo-root .env and lists every env var the repo reads.
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let loaded = false;
// .env is local only: CI exports its vars directly, and a real env var always wins over .env.
export function loadEnv() {
  if (loaded) return;
  loaded = true;
  const envFile = join(REPO_ROOT, '.env');
  if (!process.env.CI && existsSync(envFile)) process.loadEnvFile(envFile);
}

// Every env var a script, test or CI step reads. Project-owned names start with MULTIFRONT_.
// scope: secret = credential, dev = knob with a default, internal = set by the scripts (never in .env).
export const REGISTRY = [
  {name: 'CI', scope: 'internal', desc: 'set by CI; skips loading .env'},
  {name: 'NODE_ENV', scope: 'internal', desc: 'set to test by Vitest; the e2e build helpers pin production or development around Vite'},
  {name: 'MULTIFRONT_CHROMIUM_PATH', scope: 'dev', desc: 'browser docs-images renders with, when the Playwright one is not installed'},
  {name: 'MULTIFRONT_FUZZ_SEED', scope: 'dev', desc: 'base seed of the fuzz tests; default fixed, so every run replays'},
  {name: 'MULTIFRONT_FUZZ_RUNS', scope: 'dev', desc: 'inputs per fuzz test (default 500)'},
];
