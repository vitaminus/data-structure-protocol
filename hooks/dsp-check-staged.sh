#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=dsp-hook-lib.sh
source "$SCRIPT_DIR/dsp-hook-lib.sh"

if ! _dsp_has_code_changes; then
  echo "DSP: no staged/working code changes detected; skipping staged check"
  exit 0
fi

if [[ "${DSP_HOOK_AUTO_UPDATE:-0}" == "1" ]]; then
  echo "DSP: updating graph from changed files"
  _dsp_cmd update "$DSP_ROOT" --changed-only --json > "$DSP_JSON_DIR/update.json"
fi

echo "DSP: running impact analysis for changed files"
_dsp_cmd ci impact "$DSP_ROOT" --json > "$DSP_JSON_DIR/impact.json"

echo "DSP: checking marker drift"
_dsp_cmd markers apply "$DSP_ROOT" --dry-run --json > "$DSP_JSON_DIR/markers-dry-run.json"

if [[ "${DSP_HOOK_REQUIRE_MARKERS:-0}" == "1" ]]; then
  marker_count=$(node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(r.markersInserted||0);' "$DSP_JSON_DIR/markers-dry-run.json")
  if [[ "$marker_count" != "0" ]]; then
    echo "DSP: missing stable @dsp markers; run: pnpm dsp markers apply" >&2
    _dsp_json_pretty_print "$DSP_JSON_DIR/markers-dry-run.json"
    exit 1
  fi
fi

echo "DSP: staged check complete; reports in $DSP_JSON_DIR"
