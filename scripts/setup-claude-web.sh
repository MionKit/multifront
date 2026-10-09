#!/usr/bin/env bash
# --- BUMP THIS DATE to force a fresh setup run (YYYY-MM-DD) -------------------
SETUP_DATE="2026-10-09"
# ----------------------------------------------------------------------------
set -uo pipefail

NODE_MAJOR_MIN=26

CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check)   CHECK_ONLY=1 ;;
    -h|--help) grep '^#' "${BASH_SOURCE[0]:-$0}" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $arg (try --help)" >&2; exit 1 ;;
  esac
done

FAILED=0
NEED=0

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mOK\033[0m  %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m   %s\n' "$*"; }
err()  { printf '  \033[31mERR\033[0m %s\n' "$*" >&2; }
# --check only: something a real run would install or fix
need() { warn "$*"; NEED=$((NEED + 1)); }
# node major version currently resolvable on PATH (0 if node absent)
node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# --- repo root ---------------------------------------------------------------
# As the web environment's SETUP SCRIPT this runs BEFORE Claude Code launches:
# $CLAUDE_PROJECT_DIR is usually unset, the CWD is often not the repo, and the
# script lives in a temp path (so BASH_SOURCE/.. is wrong). Probe the env var,
# CWD, this script's dir and the known web clone paths, then a shallow search.
_looks_like_repo() {
  [ -f "$1/package.json" ] && [ -f "$1/pnpm-workspace.yaml" ] \
    && grep -q '"name": *"multifront-monorepo"' "$1/package.json" 2>/dev/null
}
_resolve_repo_dir() {
  local cand d selfdir root pkg
  selfdir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
  for cand in "${CLAUDE_PROJECT_DIR:-}" "$PWD" "$selfdir/.." "$selfdir" \
              /home/user/multifront /root/multifront /workspace/multifront; do
    [ -n "$cand" ] || continue
    cand="$(cd "$cand" 2>/dev/null && pwd)" || continue
    _looks_like_repo "$cand" && { printf '%s' "$cand"; return 0; }
  done
  for root in /home /root /workspace /app /srv; do
    [ -d "$root" ] || continue
    while IFS= read -r pkg; do
      d="$(dirname "$pkg")"
      _looks_like_repo "$d" && { printf '%s' "$d"; return 0; }
    done < <(find "$root" -maxdepth 3 -name pnpm-workspace.yaml -not -path '*/node_modules/*' 2>/dev/null)
  done
  return 1
}
REPO_DIR="$(_resolve_repo_dir || true)"
if [ -z "$REPO_DIR" ]; then
  err "could not locate the multifront repo root."
  err "  CLAUDE_PROJECT_DIR='${CLAUDE_PROJECT_DIR:-<unset>}'  PWD='$PWD'"
  err "  searched those + this script's dir + /home /root /workspace /app /srv for package.json name multifront-monorepo."
  exit 1
fi

# pnpm version the repo pins via package.json "packageManager" (fallback if unparsable)
PNPM_PIN="$(sed -n 's/.*"packageManager": *"pnpm@\([0-9.]*\)".*/\1/p' "$REPO_DIR/package.json" 2>/dev/null | head -1)"
[ -n "$PNPM_PIN" ] || PNPM_PIN="11.8.0"

# -----------------------------------------------------------------------------
# 1. Node 26: install (nvm first, nodejs.org tarball fallback), then make it win
#    on PATH for the harness's NON-login shells via $HOME/.local/bin symlinks.
#    pnpm is pinned to the repo's packageManager.
# -----------------------------------------------------------------------------
provision_node() {
  bold "Node $NODE_MAJOR_MIN + pnpm $PNPM_PIN (repo requires node >= $NODE_MAJOR_MIN)"

  local noderoot=""
  if [ "$(node_major)" -ge "$NODE_MAJOR_MIN" ] && [ -x "/opt/node26/bin/node" ]; then
    ok "Node $(node --version) already active"
  elif [ "$CHECK_ONLY" = 1 ]; then
    need "Node $NODE_MAJOR_MIN not active (found major $(node_major)) - re-run without --check to install"
    return 0
  else
    # (a) prefer the image's nvm
    local nvm_dir="${NVM_DIR:-}" cand
    for cand in "$nvm_dir" /opt/nvm "$HOME/.nvm"; do
      [ -n "$cand" ] && [ -s "$cand/nvm.sh" ] && { nvm_dir="$cand"; break; }
    done
    if [ -n "$nvm_dir" ] && [ -s "$nvm_dir/nvm.sh" ]; then
      bold "Installing Node $NODE_MAJOR_MIN via nvm ($nvm_dir)"
      export NVM_DIR="$nvm_dir"
      # nvm.sh is not `set -u` safe
      set +u
      # shellcheck disable=SC1091
      . "$nvm_dir/nvm.sh"
      if nvm install "$NODE_MAJOR_MIN" >/dev/null 2>&1; then
        noderoot="$(dirname "$(dirname "$(nvm which "$NODE_MAJOR_MIN" 2>/dev/null)")")"
      fi
      set -u
    fi
    # (b) fallback: nodejs.org tarball
    if [ -z "$noderoot" ] || [ ! -x "$noderoot/bin/node" ]; then
      warn "nvm unavailable or failed - falling back to a nodejs.org tarball"
      local nodearch; case "$(uname -m)" in
        x86_64) nodearch=x64 ;; aarch64|arm64) nodearch=arm64 ;;
        *) err "unsupported arch $(uname -m) for Node auto-install"; FAILED=1; return 1 ;;
      esac
      local ver; ver="$(curl -fsSL "https://nodejs.org/dist/index.json" 2>/dev/null \
        | sed -n 's/.*"version":"v\('"$NODE_MAJOR_MIN"'\.[0-9.]*\)".*/\1/p' | head -1)"
      [ -n "$ver" ] || { err "could not resolve a Node $NODE_MAJOR_MIN release from nodejs.org"; FAILED=1; return 1; }
      local tarball="node-v${ver}-linux-${nodearch}.tar.xz"
      curl -fsSL "https://nodejs.org/dist/v${ver}/${tarball}" -o "/tmp/${tarball}" \
        || { err "Node tarball download failed"; FAILED=1; return 1; }
      rm -rf /opt/node26-dist && mkdir -p /opt/node26-dist
      tar -C /opt/node26-dist --strip-components=1 -xf "/tmp/${tarball}" \
        || { err "Node tarball extract failed"; FAILED=1; return 1; }
      noderoot="/opt/node26-dist"
    fi
  fi

  # Stable /opt/node26 symlink + PATH wiring even on the "already active" path,
  # so a re-run repairs a half-set-up container.
  if [ -n "$noderoot" ]; then
    ln -sfn "$noderoot" /opt/node26 || { err "could not create /opt/node26 symlink"; FAILED=1; return 1; }
  fi
  [ -x "/opt/node26/bin/node" ] || { [ "$CHECK_ONLY" = 1 ] && return 0; err "/opt/node26/bin/node missing after install"; FAILED=1; return 1; }
  if [ "$CHECK_ONLY" = 1 ]; then
    [ "$(/opt/node26/bin/pnpm --version 2>/dev/null)" = "$PNPM_PIN" ] && ok "Node $(node --version) active; pnpm $PNPM_PIN" \
      || need "pnpm $PNPM_PIN not installed for Node $NODE_MAJOR_MIN - re-run without --check"
    return 0
  fi

  # Node >= 25 ships no corepack, so install the pinned pnpm next to node26's npm.
  if [ "$(/opt/node26/bin/pnpm --version 2>/dev/null)" != "$PNPM_PIN" ]; then
    /opt/node26/bin/npm install -g --no-fund --no-audit "pnpm@$PNPM_PIN" >/dev/null 2>&1 \
      || { err "npm install -g pnpm@$PNPM_PIN failed"; FAILED=1; return 1; }
  fi

  # The harness runs NON-login shells that inherit PATH from the image and do
  # NOT source /etc/profile.d. $HOME/.local/bin is first on that inherited PATH
  # (ahead of /opt/node<xx>), so symlinking the node26 bins there makes
  # `node` / `pnpm` resolve to 26.
  local localbin="$HOME/.local/bin" exe; mkdir -p "$localbin"
  for exe in /opt/node26/bin/*; do ln -sfn "$exe" "$localbin/$(basename "$exe")"; done
  case ":$PATH:" in *":$localbin:"*) : ;; *) warn "$localbin is not on PATH - add it ahead of /opt/node<xx>/bin" ;; esac
  export PATH="$localbin:/opt/node26/bin:$PATH"

  # For LOGIN shells (e.g. an interactive terminal).
  if [ -w /etc/profile.d ]; then
    cat > /etc/profile.d/zz-node26.sh <<EOF
# multifront claude-web setup: prefer Node $NODE_MAJOR_MIN (repo requires >= $NODE_MAJOR_MIN)
export PATH="\$HOME/.local/bin:/opt/node26/bin:\$PATH"
EOF
    chmod 0644 /etc/profile.d/zz-node26.sh 2>/dev/null || true
  fi

  hash -r 2>/dev/null || true
  if [ "$(node_major)" -ge "$NODE_MAJOR_MIN" ]; then
    ok "Node $(node --version) active; pnpm $(cd "$REPO_DIR" && pnpm --version 2>/dev/null)"
  else
    err "Node still resolves to major $(node_major) after wiring - check \$HOME/.local/bin PATH precedence"
    FAILED=1
  fi
}

# -----------------------------------------------------------------------------
# 2. pnpm install --frozen-lockfile. Fills the pnpm store and node_modules, so
#    the environment snapshot taken after this script carries every package.
# -----------------------------------------------------------------------------
install_workspace_deps() {
  bold "Workspace deps (pnpm install --frozen-lockfile)"
  command -v pnpm >/dev/null 2>&1 || { err "pnpm missing (the Node step should have provided it)"; FAILED=1; return 1; }
  if [ -f "$REPO_DIR/node_modules/.modules.yaml" ] \
     && [ "$REPO_DIR/node_modules/.modules.yaml" -nt "$REPO_DIR/pnpm-lock.yaml" ]; then
    ok "node_modules up to date with pnpm-lock.yaml"; return 0
  fi
  [ "$CHECK_ONLY" = 1 ] && { need "workspace deps missing or older than pnpm-lock.yaml - re-run without --check"; return 0; }
  ( cd "$REPO_DIR" && CI=true pnpm install --frozen-lockfile ) && ok "workspace deps installed" \
    || { err "pnpm install failed"; FAILED=1; }
}

# -----------------------------------------------------------------------------
# 3. Wire husky's git hooks (commit-msg -> commitlint, pre-commit -> lint-staged).
#    `ignoreScripts` blocks husky's `prepare`, and core.hooksPath is per-clone
#    git state, so set it explicitly. Non-fatal (CI still gates).
# -----------------------------------------------------------------------------
wire_husky() {
  bold "husky git hooks (commit-msg -> commitlint, pre-commit -> lint-staged)"
  if [ "$(git -C "$REPO_DIR" config --get core.hooksPath 2>/dev/null || true)" = ".husky/_" ] \
     && [ -d "$REPO_DIR/.husky/_" ]; then
    ok "husky hooks already wired"; return 0
  fi
  [ "$CHECK_ONLY" = 1 ] && { need "husky hooks not wired - re-run without --check"; return 0; }
  [ -x "$REPO_DIR/node_modules/.bin/husky" ] || { warn "husky not installed - skipping"; return 0; }
  ( cd "$REPO_DIR" && pnpm exec husky >/dev/null ) && ok "husky hooks wired" \
    || warn "husky wiring failed - commits won't be checked locally (CI still gates)"
}

# -----------------------------------------------------------------------------
# 4. Chromium for `pnpm devx docs-images`. The pinned Playwright may expect a
#    browser revision the image does not ship; when it is missing, point
#    MULTIFRONT_CHROMIUM_PATH (local .env) at the image's preinstalled one.
# -----------------------------------------------------------------------------
wire_chromium() {
  bold "Chromium for docs-images"
  local want have="/opt/pw-browsers/chromium" envfile="$REPO_DIR/.env"
  want="$(cd "$REPO_DIR" && node -e "import('playwright').then(p => console.log(p.chromium.executablePath()))" 2>/dev/null || true)"
  if [ -n "$want" ] && [ -x "$want" ]; then ok "Playwright Chromium present ($want)"; return 0; fi
  if [ -n "${MULTIFRONT_CHROMIUM_PATH:-}" ] || grep -qE '^MULTIFRONT_CHROMIUM_PATH=.+' "$envfile" 2>/dev/null; then
    ok "MULTIFRONT_CHROMIUM_PATH already set"; return 0
  fi
  [ -x "$have" ] || { warn "no Chromium found - docs-images will need one (see SETUP.md)"; return 0; }
  [ "$CHECK_ONLY" = 1 ] && { need "MULTIFRONT_CHROMIUM_PATH not set - re-run without --check"; return 0; }
  printf 'MULTIFRONT_CHROMIUM_PATH=%s\n' "$have" >> "$envfile" && ok "MULTIFRONT_CHROMIUM_PATH=$have written to .env"
}

main() {
  bold "multifront - Claude Code on the web setup (rev $SETUP_DATE)$([ "$CHECK_ONLY" = 1 ] && echo '  [check-only]')"
  echo "  repo: $REPO_DIR"
  [ "$(uname -s)" = Linux ] || { err "This installer targets the Linux web container. Locally, follow SETUP.md."; exit 3; }

  provision_node
  install_workspace_deps
  wire_husky
  wire_chromium

  if [ "$CHECK_ONLY" = 1 ]; then
    [ "$NEED" = 0 ] && { bold "Env ready."; exit 0; }
    bold "$NEED item(s) need setup. Run: bash scripts/setup-claude-web.sh"; exit 1
  fi

  bold "Ready. Work from the repo root (this setup ran no tests):"
  echo "  pnpm devx --help    # every dev command"
  echo "  pnpm devx check     # everything CI runs"

  if [ "$FAILED" = 0 ]; then bold "Setup OK."; else bold "Setup incomplete - see ERR above."; exit 1; fi
}

main "$@"

# =============================================================================
# setup-claude-web.sh - one-shot, SELF-CONTAINED bootstrap for multifront on
# Claude Code on the web (the managed, ephemeral Linux container).
#
# THIS FILE MUST STAY SELF-CONTAINED. It is pasted verbatim into the web
# environment's "Setup script" field, so at runtime it is a lone script in a
# temp path: it must not source or call any other repo file. Duplicate logic
# rather than share it.
#
# What it does, no prompts:
#   1. Node 26 - the web image ships an older Node. Install via the image's nvm
#      (nodejs.org tarball fallback) and make it win on the harness's non-login
#      PATH by symlinking the bins into $HOME/.local/bin. pnpm is installed
#      with node26's npm, pinned to package.json "packageManager".
#   2. pnpm install --frozen-lockfile - every package lands in the pnpm store and
#      node_modules, which the environment cache keeps for later sessions.
#   3. husky git hooks (ignoreScripts blocks husky's `prepare`).
#   4. MULTIFRONT_CHROMIUM_PATH in .env when Playwright's own Chromium is missing.
#
# It runs NO tests or builds (tests run from source). BUMP SETUP_DATE to force
# the web env to re-run this from a clean container after an upstream change.
#
# Usage:  bash scripts/setup-claude-web.sh [--check]
# Exit:   0 ok | 1 a required step failed (--check: something needs setup) | 3 unsupported platform
#
# Egress: *.nodejs.org (Node), registry.npmjs.org (pnpm + packages).
# =============================================================================
