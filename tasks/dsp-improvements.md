# DSP Improvement Tasks

## 1. Deduplicate graph neighbor traversal

Status: done

- Update `getNeighbors` to avoid revisiting nodes at deeper traversal levels.
- Deduplicate returned relations.
- Add regression coverage for `depth > 1`.

## 2. Respect empty git diffs for incremental indexing

Status: done

- When `changedOnly` or `fromGitDiff` is enabled and git returns no changed files, index zero files.
- Keep full indexing behavior unchanged when incremental mode is not requested.
- Add coverage for clean git repositories.

## 3. Add SQLite indexes for graph lookups

Status: done

- Add indexes for frequent relation endpoint lookups.
- Add indexes for entity path/kind lookups.
- Add coverage that schema initialization creates the expected indexes.

## 4. Implement context pack request options

Status: done

- Honor `includeTests` when collecting context tests.
- Honor `strategy` presets for file/depth sizing.
- Add code payload support for `includeCode`.

## 5. Improve lexical search ranking

Status: done

- Tokenize camelCase, snake_case, paths, and punctuation more consistently.
- Boost exact name/path matches over substring matches.
- Add lightweight graph-neighbor signal to lexical scoring.

## 6. Reduce stale/dangling graph edges in incremental indexing

Status: done

- Remove graph entities, relations, unresolved references, and file hashes for files deleted in a git diff.
- Canonicalize extensionless/internal file import relations to discovered files before storage.
- Preserve Python relative import levels so `from .module import x` resolves to the local module path.

## 7. Make file indexing writes atomic

Status: done

- Add a database transaction helper for grouped graph mutations.
- Wrap deleted-file cleanup and per-file index writes in SQLite transactions.
- Add rollback coverage so a failed relation write cannot leave partially refreshed file graph data.

## 8. Use TypeScript module resolution for internal imports

Status: done

- Resolve relative TypeScript/JavaScript imports through the TypeScript compiler resolver when files are available.
- Honor nearby `tsconfig.json` compiler options before falling back to deterministic path heuristics.
- Add coverage for extensionless `./module` imports resolving to real `.ts` files.

## 9. Improve Rust module and `use` resolution

Status: done

- Resolve `mod name;` declarations to sibling `name.rs` or `name/mod.rs` files when present.
- Resolve `crate::`, `self::`, `super::`, and sibling `use` paths to existing module files before falling back.
- Add coverage for `pub mod user`, `use user::User`, and `use crate::user::User` resolving to `src/user.rs`.

## 10. Clean up orphaned graph data for renamed files

Status: done

- Parse `git diff --name-status` entries so renames preserve both old and new paths.
- Clear graph data and file hashes for old rename paths before indexing the new file path.
- Add coverage for `git mv` leaving no stale old-path entity behind.

## 11. Add severity and summaries to validation reports

Status: done

- Add `error`/`warning`/`info` severity to every validation issue.
- Add aggregate validation summaries with total/error/warning/info counts.
- Keep existing issue kinds while making CLI/API validation output easier for agents to triage.

## 12. Parse Ruby symbols with Ripper

Status: done

- Add a Ripper-backed lexer parser for Ruby classes, modules, methods, and mixins.
- Keep the regex parser as a safe fallback when Ruby/Ripper is unavailable.
- Add coverage for nested modules/classes, class methods, instance methods, and mixins.

## 13. Resolve Rails Zeitwerk constants

Status: done

- Infer conventional Rails constants from `app/models`, `app/controllers`, `app/services`, `app/jobs`, and `app/mailers` paths.
- Map constant references such as `User` and `UsersController` to likely Rails files via Zeitwerk naming conventions.
- Add low-confidence `uses` relations for constant-to-file dependencies with provenance metadata.
