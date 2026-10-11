import {classMapId, styleId} from '@multifront/core';
import type {Block, SplitResult} from '@multifront/core';
import type {DevEnvironment, EnvironmentModuleNode, HotUpdateOptions} from 'vite';
import type {UcfCache, UcfEntry, UcfVersion} from './cache.ts';
import {VIRTUAL_TARGETS, isOwnId, splitId, targetId} from './ids.ts';

function sameAttrs(left: Block['attrs'], right: Block['attrs']): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

// Offsets ignored, as plugin-vue's `isEqualBlock`: a block that only moved keeps its module.
function sameBlock(left: Block | undefined, right: Block | undefined): boolean {
  if (!left || !right) return left === right;
  return left.content === right.content && sameAttrs(left.attrs, right.attrs);
}

function sameClasses(left: Record<string, string> | undefined, right: Record<string, string> | undefined): boolean {
  if (!left || !right) return left === right;
  return sameAttrs(left, right);
}

async function classesOf(entry: Promise<UcfEntry> | undefined, index: number) {
  try {
    return entry && {classes: (await entry).ctx.styles[index]?.classes};
  } catch {
    return undefined;
  }
}

function allIds(file: string, splits: SplitResult[]): string[] {
  const styles = Math.max(...splits.map((split) => split.styles.length));
  const ids = VIRTUAL_TARGETS.map((target) => targetId(file, target));
  for (let index = 0; index < styles; index++) ids.push(styleId(file, index), classMapId(file, index));
  return ids;
}

/** The ids of our modules that `current` changes, against the version it replaced. */
async function changedIds(file: string, previous: NonNullable<UcfVersion['previous']>, current: UcfVersion, cache: UcfCache) {
  const before = previous.split;
  const after = current.split;
  // The overlay shows the splitter error, and the fix clears it.
  if (before.errors.length > 0 || after.errors.length > 0) return allIds(file, [before, after]);
  const ids: string[] = [];
  // Stamping and the `$style` / named imports of every target module follow these.
  let importsChanged = before.styles.length !== after.styles.length;
  const common = Math.min(before.styles.length, after.styles.length);
  for (let index = 0; index < common; index++) {
    const old = before.styles[index]!;
    const now = after.styles[index]!;
    if (old.attrs.scoped !== now.attrs.scoped || old.attrs.module !== now.attrs.module) importsChanged = true;
    if (sameBlock(old, now)) continue;
    ids.push(styleId(file, index));
    if (now.attrs.module === undefined) continue;
    const oldClasses = await classesOf(previous.entry, index);
    const newClasses = await classesOf(cache.contextOf(current), index);
    if (!oldClasses || !newClasses || !sameClasses(oldClasses.classes, newClasses.classes)) {
      ids.push(classMapId(file, index));
    }
  }
  for (const target of VIRTUAL_TARGETS) {
    if (importsChanged || !sameBlock(before.targets[target], after.targets[target])) ids.push(targetId(file, target));
  }
  return ids;
}

// The bare file and plugin-vue's `?vue&…` sub-requests.
function isVueModule(id: string): boolean {
  const {query} = splitId(id);
  return query.size === 0 || query.has('vue');
}

/** Spec 7: a `<style>` edit updates its style module, a target block edit only that target's module. */
export function ucfHotUpdate(cache: UcfCache, hasVuePlugin: () => boolean) {
  return async function hotUpdate(
    this: {environment: DevEnvironment},
    {type, file, modules, read}: HotUpdateOptions
  ): Promise<EnvironmentModuleNode[] | void> {
    if (type !== 'update' || !file.endsWith('.ucf')) return;
    const current = cache.updateUcf(file, await read());
    // Never served: none of our modules exist.
    if (!current.previous) return;
    // Without plugin-vue the bare node is only our `addWatchFile` edge, and handing it on re-runs the react module.
    const vue = hasVuePlugin();
    const handedOn = modules.filter((mod) => !mod.id || (!isOwnId(mod.id) && (vue || !isVueModule(mod.id))));
    const graph = this.environment.moduleGraph;
    const ours = (await changedIds(file, current.previous, current, cache)).flatMap((id) => graph.getModuleById(id) ?? []);
    return [...new Set([...handedOn, ...ours])];
  };
}
