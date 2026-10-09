---
name: fuzzy-testing
description: Add a fuzz or property test, rules first. Use when adding a fuzz test or a unit test over random inputs.
---

# Fuzzy testing: guide the user through it

Use [the tool mapping](../TOOLS.md) for assistant-specific calls and fallbacks.

Use when helping add a fuzz / property test, or proposing one for a good candidate you spotted.
Job: guide a short discovery, not recite a method. Investigate their repo, ask focused questions, iterate.
End state: the rules worth checking, the tools to check them, a running test.
User brings domain knowledge (what "correct" means for their code). You bring the method, the digging, the writing.
You drive.

## How to run it

- Investigate before you ask: read the code, grep existing tests + input generators, see how the code is called.
- Come with findings, then ask. Blank ("what are your invariants?") wastes time.
  Grounded ("you have `encode` and `decode`: should decoding an encode give the value back?") moves fast.
- One focused question at a time. Guide, don't interrogate.
- Iterate, esp. rules (step 3) + tools (step 4). You won't get the full list in one pass.
  Propose a few from what you found, user confirms/corrects, refine, come back for more.
- Stay grounded: every rule + tool points at something real: their code, an existing test, a stated promise, a past bug.
- ⚠️ Hold the line on soundness: a red test must mean a real bug. Keep reminding the user.
  Prove each rule: break the output on purpose, watch it fire.

## Start here: new, or grow an existing test?

1. First move, before anything else, ask the user:
   "Define a **new fuzz test from scratch**, or start from a **test (or one behaviour / bug) you already have**?"
2. Existing test or concrete behaviour → [shortcut: grow it](worksheet-C.md) first, then steps 4 + 5.
   Best possible start: it gives the boundary (step 1) + a first cut of the rules (step 3) for free.
3. New (code only, no test yet) → steps 1 to 5 in order.
4. Unsure which → grep tests already exercising this code, bring findings to the user.

Steps 1-3 = conversation + investigation. Steps 4-5 = building.

## Step 1: Pin down what you test and what you can see

Detail → [worksheet-A.md](worksheet-A.md).

- Ask which code the user wants to trust more. Steer to smallest thing callable directly (faster runs, sharper rules).
- Read it, note signature, work out how it's reached: plain function, CLI, server, filesystem?
- List what you can observe. Tell the user, confirm nothing's missing: rules check only what you see.
- Land on one agreed thing: a callable boundary with a watchable output.

## Step 2: Decide together if it's worth fuzzing

- Run the three-question gut-check in [worksheet-A.md](worksheet-A.md) out loud with the user.
- Any answer no → say so plainly, suggest a few hand-written examples instead.
- Talking someone _out_ of fuzzing when it doesn't fit is part of the job.

## Step 3: Discover the rules (the heart), iterate

- A back-and-forth, not a form filled once. Prompt list + loop → [worksheet-B.md](worksheet-B.md).
- Harvest existing test assertions, walk the rule shapes, ground each rule (drop guesses),
  set up the iron rule (negative control).

## Step 4: Inventory the tools, build only the gaps, iterate

Detail → [worksheet-A.md](worksheet-A.md) + the templates below.

- Look before you build: grep for an input maker / mock generator, seeded random source, test runner, shrinker.
- Report what's there so you don't rebuild it.
- Pick the input maker with the user from worksheet-A's list. Propose, confirm, adjust.
- Fill the gap list together, build only what's missing.
- Wire the step-3 rules into the loop (templates: oracle-layer, seeded-runner).

## Step 5: Run it hard, pin what breaks

- Run thousands of inputs. Each failure → shrink to smallest input, SAVE it as an ordinary test.
- Show the user that minimal reproducer: the most convincing thing you'll produce.
- Clean run over thousands of tries is also a result. Tell the user what confidence they gained.

## Templates to adapt

- [`templates/oracle-layer.ts`](templates/oracle-layer.ts): rule-checks in one place.
  Each returns a replayable failure record or nothing.
- [`templates/seeded-runner.ts`](templates/seeded-runner.ts): replayable loop, run-it-a-lot mode, shrinker.
- No extra libraries needed (this repo has no fast-check). fast-check available → it can replace the loop + shrinker;
  rule-checks stay the same.

## Done when you and the user have

- A clear boundary and what you can observe.
- The rules written down: at least one strong rule + the "doesn't crash" floor.
- Each rule grounded and proven by a negative control.
- A runner you can replay from a seed.
- At least one saved failing input, or a clean run over thousands of inputs.

## Good first candidates (planned in docs/milestones/, fuzz them as they land)

- Block splitter: the blocks join back into the exact file.
- Scope step: removing the ranges it added gives the original text.
- Position maps: a mapped character is the same character in the `.ucf` file.
