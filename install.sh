#!/usr/bin/env bash
set -euo pipefail

ROOT="$(pwd)"
AGENT="all"
SCOPE="project"
SKIP_BUILD=0
NO_INIT=0
WITH_HOOKS=0

usage() {
  cat <<'USAGE'
DSP v2 installer

Usage:
  ./install.sh [options]

Options:
  --agent <all|codex|claude|cursor|none>  Install agent guidance files (default: all)
  --global                              Install agent guidance in the user home directory
  --root <path>                         Project root (default: current directory)
  --skip-build                          Skip dependency install/build
  --no-init                             Do not run dsp init
  --with-hooks                          Install a git pre-commit validation hook
  -h, --help                            Show this help

Examples:
  ./install.sh
  ./install.sh --agent cursor --with-hooks
  ./install.sh --global --agent codex
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent) AGENT="${2:-}"; shift 2 ;;
    --global) SCOPE="global"; shift ;;
    --root) ROOT="${2:-}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --no-init) NO_INIT=1; shift ;;
    --with-hooks) WITH_HOOKS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

case "$AGENT" in all|codex|claude|cursor|none) ;; *) echo "Invalid --agent: $AGENT" >&2; exit 1 ;; esac

ROOT="$(cd "$ROOT" && pwd)"
cd "$ROOT"

echo "==> DSP installer"
echo "    root:  $ROOT"
echo "    agent: $AGENT"
echo "    scope: $SCOPE"

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    return 0
  fi
  echo "==> pnpm not found; trying to enable/install pnpm"
  if command -v corepack >/dev/null 2>&1; then
    corepack enable
    corepack prepare pnpm@10.17.0 --activate || true
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    if command -v npm >/dev/null 2>&1; then
      npm install -g pnpm@10.17.0
    else
      echo "error: pnpm/npm not found. Install Node.js and pnpm, then rerun." >&2
      exit 1
    fi
  fi
}

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  ensure_pnpm
  echo "==> Installing dependencies"
  pnpm install
  echo "==> Building packages"
  pnpm build
fi

if [[ "$NO_INIT" -eq 0 ]]; then
  echo "==> Initializing DSP"
  if command -v pnpm >/dev/null 2>&1; then
    pnpm dsp init "$ROOT" >/dev/null
  else
    npm run dsp -- init "$ROOT" >/dev/null
  fi
fi

agent_text() {
  cat <<'AGENT'
# DSP v2 project memory

This project uses DSP v2: a local structural-semantic graph and context compiler for AI coding agents.

Before larger code changes:
- run `pnpm dsp search "<task>"` to find relevant entities;
- run `pnpm dsp impact <file-or-uid>` before refactors;
- run `pnpm dsp validate` after indexing or edits;
- use `pnpm dsp export --format protocol` when a plain-text agent-readable graph is useful.

When code structure changes:
- run `pnpm dsp update --changed-only` or `pnpm dsp index . --changed-only`;
- keep `.dsp/dsp.sqlite` local unless the team intentionally shares it;
- prefer `.dsp/protocol` export for reviewable graph snapshots.
AGENT
}

install_codex() {
  local target
  if [[ "$SCOPE" == "global" ]]; then
    target="$HOME/.codex/AGENTS.md"
  else
    target="$ROOT/AGENTS.md"
  fi
  mkdir -p "$(dirname "$target")"
  if [[ -f "$target" ]] && grep -q "DSP v2 project memory" "$target"; then
    echo "==> Codex guidance already installed: $target"
  elif [[ -f "$target" ]]; then
    { echo; echo "---"; agent_text; } >> "$target"
    echo "==> Appended Codex guidance: $target"
  else
    agent_text > "$target"
    echo "==> Installed Codex guidance: $target"
  fi
}

install_claude() {
  local target
  if [[ "$SCOPE" == "global" ]]; then
    target="$HOME/.claude/AGENTS.md"
  else
    target="$ROOT/.claude/AGENTS.md"
  fi
  mkdir -p "$(dirname "$target")"
  agent_text > "$target"
  echo "==> Installed Claude guidance: $target"
}

install_cursor() {
  local target
  if [[ "$SCOPE" == "global" ]]; then
    target="$HOME/.cursor/rules/dsp.mdc"
  else
    target="$ROOT/.cursor/rules/dsp.mdc"
  fi
  mkdir -p "$(dirname "$target")"
  {
    echo "---"
    echo "description: DSP v2 structural memory and context compiler"
    echo "alwaysApply: true"
    echo "---"
    agent_text
  } > "$target"
  echo "==> Installed Cursor rule: $target"
}

if [[ "$AGENT" != "none" ]]; then
  [[ "$AGENT" == "all" || "$AGENT" == "codex" ]] && install_codex
  [[ "$AGENT" == "all" || "$AGENT" == "claude" ]] && install_claude
  [[ "$AGENT" == "all" || "$AGENT" == "cursor" ]] && install_cursor
fi

if [[ "$WITH_HOOKS" -eq 1 ]]; then
  if [[ -x "$ROOT/hooks/install-hooks.sh" ]]; then
    "$ROOT/hooks/install-hooks.sh" "$ROOT"
  elif [[ -d "$ROOT/.git" ]]; then
    echo "error: hooks/install-hooks.sh not found" >&2
    exit 1
  else
    echo "==> Skipping hooks: .git directory not found"
  fi
fi

echo "==> Done"
echo "Next: pnpm dsp bootstrap . --lazy && pnpm dsp validate"
