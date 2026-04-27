# `.dsp` Export Format (v2)

Export root:

- `.dsp/export/entities.txt`
- `.dsp/export/relations.txt`
- `.dsp/export/unresolved.txt`
- `.dsp/export/summary.json`

The export is deterministic (sorted output) and review-friendly for git diffs.

Canonical source of truth remains SQLite (`.dsp/dsp.sqlite`).
