// Seeded fuzz runner, adapted from the fuzzy-testing skill's templates: one base seed replays every run.

const DEFAULT_SEED = 2026;
const DEFAULT_RUNS = 500;

export interface Violation {
  rule: string;
  message: string;
}

export interface Random {
  next(): number; // in [0, 1)
  int(max: number): number; // in [0, max)
  pick<Item>(list: readonly Item[]): Item;
  shuffle<Item>(list: readonly Item[]): Item[];
}

export interface FuzzConfig<Input> {
  seed: number;
  runs: number;
  generate(random: Random): Input;
  check(input: Input): Violation[];
  // Returns the smallest input it finds for which `stillFails` holds.
  shrink(input: Input, stillFails: (candidate: Input) => boolean): Input;
}

export interface FuzzFailure<Input> {
  seed: number;
  runIndex: number;
  runSeed: number;
  input: Input;
  shrunk: Input;
  violations: Violation[];
}

function readKnob(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer, got '${raw}'`);
  return Number(raw);
}

export function fuzzSettings(): {seed: number; runs: number} {
  return {seed: readKnob('MULTIFRONT_FUZZ_SEED', DEFAULT_SEED), runs: readKnob('MULTIFRONT_FUZZ_RUNS', DEFAULT_RUNS)};
}

export const DEFAULT_FUZZ_SETTINGS = {seed: DEFAULT_SEED, runs: DEFAULT_RUNS};

export function mulberry32(seed: number): () => number {
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

export function createRandom(seed: number): Random {
  const next = mulberry32(seed);
  const int = (max: number) => Math.floor(next() * max);
  return {
    next,
    int,
    pick: (list) => {
      if (!list.length) throw new Error('pick() from an empty list');
      return list[int(list.length)]!;
    },
    shuffle: (list) => {
      const copy = [...list];
      for (let index = copy.length - 1; index > 0; index--) {
        const other = int(index + 1);
        [copy[index], copy[other]] = [copy[other]!, copy[index]!];
      }
      return copy;
    },
  };
}

export function runFuzz<Input>(config: FuzzConfig<Input>): FuzzFailure<Input> | undefined {
  for (let runIndex = 0; runIndex < config.runs; runIndex++) {
    const runSeed = mixSeed(config.seed, 'run', runIndex);
    const input = config.generate(createRandom(runSeed));
    const violations = config.check(input);
    if (!violations.length) continue;
    const rule = violations[0]!.rule;
    const shrunk = config.shrink(input, (candidate) => config.check(candidate).some((found) => found.rule === rule));
    return {seed: config.seed, runIndex, runSeed, input, shrunk, violations};
  }
  return undefined;
}

// The assertion message is the only output CI shows for a failing test, so it carries the replay line.
export function describeFailure<Input>(failure: FuzzFailure<Input>, specPath: string, show: (input: Input) => string): string {
  return [
    `fuzz failure at run ${failure.runIndex} (run seed ${failure.runSeed})`,
    ...failure.violations.map((violation) => `  [${violation.rule}] ${violation.message}`),
    `replay: MULTIFRONT_FUZZ_SEED=${failure.seed} MULTIFRONT_FUZZ_RUNS=${failure.runIndex + 1} pnpm devx test ${specPath}`,
    'input:',
    show(failure.input),
    'shrunk:',
    show(failure.shrunk),
  ].join('\n');
}
