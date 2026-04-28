# DSP v2 project memory

This project uses DSP v2: a local structural-semantic graph and context compiler for AI coding agents.

Recommended loop:
1. `pnpm dsp search "<task>"`
2. `pnpm dsp impact <file-or-uid>` before structural edits
3. edit code
4. `pnpm dsp update --changed-only`
5. `pnpm dsp validate`

For reviewable graph memory, run `pnpm dsp export --format protocol`.
