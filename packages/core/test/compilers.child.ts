// Runs with no NODE_PATH: pnpm's bin shims put the store's hoisted node_modules there, where any folder finds a compiler.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {buildTarget, createBuildContext, loadSvelteCompiler, loadVueCompiler, splitBlocks} from '../src/index.ts';

const CARD = fileURLToPath(new URL('../../e2e/fixtures/components/Card.ucf', import.meta.url));

// `svelte-build`: Card.ucf's svelte pick in a project at the root, through the host call.
async function run(mode: string, root: string): Promise<void> {
  if (mode === 'vue') loadVueCompiler(root);
  else if (mode === 'svelte') loadSvelteCompiler(root);
  else {
    const split = splitBlocks(readFileSync(CARD, 'utf8'), CARD);
    const compiler = loadVueCompiler(import.meta.dirname);
    buildTarget(split, await createBuildContext(split, {root, compiler, production: true}), 'svelte');
  }
}

if (import.meta.main) {
  try {
    await run(process.argv[2]!, process.argv[3]!);
    process.stdout.write('found');
  } catch (err) {
    process.stdout.write(`${(err as Error).name}: ${(err as Error).message}`);
  }
}
