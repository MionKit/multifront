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
// scope: secret = credential, dev = knob with a default, internal = set by the scripts or a tool they run (never in .env).
export const REGISTRY = [
  {name: 'CI', scope: 'internal', desc: 'set by CI; skips loading .env, and peer-floor runs only with it set'},
  {name: 'GITHUB_OUTPUT', scope: 'internal', desc: 'set by GitHub Actions; the CI Playwright version step writes the cache key there'},
  {name: 'NODE_ENV', scope: 'internal', desc: 'set to test by Vitest; the e2e build helpers pin production or development around Vite; the consumer helpers clear it for the temp apps'},
  {name: 'NODE_OPTIONS', scope: 'internal', desc: 'the e2e language server helper appends --conditions=source, so the forked bin runs from src'},
  {name: 'NODE_PATH', scope: 'internal', desc: "set by pnpm's bin shims into the repo's packages; the editor and compiler lookup tests and the consumer helpers clear it for their child processes"},
  {name: 'PATH', scope: 'internal', desc: "the shell's; the consumer test helpers drop its entries inside the repo for the temp apps, so no repo bin stands in for an app's"},
  {name: 'TEST', scope: 'internal', desc: 'set by Vitest; the consumer test helpers clear it for the temp apps'},
  {name: 'VITEST*', scope: 'internal', desc: "Vitest's own markers; the consumer test helpers clear them for the temp apps"},
  {name: 'npm_package_*', scope: 'internal', desc: "set by pnpm's script runner; the consumer test helpers clear them for the temp apps"},
  {name: 'npm_lifecycle_*', scope: 'internal', desc: "set by pnpm's script runner; the consumer test helpers clear them for the temp apps"},
  {name: 'NEXT_TELEMETRY_DISABLED', scope: 'internal', desc: 'set to 1 by the consumer test helpers for the temp apps, so Next.js sends no telemetry from a test run'},
  {name: 'DISPLAY', scope: 'internal', desc: 'X display of the real VS Code tests; unset on Linux, the harness starts its own Xvfb'},
  {name: 'MULTIFRONT_VSCODE_RESULTS', scope: 'internal', desc: 'set by the real VS Code harness: where the check suite inside VS Code writes its results'},
  {name: 'MULTIFRONT_CHROMIUM_PATH', scope: 'dev', desc: 'Chromium the browser tests and docs-images use, when the Playwright one is not installed'},
  {name: 'MULTIFRONT_CONSUMER_TARBALLS', scope: 'internal', desc: "set by CI's consumer job: the folder pnpm devx consumer-pack filled; the consumer tests install those tarballs instead of building their own"},
  {name: 'MULTIFRONT_KEEP_CONSUMER_APPS', scope: 'dev', desc: 'keep the temp apps of the consumer tests (packages/e2e/consumer/) in the OS temp dir; each kept path is printed'},
  {name: 'MULTIFRONT_FUZZ_SEED', scope: 'dev', desc: 'base seed of the fuzz tests; default fixed, so every run replays'},
  {name: 'MULTIFRONT_FUZZ_RUNS', scope: 'dev', desc: 'inputs per fuzz test (default 500 for the splitter, 300 for the scope transform and the Svelte scope stamping)'},
];
