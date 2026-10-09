# Grow an existing test into a fuzz test

> The shortcut. User pointed you at an example/unit test (or one concrete behaviour to pin).
> Grow it into a fuzz test, keep both. A normal test already paid the three hardest costs:
> a valid input, a working way to call the code, a true check. Fuzz test = let each vary, so most work is done.
> Widen its input into the input maker, lift its check (true for one input) into a rule (true for all inputs).
> You get steps 1 and 3 mostly for free.

## Open the test and map its three parts

Read the user's test together. It is set-up, call, check (Arrange, Act, Assert). Each part maps straight across:

| Example test | → fuzz part | the edit |
| --- | --- | --- |
| **Set up** a literal input / fixture | input maker | vary the thing the author froze arbitrarily |
| **Call** the code | the code under test | **keep it as is**: it already works |
| **Check** `expect(out).toBe(literal)` | a rule | turn the constant into a rule that holds for all inputs |

Two of three are free. Only the check needs real thought (below).

## Read the inputs off the set-up

- Never invent an input space. Widen the one the test uses: find what the author froze
  (a value, a length, a field set, an order) and let it vary.
- Test has a `valid[]` and an `invalid[]` list → point it out: that split names your **two input makers**,
  one for the valid side, one that breaks one spot of a valid input (invalid side).
- **Table-driven** test: each row is a hand-found example; the row dimension is your input maker.

## Turn the check into a rule, with the user (the only hard part)

Grow what the test asserts into a rule that holds for ALL inputs. Pick the move by the check's shape:

- A **relation** already (do-it-then-undo-it / do-it-twice) → same relation over an input maker, _trivial_
  (swap the literal for the valid-side input maker).
- **true/false** on a hand-picked good/bad value → two input makers + the rule tying the code's outputs together.
- A **constant you can recompute** (`toBe(5)`) → compare against a trusted source,
  or the predicted-change relation it's an instance of.
- A **hardcoded "this once broke"** case → random inputs **around** that hazard.

Run the grown rule through the iron rule with the user: break the output on purpose, watch it go red.
A constant generalised lazily throws false alarms.

## Share the check between both tests

- Pull the test's check into a helper BOTH the example and fuzz test call.
- Never copy it into the fuzz runner: copies drift apart. See [the rules worksheet (worksheet-B.md)](worksheet-B.md).

## Keep the example, it's the fast reproducer and the floor

- Original test stays: fastest reproducer, executable intent, a 1 ms smoke test beside a long run.
- Fuzz failure shrinks to something **simpler** than the example → promote that smallest case to a new example test.
  The two feed each other.

## Tell the user when NOT to bother

- **Pure one-answer transforms** (deterministic `transform(input) === expected`, no error path):
  nothing to sweep, examples are enough.
- **Inputs the maker can't reach yet** (a cyclic value the default maker never produces): fix the input maker first,
  else the fuzz never contains the case and the rule passes for the wrong reason.

Test to apply: _is there a thing worth varying, and a rule that stays true as it varies?_
Yes → grow it. No → the example already is the right tool.
