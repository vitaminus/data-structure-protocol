# Architecture

## Packages

- `packages/core`: graph schema, storage, indexer, semantic, impact, validation
- `packages/cli`: `dsp` CLI
- `packages/mcp-server`: MCP tool surface
- `packages/language-*`: language adapters

## Data flow

1. Discover files with ignore rules + `.gitignore`
2. Select language adapter
3. Parse files and extract entities/relations/unresolved refs with concurrency capped by `performance.parallelism`
4. Commit parsed file results to SQLite sequentially with source-priority merge
5. Store file hash for incremental updates
6. Expose graph through CLI and MCP

The parse/extract phase may complete files in a different order when `performance.parallelism` is greater than 1. SQLite commits remain serial and deterministic in discovered-file order.

## Storage

SQLite is canonical. `.dsp` and JSON are exports. Secondary lookup surfaces such as `entity_fts` are rebuilt automatically through schema migrations and are not the source of truth.

Tables:

- `entities`
- `relations`
- `file_hashes`
- `index_runs`
- `annotations`
- `embeddings`
- `unresolved_references`
- `checkpoints`
- `entity_fts`

Search and context-pack graph slicing first narrow candidates in SQLite, then use JavaScript for graph-aware reranking and response shaping.
