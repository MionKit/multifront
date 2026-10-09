#!/usr/bin/env bash
# Read-only env check for Claude Code on the web: reports missing tools, never installs anything, always exits 0.
set -uo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

REPO="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
fails=0
lines=()
pass() { lines+=("  OK      $1"); }
miss() { lines+=("  MISSING $1"); fails=$((fails + 1)); }

if command -v node >/dev/null 2>&1; then
  nv="$(node -p 'process.versions.node')"
  [ "${nv%%.*}" -ge 26 ] && pass "node $nv (>= 26)" || miss "node $nv (need >= 26)"
else miss "node (not on PATH)"; fi
command -v pnpm >/dev/null 2>&1 && pass "pnpm $(pnpm --version 2>/dev/null)" || miss "pnpm"
[ -d "$REPO/node_modules" ] && pass "node_modules" || miss "node_modules (run: pnpm install)"

echo "multifront env check:"
printf '%s\n' "${lines[@]}"
[ "$fails" -eq 0 ] || echo "  => $fails missing. See SETUP.md."
exit 0
