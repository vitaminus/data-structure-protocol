# CLI

## Core commands

- `dsp init`
- `dsp index [path]`
- `dsp bootstrap [path]`
- `dsp update --from-git-diff`
- `dsp changed`
- `dsp search "<query>"`
- `dsp graph <uid-or-path> --depth 2 --max-entities 100 --max-relations 250 --max-files 20`
- `dsp impact <uid-or-path>`
- `dsp validate`
- `dsp repair --dry-run`
- `dsp export --format json|jsonl|dsp|protocol`
- `dsp import <graph.json>`
- `dsp mcp`

## CI commands

- `dsp precommit-check`
- `dsp ci check`
- `dsp ci impact`
- `dsp ci context-summary`

Most commands support `--json` for machine output.

## Embeddings

Embeddings are disabled by default in `.dsp/config.json`. When enabled, CLI, MCP semantic search, and context packs share the same provider policy.

- `provider: "mock"` uses deterministic local embeddings for tests and offline workflows.
- `provider: "openai-compatible"` reads `baseUrl`, `model`, and an API key from `apiKeyEnv` (default `DSP_EMBEDDINGS_API_KEY`) or `OPENAI_API_KEY`.
