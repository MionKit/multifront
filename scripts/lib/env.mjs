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
export const REGISTRY = [{name: 'CI', scope: 'internal', desc: 'set by CI; skips loading .env'}];
