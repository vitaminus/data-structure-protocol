# `.dsp` Export Format (v2)

Export root:

- `.dsp/export/entities.txt`
- `.dsp/export/relations.txt`
- `.dsp/export/unresolved.txt`
- `.dsp/export/summary.json`

The export is deterministic (sorted output) and review-friendly for git diffs.

JSONL export root (`dsp export --format jsonl`):

- `.dsp/jsonl/entities.jsonl`
- `.dsp/jsonl/relations.jsonl`
- `.dsp/jsonl/unresolved.jsonl`
- `.dsp/jsonl/manifest.json`

Each JSONL row is one full graph record. Rows are sorted deterministically by UID or relation key, and the manifest records file names plus row counts.

Canonical source of truth remains SQLite (`.dsp/dsp.sqlite`).
