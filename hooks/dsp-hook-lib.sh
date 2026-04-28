#!/usr/bin/env bash
set -euo pipefail

DSP_ROOT="${DSP_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
DSP_JSON_DIR="${DSP_JSON_DIR:-$DSP_ROOT/.dsp/reports}"
mkdir -p "$DSP_JSON_DIR"

_dsp_cmd() {
  if command -v pnpm >/dev/null 2>&1 && [[ -f "$DSP_ROOT/package.json" ]]; then
    (cd "$DSP_ROOT" && pnpm dsp "$@")
  elif command -v npm >/dev/null 2>&1 && [[ -f "$DSP_ROOT/package.json" ]]; then
    (cd "$DSP_ROOT" && npm run dsp -- "$@")
  elif command -v dsp >/dev/null 2>&1; then
    (cd "$DSP_ROOT" && dsp "$@")
  else
    echo "error: cannot find pnpm/npm/dsp to run DSP commands" >&2
    return 127
  fi
}

_dsp_changed_files() {
  git -C "$DSP_ROOT" diff --name-only --cached --diff-filter=ACMR 2>/dev/null || true
  git -C "$DSP_ROOT" diff --name-only --diff-filter=ACMR 2>/dev/null || true
}

_dsp_has_code_changes() {
  _dsp_changed_files | grep -E '\.(ts|tsx|js|jsx|mjs|cjs|py|rb|rs)$|(^|/)Cargo\.toml$|(^|/)Gemfile(\.lock)?$' >/dev/null 2>&1
}

_dsp_validation_error_count() {
  local file="$1"
  node -e 'const fs=require("fs"); const p=process.argv[1]; const r=JSON.parse(fs.readFileSync(p,"utf8")); console.log(r.summary?.errors ?? 0);' "$file"
}

_dsp_json_pretty_print() {
  local file="$1"
  node -e 'const fs=require("fs"); const p=process.argv[1]; console.error(JSON.stringify(JSON.parse(fs.readFileSync(p,"utf8")), null, 2));' "$file"
}
