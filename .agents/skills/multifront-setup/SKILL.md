---
name: multifront-setup
description: Install or verify Node 26, pnpm and every package for Claude Code on the web. Use when setting up the env.
---

# multifront setup (Claude Code on the web)

- One script does it all: [scripts/setup-claude-web.sh](../../../scripts/setup-claude-web.sh).
  Node 26, pinned pnpm, `pnpm install`, husky git hooks, a Chromium for `pnpm devx docs-images`.
- No Go, no podman, no containers, no builds. Tests run from source.
- Local machines (macOS, other Linux): follow [SETUP.md](../../../SETUP.md) by hand.

## Run

From the repo root:

```bash
bash scripts/setup-claude-web.sh --check   # report only, exit 1 when something needs setup
bash scripts/setup-claude-web.sh           # install what is missing
pnpm devx check                            # prove it: everything CI runs
```

- Non-zero exit → stop, show the `ERR` lines to the user.
- Every step skips when already done. Safe to re-run.
- Never report the env as ready from `--check` alone when `pnpm devx check` has not run.

## Cached environment (setup script)

- Paste the whole script into the web environment's settings → **Setup script**.
  It runs before the session starts. The env cache keeps Node 26, the pnpm store and `node_modules`.
- The script must stay SELF-CONTAINED: it runs from a temp path, so it never sources another repo file.
- Bump `SETUP_DATE` at its top to force a fresh run after a change.
- Egress needed: `*.nodejs.org`, `registry.npmjs.org`.

## Why it does what it does

- Web image ships an older Node → nvm installs 26 (nodejs.org tarball fallback).
- The agent's shells skip `/etc/profile.d` → Node 26 bins are symlinked into `$HOME/.local/bin`,
  first on the inherited PATH.
- Node ≥ 25 has no corepack → pnpm is `npm install -g pnpm@<packageManager pin>`.
- `ignoreScripts` blocks husky's `prepare` → the script runs `pnpm exec husky` itself.
- Pinned Playwright may want a Chromium revision the image lacks → `.env` gets
  `MULTIFRONT_CHROMIUM_PATH=/opt/pw-browsers/chromium`.
- `.claude/hooks/session-start.sh` reruns a read-only check at every session start and points here on a miss.
