#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=dsp-hook-lib.sh
source "$SCRIPT_DIR/dsp-hook-lib.sh"

TASK="${1:-Review current code changes}"
REPORT_DIR="$DSP_JSON_DIR/agent-review"
mkdir -p "$REPORT_DIR"

echo "DSP: generating agent review pack"
_dsp_cmd changed "$DSP_ROOT" --json > "$REPORT_DIR/changed.json"
_dsp_cmd ci impact "$DSP_ROOT" --json > "$REPORT_DIR/impact.json"
_dsp_cmd ci context-summary "$DSP_ROOT" --task "$TASK" --json > "$REPORT_DIR/context.json"
_dsp_cmd validate "$DSP_ROOT" --json > "$REPORT_DIR/validate.json"

cat > "$REPORT_DIR/README.md" <<EOF
# DSP Agent Review

Task: $TASK

Generated files:

- changed.json — git-aware changed indexed files
- impact.json — impact analysis for changed files
- context.json — bounded context pack for review
- validate.json — graph validation result

Recommended agent prompt:

> Use these DSP reports as the primary project context. Review the changed files, impacted entities, affected tests, and validation issues before editing.
EOF

echo "DSP: review reports written to $REPORT_DIR"
