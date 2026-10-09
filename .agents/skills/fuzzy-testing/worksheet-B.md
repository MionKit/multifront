# Step 3: What should always be true? (the rules)

> You facilitate the rules discovery, the heart of the whole thing. Run it as a LOOP, not a one-pass form:
> investigate, propose a few rules grounded in the user's code, user confirms/corrects, refine, come back for more.
> User knows what "correct" means here. You know the rule shapes and the codebase.

## Start by harvesting what's already there

- Grep existing example/unit tests of this code. Their assertions are candidate rules already: bring them to the user.
- Ask the user, in plain English, what the code promises. Each promise = candidate rule.
  e.g. "if you decode what you encoded, you get the value back"; "an unknown field is rejected".

## Walk the rule-shape checklist with the user (this is the loop)

- Per shape: ask a pointed question grounded in THEIR code, propose the rule in their terms, user confirms/corrects.
- e.g. "should running this twice change nothing the second time?", "what inputs are illegal here, what should happen?"
- Keep the shapes that fit (most code matches three to five).
- Not all in one pass: offer a few, get reactions, refine, come back for the rest.

Per shape: the question to ask, then an example.

- ① **never crashes**: never crashes or hangs; only _controlled_ outcomes?
  - e.g. `decode(junk)` throws `DecodeError`, not `RangeError`.
- ② **do it then undo it**: does undoing it give back what you started with?
  - e.g. `encode(decode(w)) === w`.
- ③ **doing it twice**: does a second pass change nothing? `f(f(x)) === f(x)`?
  - e.g. a second `--update` is byte-identical.
- ④ **a fact always holds**: is some fact about the output always true?
  - e.g. output re-validates; a length or bound holds.
- ⑤ **compare to a trusted source**: does it match a second, trusted way to get the answer?
  - e.g. vs `JSON.parse`, vs the previous implementation.
- ⑥ **predicted change**: does a known input change cause the output change you predicted?
  - e.g. add a field ⇒ exactly that node appears.
- ⑦ **leave the rest alone**: does an unrelated change leave everything else untouched?
  - e.g. an authored value survives an unrelated edit.
- ⑧ **reject bad input**: is a _bad_ input always reported, never quietly accepted?
  - e.g. unknown field ⇒ a specific diagnostic (enrich-mock-unknown-field/enrich-text-unknown-field).

After a pass, ask: "anything I'm missing that should always hold here?" Stop when the shapes that fit are covered.

## Pin down where each rule came from

- Per kept rule, ask the user its source: a spec, a code comment, a past bug, or a guess.
- Drop the guesses. An invented rule is the main cause of false alarms.

## ⚠️ Set up the iron rule (tell the user, then prove it)

- Set it up now, in step 3. Non-negotiable.
- Tell the user plainly: a rule going red must mean a REAL bug, every time.
  Missing a bug only costs coverage. Crying wolf (red when nothing is wrong) destroys trust in the whole suite.
- Prove each rule you'll fail the build on: break the expected output on purpose, watch it go red with the right signal.
- A rule never watched failing isn't trustworthy yet.
- e.g. enrich fuzzer: asserted a bogus code `enrich-mock-bogus`, watched it fail + shrink to one event.
  Proof the check was live, not passing for the wrong reason.

## Prefer strong rules, and check your inputs reach the case

- Steer toward strong rules (do-it-then-undo-it, compare-to-a-trusted-source, predicted-change) over weak
  "doesn't crash". Always keep "doesn't crash" (①) as the floor.
- Before trusting a rule, confirm the input maker reaches the situation the rule talks about.
  - Reject-bad-input (⑧) needs _invalid_ inputs (`mutateToInvalid`).
  - A rule about cycles needs a maker that builds cycles.
- Rule over inputs your maker never produces → passes for the wrong reason, tells you nothing.

## Gather the rules in one place (what you hand to step 4)

- One `check*(target, value, ctx) -> Violation | null` per rule.
  See [`templates/oracle-layer.ts`](templates/oracle-layer.ts).
- Collect them behind one typed `FuzzTarget` (handshake between input maker and rules).
- Share one set of rule-checks between example and fuzz tests, so the two can't drift apart.
  Same helper, called once with hand-written data (example), once with generated data (fuzz).
- In this repo `test/util/*Asserts.ts` files are that shared layer. Fuzz checks currently _mirror_ them;
  sharing is the cleaner end state.
