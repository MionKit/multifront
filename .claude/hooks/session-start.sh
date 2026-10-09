#!/usr/bin/env bash
# Read-only env check for Claude Code on the web: reports missing tools, never installs anything, always exits 0.
set -uo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

REPO="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PNPM_PIN="$(sed -n 's/.*"packageManager": *"pnpm@\([0-9.]*\)".*/\1/p' "$REPO/package.json" | head -1)"
fails=0
lines=()
pass() { lines+=("  OK      $1"); }
miss() { lines+=("  MISSING $1"); fails=$((fails + 1)); }

if command -v node >/dev/null 2>&1; then
  nv="$(node -p 'process.versions.node')"
  [ "${nv%%.*}" -ge 26 ] && pass "node $nv (>= 26)" || miss "node $nv (need >= 26)"
else miss "node (not on PATH)"; fi
pv="$(cd "$REPO" && pnpm --version 2>/dev/null)"
[ "$pv" = "$PNPM_PIN" ] && pass "pnpm $pv" || miss "pnpm ${pv:-not on PATH} (need $PNPM_PIN)"
if [ -f "$REPO/node_modules/.modules.yaml" ] && [ "$REPO/node_modules/.modules.yaml" -nt "$REPO/pnpm-lock.yaml" ]; then
  pass "node_modules"
else miss "node_modules (missing or older than pnpm-lock.yaml)"; fi
[ "$(git -C "$REPO" config --get core.hooksPath)" = ".husky/_" ] && pass "husky git hooks" || miss "husky git hooks"

echo "multifront env check:"
printf '%s\n' "${lines[@]}"
[ "$fails" -eq 0 ] || echo "  => $fails missing. Run: bash scripts/setup-claude-web.sh (see SETUP.md)"
exit 0
