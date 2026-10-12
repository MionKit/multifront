// Milestone 5 seam, 5.2 to 5.9: the editor's class map rename is the one build() ships, on every <svelte> fixture.
import {readdirSync} from 'node:fs';
import {sep} from 'node:path';
import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';
import {describe, expect, it} from 'vitest';
import {
  DiagnosticsError,
  buildTarget,
  createBuildContext,
  loadSvelteCompiler,
  loadVueCompiler,
  locate,
  renameSvelteStyles,
  splitBlocks,
} from '@multifront/core';
import {FIXTURES_DIR, componentPath, readComponent} from '../fixtures/index.ts';

const vue = loadVueCompiler(FIXTURES_DIR);
const svelte = loadSvelteCompiler(FIXTURES_DIR);

const FIXTURES = readdirSync(componentPath(''), {recursive: true, encoding: 'utf8'})
  .map((name) => name.split(sep).join('/'))
  .filter((name) => name.endsWith('.ucf') && !name.startsWith('invalid/'))
  .filter((name) => readComponent(name).source.includes('<svelte>'))
  .sort();

function offsetOf(text: string, line: number, column: number): number {
  return text.split('\n', line - 1).join('\n').length + (line > 1 ? 1 : 0) + column;
}

// `<.ucf offset> <local>` for each use of a class map local in `code`, read back through its map.
function uses(code: string, map: TraceMap, locals: string[], source: string): string[] {
  const found: string[] = [];
  for (const local of locals) {
    for (const match of code.matchAll(new RegExp(String.raw`(?<![\w$"])${local}\b(?! from )`, 'g'))) {
      const {line, column} = originalPositionFor(map, locate(code, match.index));
      found.push(`${line === null ? 'unmapped' : offsetOf(source, line, column!)} ${local}`);
    }
  }
  return found.sort();
}

describe('renameSvelteStyles matches the rename of build()', () => {
  it('covers the shared fixtures and the svelte/ ones', () => {
    expect(FIXTURES).toEqual(expect.arrayContaining(['Panel.ucf', 'PanelItem.ucf', 'Counter.ucf', 'svelte/shapes/Elements.ucf']));
  });

  it.each(FIXTURES)('%s', async (name) => {
    const {filename, source} = readComponent(name);
    const split = splitBlocks(source, filename);
    const ctx = await createBuildContext(split, {root: FIXTURES_DIR, compiler: vue, production: false});
    let built;
    try {
      built = buildTarget(split, ctx, 'svelte');
    } catch (err) {
      // A block build() rejects has no rename to ship.
      expect(err).toBeInstanceOf(DiagnosticsError);
      return;
    }
    const renamed = renameSvelteStyles(split.targets.svelte!, split, svelte, ctx.modules);

    const ids = new Map(Object.values(ctx.modules).map(({id}) => [id, id]));
    const imported = [...built.code.matchAll(/^import (__ucf\w+) from "([^"]+)";$/gm)].filter(([, , id]) => ids.has(id!));
    const builtLocals = Object.fromEntries(imported.map(([, local, id]) => [id!, local!]));
    const renamedLocals = Object.fromEntries([...renamed.locals].map(([module, local]) => [module.id, local]));
    expect(renamedLocals).toEqual(builtLocals);

    const locals = Object.values(builtLocals);
    const builtUses = uses(built.code, new TraceMap(built.map!), locals, source);
    const renameMap = new TraceMap({version: 3, sources: [filename], names: [], mappings: renamed.mappings});
    expect(uses(renamed.code, renameMap, locals, source)).toEqual(builtUses);
    for (const use of builtUses) expect(source.slice(Number(use.split(' ')[0])), use).toMatch(/^\$\w/);
  });
});
