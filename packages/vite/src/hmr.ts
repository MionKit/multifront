import {classMapId, styleId} from '@multifront/core';
import type {Block} from '@multifront/core';
import type {Plugin} from 'vite';
import type {createUcfCache} from './cache.ts';
import {TARGET_SUFFIX, VIRTUAL_TARGETS, splitId} from './ids.ts';
import type {UcfEntry, UcfSnapshot, UcfVersion} from './types.ts';

type UcfCache = ReturnType<typeof createUcfCache>;

function sameRecord(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

// Offsets ignored, as plugin-vue's `isEqualBlock`: a block that only moved keeps its module.
function sameBlock(left: Block | undefined, right: Block | undefined): boolean {
  if (!left || !right) return left === right;
  return left.content === right.content && sameRecord(left.attrs, right.attrs);
}

async function classesOf(entry: Promise<UcfEntry> | undefined, index: number) {
  try {
    return entry && (await entry).ctx.styles[index]?.classes;
  } catch {
    return undefined;
  }
}

async function changedIds(file: string, before: UcfSnapshot, after: UcfVersion, cache: UcfCache) {
  const old = before.split;
  const now = after.split;
  // The overlay shows the error, the fix clears it; never an index `now` lacks: it would load the `.ucf` as CSS.
  if (old.errors.length > 0 || now.errors.length > 0) {
    return [
      ...VIRTUAL_TARGETS.map((target) => file + TARGET_SUFFIX[target]),
      ...now.styles.flatMap((_, index) => [styleId(file, index), classMapId(file, index)]),
    ];
  }
  const ids: string[] = [];
  // Stamping and the `$style` / named imports of every target module follow these.
  let importsChanged = old.styles.length !== now.styles.length;
  for (let index = 0; index < Math.min(old.styles.length, now.styles.length); index++) {
    const oldStyle = old.styles[index]!;
    const newStyle = now.styles[index]!;
    if (oldStyle.attrs.scoped !== newStyle.attrs.scoped || oldStyle.attrs.module !== newStyle.attrs.module) {
      importsChanged = true;
    }
    if (sameBlock(oldStyle, newStyle)) continue;
    ids.push(styleId(file, index));
    if (newStyle.attrs.module === undefined) continue;
    // No old context (never compiled) or a failed one counts as changed.
    const oldClasses = await classesOf(before.entry, index);
    const newClasses = await classesOf(cache.contextOf(after), index);
    if (!oldClasses || !newClasses || !sameRecord(oldClasses, newClasses)) ids.push(classMapId(file, index));
  }
  for (const target of VIRTUAL_TARGETS) {
    if (importsChanged || !sameBlock(old.targets[target], now.targets[target])) ids.push(file + TARGET_SUFFIX[target]);
  }
  return ids;
}

/** Spec 7: a `<style>` edit updates its style module, a target block edit only that target's module. */
export function ucfHotUpdate(cache: UcfCache, hasVuePlugin: () => boolean): Plugin['hotUpdate'] {
  // Every environment's hook of one change gets its timestamp: one read, so a later save never splits them.
  const changes = new Map<string, {timestamp: number; before: UcfSnapshot | undefined; after: UcfVersion}>();
  return async function hotUpdate({type, file, modules, read, timestamp}) {
    if (type !== 'update' || !file.endsWith('.ucf')) return;
    const vuePlugin = hasVuePlugin();
    const handedOn = modules.filter((mod) => {
      if (!mod.id) return true;
      const {path, query} = splitId(mod.id);
      if (query.has('ucf')) return false;
      // Without plugin-vue the bare node is only our `addWatchFile` edge, and handing it on re-runs the react module.
      return vuePlugin || !(query.has('vue') || (query.size === 0 && path.endsWith('.ucf')));
    });
    let change = changes.get(file);
    if (change?.timestamp !== timestamp) {
      const after = cache.updateUcf(file, await read());
      change = {timestamp, before: change ? change.after : after.previous, after};
      changes.set(file, change);
    }
    // A file never served, or a save that changed nothing since we served it.
    if (!change.before) return handedOn;
    const graph = this.environment.moduleGraph;
    const ids = await changedIds(file, change.before, change.after, cache);
    return [...handedOn, ...ids.flatMap((id) => graph.getModuleById(id) ?? [])];
  };
}
