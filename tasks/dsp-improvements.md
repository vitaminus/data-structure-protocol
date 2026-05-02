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

## 14. Map Rails routes to controller actions

Status: done

- Extract `to: "controller#action"` route targets and basic `resources :name` routes.
- Create `routes_to` relations from route entities to conventional controller action method UIDs.
- Add coverage for explicit HTTP routes and resource routes.

## 15. Improve Rust impl and visibility parsing

Status: done

- Track impl blocks with brace depth so nested function bodies do not pop impl context early.
- Support generic impl headers and Rust visibility modifiers such as `pub(crate)`.
- Add type-to-method `contains` relations for methods declared inside impl blocks.

## 16. Resolve Rust grouped use trees

Status: done

- Expand grouped imports such as `use crate::{db::Repo, user::User};` before resolution.
- Preserve per-expanded import provenance and unresolved reference reporting.
- Add coverage for grouped imports resolving to both `mod.rs` and sibling module files.

## 17. Extract Rust unit test entities

Status: done

- Detect `#[cfg(test)] mod ...` as test entities.
- Detect `#[test]`, `#[tokio::test]`, and `#[async_std::test]` functions as test entities.
- Add `tests` relations from Rust test entities back to the source file for impact/context packs.

## 18. Add Rust same-file call relations

Status: done

- Track callable scope with brace depth while scanning Rust functions and methods.
- Add low-confidence `calls` relations for same-file function/method invocations.
- Add coverage for a function calling another function in the same Rust file.

## 19. Capture Rust derive trait implementations

Status: done

- Detect `#[derive(...)]` attributes before structs and enums.
- Add external Rust trait interface entities for derived traits.
- Add `implements` relations from derived types to those trait entities without creating dangling graph edges.

## 20. Index ActiveRecord domain macros

Status: done

- Extract Rails model associations, validations, scopes, callbacks, and enums.
- Add domain macro entities and class containment relations.
- Add `depends_on` relations from model classes to associated model files.

## 21. Link Ruby test files to implementation files

Status: done

- Map RSpec files under `spec/models`, `spec/controllers`, `spec/services`, jobs, mailers, and lib to matching implementation paths.
- Map Minitest files under `test/models`, `test/controllers`, services, jobs, mailers, and lib to matching implementation paths.
- Add `test` entities and `tests` relations for Ruby test path conventions.

## 22. Add Bundler dependency awareness

Status: done

- Include `Gemfile` and `Gemfile.lock` in Ruby indexing.
- Extract gems as external dependency entities from Gemfile and lockfile formats.
- Add `depends_on` relations from Bundler files to external gem entities.

## 23. Extract TypeScript constants, arrow functions, and enums

Status: done

- Extract variable declarations as constants or functions when initialized with arrow/function expressions.
- Extract TypeScript enum declarations as type entities.
- Export relations now include exported constants, arrow functions, and enums.

## 24. Extract TypeScript inheritance relations

Status: done

- Add `extends` relations for classes and interfaces.
- Add `implements` relations for classes implementing interfaces.
- Add coverage for class inheritance, class interface implementation, and interface inheritance.

## 25. Add TypeScript same-file call relations

Status: done

- Track calls inside function declarations, arrow/function expressions, and class methods.
- Add low-confidence same-file `calls` relations to matching function/method entities.
- Add coverage for arrow functions and class methods calling a same-file function.

## 26. Link TypeScript test files to implementation files

Status: done

- Detect `.test.ts`, `.spec.ts`, `.test.tsx`, `.spec.tsx`, and `__tests__` path conventions.
- Add TypeScript `test` entities from adapter-level parsing.
- Add `tests` relations from test files to conventional implementation files.

## 27. Add Cargo manifest awareness

Status: done

- Include `Cargo.toml` in Rust repository indexing.
- Extract package crates, workspace members, and Cargo dependencies.
- Add external crate dependency entities and `depends_on` relations from manifests.

## 28. Link Cargo target files to crate roots

Status: done

- Detect integration tests under `tests/*.rs` and link them to `src/lib.rs` with `tests` relations.
- Detect examples, benches, and binary targets by Cargo path conventions.
- Add module entities and crate-root `depends_on` relations for examples, benches, and bins.

## 29. Extract Rust web route handlers

Status: done

- Detect route attributes such as `#[get("/path")]` and framework-qualified variants.
- Detect simple Axum `Router::route("/path", get(handler))` patterns.
- Add route entities and `routes_to` relations to handler functions.

