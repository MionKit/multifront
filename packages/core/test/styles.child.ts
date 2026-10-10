// Run as a script, compiles one fixture's styles in its own process: a crash or a hang fails the caller, not the run.
import {createRequire} from 'node:module';
import {compileStyles, scopeId, splitBlocks} from '../src/index.ts';
import type {VueCompiler} from '../src/index.ts';
import {readComponent} from '../../e2e/fixtures/index.ts';

const compiler = createRequire(import.meta.url)('@vue/compiler-sfc') as VueCompiler;

export async function compile(name: string) {
  const {filename, source} = readComponent(name);
  const split = splitBlocks(source, filename);
  const id = scopeId(name, source, true);
  const styles = await compileStyles(split.styles, {id, filename, source, compiler, production: true});
  return {filename, source, split, id, styles};
}

if (import.meta.main) process.stdout.write(JSON.stringify((await compile(process.argv[2]!)).styles));
