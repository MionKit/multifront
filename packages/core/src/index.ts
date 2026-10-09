import type {Target} from './types.ts';

export type {Target} from './types.ts';

/** Every target, in the order a library build emits them. */
export const TARGETS: readonly Target[] = ['vue', 'react', 'svelte'];

export function isTarget(value: string): value is Target {
  return (TARGETS as readonly string[]).includes(value);
}