## 30. Capture Rust cfg feature metadata

Status: done

- Detect `#[cfg(feature = "...")]` and `#[cfg_attr(feature = "...", ...)]` attributes.
- Attach feature-gate metadata to the next Rust item entity.
- Add coverage for cfg-gated structs and functions.

## 31. Index Rust macro_rules declarations

Status: done

- Detect `macro_rules! name` declarations as Rust callable entities.
- Mark macro entities with `rustKind: macro_rules` metadata.
- Reuse same-file call heuristics to connect macro invocations to macro declarations.

## 32. Add Rust imported function call relations

Status: done

- Track imported symbols from resolved `use` paths.
- When a call has no same-file target, link it to the imported module file as a low-confidence function call.
- Add coverage for `use crate::module::function; function();` cross-file call edges.

## 33. Export upstream-compatible protocol memory

Status: done

- Add a plain-text `.dsp/protocol` export with `obj-*`/`func-*` protocol IDs.
- Generate per-entity `description`, `imports`, `shared`, reverse `exports`, `TOC`, and `uid-map.json` files.
- Add CLI/API support for `dsp export --format protocol` while keeping SQLite canonical.

## 34. Add cross-agent installer scripts

Status: done

- Add macOS/Linux and Windows installers with dependency install, build, DSP init, and optional pre-commit hook setup.
- Install Codex, Claude, and Cursor agent guidance files at project or global scope.
- Add reusable integration templates and README install instructions.

## 35. Support stable source marker UIDs

Status: done

- Detect optional `@dsp obj-xxxxxxxx` / `@dsp func-xxxxxxxx` source markers during indexing.
- Promote marked entities to stable canonical UIDs and rewrite extracted relation endpoints.
- Teach query/impact/protocol export paths to accept protocol-style stable UIDs directly.

## 36. Add source marker insertion command

Status: done

- Add `dsp markers apply` to insert stable `@dsp` markers before indexed symbols.
- Support dry-run output for marker insertion.
- Add coverage for TypeScript marker insertion using generated protocol-style IDs.

## 37. Add richer DSP git hooks

Status: done

- Add reusable pre-commit and pre-push hooks with validation, impact, marker drift, and optional protocol export/test steps.
- Add agent review scripts that generate changed/impact/context/validation reports under `.dsp/reports`.
- Add hook installers for macOS/Linux and Windows, and wire the main installers to use them.

## 38. Add protocol-compatible navigation CLI commands

Status: done

- Add upstream-style commands: `get-entity`, `find-by-source`, `get-children`, `get-parents`, `get-path`, and `read-toc`.
- Add diagnostic commands: `get-stats`, `detect-cycles`, and `get-orphans`.
- Implement directed traversal, shortest path, cycle detection, source lookup, and graph stats on top of the SQLite graph.

## 39. Add manual graph mutation CLI commands

Status: done

- Add upstream-style manual commands: `create-object`, `create-function`, `create-shared`, `add-import`, `update-description`, `update-import-why`, `move-entity`, `remove-import`, `remove-shared`, and `remove-entity`.
- Add public database deletion helpers for manual relation/entity cleanup.
- Keep manual writes provenance-tagged as human/dsp-cli while preserving auto-index as the primary path.

## 40. Use configured parallelism during indexing

Status: done

- Split indexing into a parallel parse/extract phase and a sequential SQLite commit phase.
- Limit parse concurrency with `performance.parallelism` while keeping DB writes deterministic.
- Add integration coverage comparing graph snapshots for `parallelism=1` and `parallelism=4`.
- Add failure handling coverage so failed parses mark the run failed without partially refreshing the failing file.

## 41. Move search, validation, and graph slicing closer to SQLite

Status: done

- Add schema versioning and migrations for secondary indexes and `entity_fts`.
- Use SQLite/FTS to narrow lexical search candidates before JS reranking.
- Add targeted DB helpers for entity batches, relation neighborhoods, validation scans, and context-pack graph slices.
- Add migration, ranking, and synthetic stress coverage for large graphs.

## 42. Enable configured embeddings in ContextPack

Status: done

- Add a shared runtime embedding provider policy to `DSPServices`.
- Let `runSearch`, MCP semantic search, and ContextPack use the same provider/config behavior.
- Keep embeddings disabled by default for backward compatibility.
- Add dependency-aware `suggestedEditOrder` instead of returning the first selected files.
- Add deterministic mock-provider, invalidation, mixed-cache, and disabled-mode tests.

