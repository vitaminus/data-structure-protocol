# DSP v2 project memory

This project uses DSP v2: a local structural-semantic graph and context compiler for AI coding agents.

Before larger code changes:
- run `pnpm dsp search "<task>"` to find relevant entities;
- run `pnpm dsp impact <file-or-uid>` before refactors;
- run `pnpm dsp validate` after indexing or edits;
- use `pnpm dsp export --format protocol` for a plain-text agent-readable graph snapshot.

When code structure changes:
- run `pnpm dsp update --changed-only` or `pnpm dsp index . --changed-only`;
- keep SQLite as canonical local graph storage;
- prefer `.dsp/protocol` export for reviewable memory artifacts.
