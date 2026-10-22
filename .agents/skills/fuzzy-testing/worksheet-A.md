# Step 4: The tools you'll need

> Settle what's tested, then build only the tools the rules need: an input maker, a replay button (a seed),
> the loop, a shrinker. Also covers step 1 (what you test, what you can see) and step 2 (worth it?),
> settled with the user first. Throughout: look before you build, build only the gaps.

## Step 1 · Name the code and bound it (with the user)

- Ask the user for the smallest function or pipeline you can call directly in a test. Read it, write its signature down.
- Touches the outside world (CLI, server, filesystem) → wrap that boundary so it's callable like a plain function:
  `run(args, files) -> {stdout, exit, files, diagnostics}`.
- Side effects → thin wrapper hands them back as a value: `run(input) -> {result, files, diagnostics}`.
- Keep wrapping until it's clean and callable a million times.
- Land on one thing: code under test as `(In) -> Out` (smaller = faster runs + sharper rule).

## Step 1 · Work out what you can see

- List everything you can watch: return value, thrown error (+ its type), stdout / exit code, logs, files written,
  diagnostics list. Tell the user what you found.
- More you see → stronger rules. See enough to tell "clean" apart from "never ran".
- e.g. validator returning 0 findings _because the type failed to resolve_ looks identical to "valid".
  That blind spot makes a reject-bad-input rule pass for the wrong reason.

## Step 2 · Check it's worth fuzzing (ask the user)

Three-question check with the user, before building anything:

- Can we run the code over and over, fast, in a loop? (Usually visible from the code.)
- Is it repeatable, or can we force that? No loose randomness, clock or network you can't pin down (scan for them).
- Cheap way to tell right from wrong without redoing its work? This question kills most bad candidates.
  Ask straight: "if I hand you an output, how would you spot a wrong one without re-running the logic?"

Any answer no → stop, recommend a few hand-written examples instead.

## Step 4 · Pick the input maker with the user (the most important decision)

Ask: **how is a _valid_ input described?** The answer picks the approach. Propose one, confirm with the user.

- A schema / type the program reads at runtime → **DERIVE** inputs from it: zod-fast-check, or small hand-written maker.
- Only a written-down TS type → reflect it, or hand-write a small maker (`fc.Arbitrary<T>` / typia).
- Raw text / bytes → **MUTATE** real samples, splice junk into known-good inputs
  (e.g. `.front` files built from real block snippets).
- A SEQUENCE of operations (code with memory) → random LIST of actions + a small model of the state.
- Two coupled things that EVOLVE via edits → random list of EDIT events + a small model (build it).

Look first: grep for an input maker already in the repo. Report what's there before building anything.

- None yet in this repo. Inputs are real files (root AGENTS.md: no fake data) → MUTATE or recombine real fixtures.
- Need a valid side + an invalid side → build both: one keeps inputs valid, one breaks one spot provably.

## Step 4 · A replay button (the seed)

- List **every** randomness source the code or input maker touches: random number generator, `Date.now()`,
  filesystem, network, hash seeds, `Object` key order, `Set` / `Map` iteration order.
- Make each replayable from a single saved number (a seed). Repo trick ([seeded-runner](templates/seeded-runner.ts)):
  - `withSeededRandom(seed, fn)`: swaps `Math.random` for a seeded generator for one run, then restores it.
  - `mixSeed(base, label, i)`: fresh seed per run.

## Step 4 · Shrinking a failure

- Decide how to cut a failing input to its smallest form. fast-check does it automatically. By hand:
  - **smallest-prefix**: fewest first-K actions that still fail.
  - **drop-subsets**: remove chunks, see if it still fails.
  - **simplify-the-value**: shrink the input itself.
- Always keep the **seed** alongside the shrunk reproducer.

## Fill the gap list with the user (the hand-off)

Fill in together, then build only what's **missing**.

| Part             | Tool (existing or to build) | Exists? | Missing |
| ---------------- | --------------------------- | ------- | ------- |
| input maker      |                             |         |         |
| seed / replay    |                             |         |         |
| what you can see |                             |         |         |
| shrinking        |                             |         |         |

Rules should already come from [the rules worksheet (worksheet-B.md)](worksheet-B.md),
or from [grow an existing test (worksheet-C.md)](worksheet-C.md) if an example test exists.
