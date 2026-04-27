# DSP v2

DSP v2 is a local context compiler for AI coding agents.

It builds a deterministic structural-semantic graph of a repository, keeps it incrementally updated, and serves bounded context packs for coding tasks.

## Why not just grep?

- `grep`/`rg` is lexical only.
- DSP v2 adds typed entities, graph relations, provenance, confidence, and impact analysis.
- DSP v2 can return ranked task-focused context without sending full repo content to an LLM.

## Why not only vector DB?

- Vector DB is semantic but often weak on exact code structure.
- DSP v2 is deterministic first (AST/parser graph), then optional semantic ranking.
- Every claim stores provenance and confidence.

## 5-minute start

```bash
pnpm install
pnpm build
pnpm test

pnpm dsp init
pnpm dsp bootstrap . --lazy
pnpm dsp index ./examples/sample-app
pnpm dsp search "user authentication"
pnpm dsp impact src/auth/AuthService.ts
pnpm dsp validate
pnpm dsp export --format dsp
```

## Core capabilities

- Multi-language indexing (TS/JS, Python, Rust, Ruby)
- SQLite canonical graph storage
- JSON import/export + deterministic `.dsp/` export
- Incremental `update` and git-aware changed-file indexing
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
