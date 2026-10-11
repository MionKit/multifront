import type {Target} from '@multifront/core';

// After `X.ucf`, the module id of each target (spec 4.3); vue keeps the real path.
export const TARGET_SUFFIX: Record<Target, string> = {vue: '', react: '.react.tsx', svelte: '.svelte.svelte'};

/** The targets whose id names no file on disk. */
export const VIRTUAL_TARGETS = ['react', 'svelte'] as const;

export function splitId(id: string): {path: string; query: URLSearchParams} {
  const queryStart = id.indexOf('?');
  if (queryStart === -1) return {path: id, query: new URLSearchParams()};
  return {path: id.slice(0, queryStart), query: new URLSearchParams(id.slice(queryStart + 1))};
}

export function virtualTarget(path: string): {target: Target; file: string} | undefined {
  const target = VIRTUAL_TARGETS.find((candidate) => path.endsWith(`.ucf${TARGET_SUFFIX[candidate]}`));
  return target && {target, file: path.slice(0, -TARGET_SUFFIX[target].length)};
}
