// Runs with no NODE_PATH: pnpm's bin shims put the store's hoisted node_modules there, where any folder finds Svelte.
import {loadSvelteCompiler} from '../src/index.ts';

if (import.meta.main) {
  try {
    loadSvelteCompiler(process.argv[2]!);
    process.stdout.write('found');
  } catch (err) {
    process.stdout.write((err as Error).message);
  }
}