## 43. Build an integration and contract test matrix

Status: done

- Add representative multi-language fixtures and golden outputs for `.dsp/export` and `.dsp/protocol`.
- Cover init, index, search, impact, context pack, validate, export/import, markers, and MCP as an end-to-end system.
- Add changed-only update scenarios for rename, delete, and import graph changes.
- Split the suite into fast smoke tests and fuller integration coverage.

## 44. Add a formal benchmark suite and baseline JSON output

Status: done

- Add `bench/` fixtures, scripts, and baseline result files.
- Measure cold bootstrap, warm reindex, changed-only update, search, context-pack, validate, RSS, and SQLite size.
- Record results for multiple `performance.parallelism` values.
- Add retrieval-quality query sets for context-pack comparison.

## 45. Add GitHub Actions CI and coverage reporting

Status: done

- Add workflow jobs for lint/typecheck, unit tests, integration smoke tests, and build on Node 20/22.
- Add coverage artifact/report generation after the core suite is stable.
- Add a non-blocking benchmark smoke job once `bench/` exists.
- Keep local hook checks and server CI behavior aligned.

## 46. Consolidate API schemas and strengthen graph typing

Status: done

- Fix `dsp embeddings stats` to report embedding-specific stats instead of generic cache stats.
- Introduce shared CLI/MCP input schemas or validators to reduce surface drift.
- Add branded UID/helper types in a backward-compatible, staged way.
- Add CLI output snapshots, MCP schema snapshots, compile-time typing tests, and an embeddings stats regression test.

## 47. Add budgeted priority graph traversal

Status: done

- Replace unbounded depth-first neighbor expansion with priority-queue traversal in `getNeighbors`.
- Rank relations by explicit weight, confidence, and relation kind so high-signal edges survive tight budgets.
- Add `maxEntities` and `maxRelations` budgets to CLI and MCP neighbor queries.
- Apply budgeted, priority-ordered relation slicing to ContextPack graph expansion.
- Add regression coverage for hub-style graphs with tight traversal budgets.

## 48. Add batch-safe SQLite list operations

Status: done

- Replace large `WHERE uid IN (...)` call sites with shared chunking helpers.
- Cover `getEntitiesByUid`, relation endpoint queries, and AST cleanup paths that receive large UID lists.
- Preserve deterministic result ordering for callers that pass ordered UID arrays.
- Add scale tests that exceed SQLite variable limits without raising `too many SQL variables`.

## 49. Add content-hash-assisted rename reconciliation

Status: done

- Reconcile moved files and symbols by comparing file content hashes before deleting and recreating graph entities.
- Rewrite path-based UIDs, relations, unresolved references, file hashes, FTS rows, and embeddings when content matches.
- Preserve canonical path-based UID compatibility while turning exact renames into metadata-only graph updates.
- Add changed-only indexing coverage for exact renames and moved-and-edited files.

## 50. Add JSONL graph export format

Status: done

- Add `entities.jsonl`, `relations.jsonl`, and `unresolved.jsonl` export files with a compact manifest.
- Keep existing JSON and protocol exports backward-compatible.
- Add CLI/API format selection and documentation for the JSONL export.
- Add deterministic export/import coverage for large graph snapshots.

## 52. Introduce streaming graph query APIs

Status: planned

- Add async iterator variants for graph traversal and context assembly internals.
- Let CLI and MCP consume streaming internals while preserving existing JSON response contracts.
- Ensure traversal can stop early when token, file, entity, or relation budgets are reached.
- Add latency-focused tests or benchmarks that confirm first results are produced before full traversal completes.

## 51. Add semantic reranking to ContextPack

Status: planned

- Use embeddings to rerank graph expansion candidates when embeddings are enabled.
- Combine lexical score, graph priority, and vector similarity into an explainable ContextPack ranking.
- Keep deterministic non-embedding behavior unchanged.
- Add mock-provider tests that verify semantically relevant nodes survive tight context budgets.

## 53. Add autonomous graph healing workflow

Status: planned

- Add a repair workflow for unresolved references and dangling relations reported by validation.
- Reparse only the smallest affected file or dependency neighborhood needed to resolve a graph gap.
- Record repair provenance so automatic healing remains auditable.
- Add dry-run and test coverage for unresolved imports, stale hashes, and dangling relation cleanup.
