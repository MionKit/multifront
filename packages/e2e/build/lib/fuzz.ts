// The seeded fuzz harness every fuzz spec shares (fuzzy-testing skill templates, no library).

export interface FuzzSettings {
  seed: number;
  runs: number;
}

export interface Action<Kind extends string> {
  kind: Kind;
  seed: number;
}

export interface Violation<Rule extends string> {
  rule: Rule;
  message: string;
}

export interface Failure<Case, Rule extends string> {
  seed: number;
  runIndex: number;
  runSeed: number;
  input: Case;
  shrunk: Case;
  violations: Violation<Rule>[];
}

function readKnob(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= min && value <= max)) throw new Error(`${name} must be an integer from ${min} to ${max}, got '${raw}'`);
  return value;
}

/** `MULTIFRONT_FUZZ_SEED` and `MULTIFRONT_FUZZ_RUNS`, else the spec's defaults. */
export function fuzzSettings(defaults: FuzzSettings): FuzzSettings {
  return {
    // mixSeed works on 32 bits: a larger seed would silently replay a smaller one.
    seed: readKnob('MULTIFRONT_FUZZ_SEED', defaults.seed, 0, 0xffffffff),
    runs: readKnob('MULTIFRONT_FUZZ_RUNS', defaults.runs, 1, Number.MAX_SAFE_INTEGER),
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function mixSeed(base: number, label: string, index: number): number {
  let hash = base >>> 0;
  for (const char of label) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return Math.imul(hash ^ index, 0x01000193) >>> 0;
}

export function createRandom(seed: number) {
  const next = mulberry32(seed);
  const int = (max: number) => Math.floor(next() * max);
  return {
    next,
    int,
    pick<Item>(list: readonly Item[]): Item {
      if (!list.length) throw new Error('pick() from an empty list');
      return list[int(list.length)]!;
    },
    shuffle<Item>(list: readonly Item[]): Item[] {
      const copy = [...list];
      for (let index = copy.length - 1; index > 0; index--) {
        const other = int(index + 1);
        [copy[index], copy[other]] = [copy[other]!, copy[index]!];
      }
      return copy;
    },
  };
}
export type Random = ReturnType<typeof createRandom>;

/** Drops one action at a time while `stillFails` holds; the fewest actions that still fail. */
export async function shrinkActions<Kind extends string>(
  actions: Action<Kind>[],
  stillFails: (fewer: Action<Kind>[], current: Action<Kind>[]) => boolean | Promise<boolean>
): Promise<Action<Kind>[]> {
  let kept = actions;
  for (let index = 0; index < kept.length;) {
    const fewer = kept.filter((_, other) => other !== index);
    if (await stillFails(fewer, kept)) kept = fewer;
    else index++;
  }
  return kept;
}

/** The command that replays the failing run: CI shows only the assertion message, so it goes there. */
export function replayLine(seed: number, runIndex: number, specPath: string): string {
  return `replay: MULTIFRONT_FUZZ_SEED=${seed} MULTIFRONT_FUZZ_RUNS=${runIndex + 1} pnpm devx test ${specPath}`;
}
