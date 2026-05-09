# DSP

DSP is a local context compiler for AI coding agents.

It builds a deterministic structural-semantic graph of a repository, keeps it incrementally updated, and serves bounded context packs for coding tasks.

Supported local runtimes: Node.js 20.x or 22.x.

## Why not just grep?

- `grep`/`rg` is lexical only.
- DSP adds typed entities, graph relations, provenance, confidence, and impact analysis.
- DSP can return ranked task-focused context without sending full repo content to an LLM.

## Why not only vector DB?

- Vector DB is semantic but often weak on exact code structure.
- DSP v2 is deterministic first (AST/parser graph), then optional semantic ranking.
- Every claim stores provenance and confidence.

## Install

macOS/Linux:

```bash
./install.sh --agent all --with-hooks
```

Windows PowerShell:

```powershell
.\install.ps1 -Agent all -WithHooks
```

Installers can also write only one agent integration (`--agent cursor|claude|codex`) or user-level guidance (`--global`).

## 5-minute start

```bash
pnpm install
pnpm doctor
pnpm build
pnpm test

pnpm dsp init
pnpm dsp bootstrap . --lazy
pnpm dsp index ./examples/sample-app
pnpm dsp search "user authentication"
pnpm dsp impact src/auth/AuthService.ts
pnpm dsp validate
pnpm dsp export --format dsp
pnpm dsp export --format protocol
```

## Core capabilities

- Multi-language indexing (TS/JS, Python, Rust, Ruby)
- SQLite canonical graph storage
- JSON import/export + deterministic `.dsp/` export
- Incremental `update` and git-aware changed-file indexing, including `--base-ref` and `merge-base:<ref>` PR-mode diffs
- Impact analysis and stale-index validation
- MCP tools for agent integration (`dsp.get_context_pack`, search, impact, validate)

## Design principles

- Deterministic first
- Provenance everywhere
- Incremental by default
- Human editable
- Agent friendly JSON output
- Reviewable exports
- Safe failure with low-confidence marking
- Language-aware precision

## Benchmark tiers

- Pull requests run a fast smoke benchmark and compare against [bench/baselines/ci-smoke.json](/Users/vitaminus/projects/for%20llm/data-structure-protocol/bench/baselines/ci-smoke.json).
- Pushes to `main` run a wider medium benchmark gate and upload artifacts for regression review.
- Scheduled or manual runs execute the soak benchmark and upload the full result set.

Benchmark outputs track indexing latency, search/context-pack latency, retrieval recall, memory, DB size, and parser telemetry so hot-path changes stay measurable.

## Operational safety

- `pnpm doctor` checks the supported Node range, `better-sqlite3`, SQLite FTS5 capability, `tsx`, `python3`, and `ruby`.
- `pnpm doctor -- --json` returns the same runtime report in machine-readable form.
- `pnpm dsp doctor --json` returns the graph/database health report, including schema status, orphaned caches, stale parse-cache rows, stale checkpoints, and abandoned index runs.
- `pnpm dsp repair` is planning-only by default. Add `--apply` to write fixes.
- Destructive maintenance is opt-in: use `--clean-orphaned-file-hashes`, `--clean-orphaned-embeddings`, `--clean-stale-parse-cache`, `--clear-stale-checkpoints`, and `--fail-abandoned-runs` only when you want those repairs applied.
- `--clean-stale-parse-cache` and `--clear-stale-checkpoints` also remove corrupted rows discovered by `doctor`, not just old-but-well-formed entries.
- Oversize, binary, and invalid-UTF8 files are skipped safely and recorded in index telemetry instead of being dropped silently.
- `validate` reports binary and invalid-UTF8 indexed files as explicit warnings, and `context-pack` adds risk notes when code payloads are omitted for unreadable files.
