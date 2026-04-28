#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
ROOT="$(cd "$ROOT" && pwd)"
HOOKS_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DST="$ROOT/.git/hooks"

if [[ ! -d "$ROOT/.git" ]]; then
  echo "error: $ROOT is not a git repository" >&2
  exit 1
fi

mkdir -p "$HOOKS_DST"
for file in dsp-hook-lib.sh dsp-check-staged.sh dsp-agent-review.sh pre-commit pre-push; do
  cp "$HOOKS_SRC/$file" "$HOOKS_DST/$file"
  chmod +x "$HOOKS_DST/$file"
  echo "installed $HOOKS_DST/$file"
done

cat <<'INFO'
DSP hooks installed.

Environment flags:
  DSP_HOOK_SKIP=1              skip all DSP hooks
  DSP_HOOK_AUTO_UPDATE=1       auto-run dsp update --changed-only in pre-commit
  DSP_HOOK_REQUIRE_MARKERS=1   fail if missing @dsp markers are detected
  DSP_HOOK_EXPORT_PROTOCOL=0   skip protocol export during pre-push
  DSP_HOOK_RUN_TESTS=1         run pnpm test during pre-push
INFO
