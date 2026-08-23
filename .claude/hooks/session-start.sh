#!/bin/bash
# SessionStart hook -- provisions a fresh Claude Code on the web container.
#
# Two jobs, in order of how badly you notice them missing:
#
#   1. backend/node_modules. Claude Code on the web starts each session in a
#      fresh container, so a previous session's `npm install` is gone. Without
#      this the very first `npm test` dies with "Cannot find module 'stripe'",
#      which reads like a code bug and isn't one.
#
#   2. gstack (github.com/garrytan/gstack). Its own installer puts it in
#      ~/.claude/skills/gstack -- outside the repo, which is the only thing
#      that survives a container swap -- and gstack deliberately refuses to be
#      vendored into a repo (bin/gstack-team-init deletes any vendored copy and
#      gitignores the path). It's also ~1.5GB installed. So the only honest way
#      to make it "permanent" is to reinstall it on each cold container, which
#      is what this does.
#
# Both steps are idempotent: on a warm container they cost a few seconds.
set -euo pipefail

# Local machines install their own tooling; this is strictly for the
# ephemeral web containers.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

REPO_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
GSTACK_DIR="$HOME/.claude/skills/gstack"
PW_ROOT="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"

echo "[session-start] provisioning container..."

# ---------------------------------------------------------------- backend ---
# `npm install` (not `ci`) on purpose: the container image is cached after
# this hook completes, so a warm start reuses node_modules and this is a
# near-no-op. `ci` would wipe and refetch every time.
if [ -f "$REPO_DIR/backend/package.json" ]; then
  echo "[session-start] installing backend dependencies..."
  npm install --prefix "$REPO_DIR/backend" --no-audit --no-fund
fi

# ----------------------------------------------------------------- gstack ---
# Everything below is best-effort. gstack is developer tooling, not something
# the app builds or tests against, so a network blip that breaks the clone
# must not block the session from starting -- hence the guard around the whole
# block rather than letting `set -e` abort the hook.
# NOTE ON ERROR HANDLING: this function is invoked as `if ! install_gstack`,
# and bash disables `set -e` for the entire body of a function called in a
# condition. So every step that must not silently fall through to the next one
# carries its own explicit `|| return 1`.
install_gstack() {
  command -v bun >/dev/null 2>&1 || {
    echo "[session-start] bun not found; skipping gstack." >&2
    return 1
  }

  if [ ! -f "$GSTACK_DIR/VERSION" ]; then
    echo "[session-start] cloning gstack..."
    rm -rf "$GSTACK_DIR"
    mkdir -p "$(dirname "$GSTACK_DIR")" || return 1
    git clone --single-branch --depth 1 \
      https://github.com/garrytan/gstack.git "$GSTACK_DIR" || return 1
  fi

  # gstack's setup runs `bun install` itself, but node_modules has to exist
  # *before* setup so browsers.json is there for bridge_chromium below.
  # Running it here first makes setup's own install a cache hit.
  if [ ! -d "$GSTACK_DIR/node_modules" ]; then
    echo "[session-start] installing gstack dependencies..."
    ( cd "$GSTACK_DIR" && bun install --frozen-lockfile ) || return 1
  fi

  bridge_chromium || true

  # Only run the (slow) setup when the generated skills aren't there yet.
  if [ ! -d "$GSTACK_DIR/.agents/skills" ]; then
    echo "[session-start] running gstack setup..."
    ( cd "$GSTACK_DIR" && ./setup --quiet ) || return 1
  fi

  echo "[session-start] gstack $(cat "$GSTACK_DIR/VERSION" 2>/dev/null || echo '?') ready"
}

# gstack bundles its own Playwright, which pins a Chromium revision newer than
# the one baked into this image, and `cdn.playwright.dev` is blocked by the
# egress proxy -- so gstack's setup cannot download the build it wants and its
# /browse skill is dead on arrival.
#
# The image does ship a working headless shell, just under an older revision
# number and the older `chrome-linux/headless_shell` layout. Symlinking it into
# the path Playwright probes makes setup's launch probe pass, which means setup
# skips the doomed download entirely (it's guarded by `if !
# ensure_playwright_browser`) instead of burning ~5 failed retries every run.
#
# The wanted revision is read out of Playwright's own browsers.json rather than
# hardcoded, so a future gstack bump doesn't silently strand this workaround.
#
# Caveat, deliberately accepted: this points a newer Playwright at an older
# Chromium. Verified working for navigation, JS evaluation, and accessibility
# snapshots; a newly-added CDP feature could still hit the version gap.
bridge_chromium() {
  local browsers_json="$GSTACK_DIR/node_modules/playwright-core/browsers.json"
  [ -f "$browsers_json" ] || return 0

  local have_shell
  have_shell=$(ls -d "$PW_ROOT"/chromium_headless_shell-*/chrome-linux/headless_shell 2>/dev/null | head -1 || true)
  [ -n "$have_shell" ] || return 0

  local want
  want=$(node -e '
    const p = process.argv[1];
    const b = require(p).browsers.find((x) => x.name === "chromium-headless-shell");
    process.stdout.write(b ? String(b.revision) : "");
  ' "$browsers_json" 2>/dev/null || true)
  [ -n "$want" ] || return 0

  local dest_dir="$PW_ROOT/chromium_headless_shell-$want/chrome-headless-shell-linux64"
  local dest="$dest_dir/chrome-headless-shell"
  if [ ! -e "$dest" ]; then
    echo "[session-start] bridging Chromium headless shell -> revision $want"
    mkdir -p "$dest_dir"
    ln -sfn "$have_shell" "$dest"
    touch "$PW_ROOT/chromium_headless_shell-$want/INSTALLATION_COMPLETE"
  fi
}

if ! install_gstack; then
  echo "[session-start] WARNING: gstack setup did not complete; continuing without it." >&2
fi

echo "[session-start] done."
