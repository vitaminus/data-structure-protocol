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
