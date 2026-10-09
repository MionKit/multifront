# Style: caveman, exact

Write for an agent scanning fast. Fewest words that keep every fact.

## Rules

- One fact per bullet. One line per bullet. Wrap only if a token forces it.
- Fragments fine: "pnpm only. Never `npm install`."
- Drop: articles, "note that", "in order to", "it is important", "basically", hedges, praise.
- Drop: history, how we got here, restating the code, examples that repeat the rule.
- Keep why only when the rule looks wrong without it. One clause: "(else pnpm sees a cycle)".
- Keep symptoms an agent will match: exact error text, exit codes, log lines.
- Symbols ok: `→` (then / use / leads to), `=` (means), `+` (and), `/` (or).
- Imperative: "Run X", "Never Y". Not "You should consider running X".
- ⚠️ only for rules agents break. Max 3 per file.
- CAPS for one word max per bullet (NEVER, ONLY, BOTH).
- Lists beat tables unless 3+ columns of real data.
- Code block only for a command sequence agent copies. Single command → inline.
- Headings short: noun or job. "Containers", "Release", "Run tests".
- Pointer line shape: `- <topic>: [path](path). Read before <trigger>.`

## Before / after

Before:

```
[scripts/lib/env.mjs](scripts/lib/env.mjs) `REGISTRY` lists every env var the repo reads; `pnpm devx env`
prints it. Prefix project-owned vars with `MULTIFRONT_`. `.env` is local only; `.env.sample` lists the
user-settable ones.
```

After:

```
- Every env var the repo reads: `REGISTRY` in [scripts/lib/env.mjs](scripts/lib/env.mjs). `pnpm devx env` prints it.
- Prefix project-owned vars with `MULTIFRONT_`. `.env` is local only; `.env.sample` lists the user-settable ones.
```

Before:

```
Adding a package means adding it to `vitest.config.ts` AND to the root `tsconfig.json` references.
`pnpm devx typecheck` fails if you forget.
```

After:

```
- New package → add to `vitest.config.ts` AND root `tsconfig.json` references. Forget → `pnpm devx typecheck` fails.
```

Before (skill step):

```
Before you start editing anything, make sure you have read all of the rule sources in full, because the
later steps assume you know them and skipping this is the most common cause of a bad result.
```

After:

```
1. Read every rule source in full. Then edit.
```

## Never cut

- never / always / must rules, ⚠️ invariants, "looks like a cleanup but is not" warnings.
- Commands, flags, env vars, paths, versions, limits, counts.
- Order requirements ("before X", "after every Y").
- Who does what (which subagent, which job, which file owns a value).
- Gotchas with their fix.
