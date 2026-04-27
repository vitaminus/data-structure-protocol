# Architecture

## Packages

- `packages/core`: graph schema, storage, indexer, semantic, impact, validation
- `packages/cli`: `dsp` CLI
- `packages/mcp-server`: MCP tool surface
- `packages/language-*`: language adapters

## Data flow

1. Discover files with ignore rules + `.gitignore`
2. Select language adapter
3. Parse file and extract entities/relations/unresolved refs
4. Upsert into SQLite with source-priority merge
5. Store file hash for incremental updates
6. Expose graph through CLI and MCP

## Storage

SQLite is canonical. `.dsp` and JSON are exports.

Tables:

- `entities`
- `relations`
- `file_hashes`
- `index_runs`
- `annotations`
- `embeddings`
- `unresolved_references`
- `checkpoints`
