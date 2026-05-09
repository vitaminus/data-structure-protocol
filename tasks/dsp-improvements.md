# DSP Improvement Tasks

## 2026-05-09 Performance and Reliability Upgrade Program

This section tracks the current full-stack performance/reliability push for DSP.

Execution order:

1. land observability first so later optimizations are measurable;
2. add hard safety bounds before widening traversal or incremental propagation;
3. remove unsafe hot-path process/SQLite/git overhead;
4. strengthen benchmarks, doctor/repair, and CI only after runtime behavior is stable.

### 94. Expand index telemetry and slow-file reporting

Status: done

- Extend index telemetry with `discoveryMs`, `readMs`, `hashMs`, `parseMs`, `dbWriteMs`, `cacheHitFiles`, `cacheHitParses`, `workerRestarts`, `workerTimeouts`, `parserFallbackFiles`, `slowestFiles`, and optional `dbQueryCount`.
- Surface the telemetry in CLI `--json`, keep human-readable summaries compact, and show top slow files without breaking current machine consumers.
- Persist benchmark-ready telemetry artifacts so performance changes can be compared before and after later hot-path work.

### 95. Add hard truncation limits to traversal, impact, and context-pack

Status: done

- Introduce shared traversal limits for `maxDepth`, `maxNodes`, `maxRelations`, and `timeoutMs` across graph traversal, impact analysis, and context-pack expansion.
- Extend `ImpactResult`, CLI output, and MCP output with explicit `truncated` state and `truncationReason` so large or cyclic graphs fail predictably instead of hanging.
- Add coverage for cyclic graphs, depth/node/relation caps, timeouts, and context-pack truncation visibility.

### 96. Replace shell-style git calls with validated argument-based execution

Status: done

- Replace interpolated `git` shell strings with `execFileSync`/argument arrays and validate `baseRef` inputs before execution.
- Add `--base-ref` support plus tested modes for unstaged changes, staged changes, merge-base/PR diffing, deletes, renames, and copies.
- Keep changed-only cleanup deterministic so stale graph state is removed correctly when git reports deleted or renamed files.

### 97. Add batched graph read APIs and request-scoped caches

Status: done

- Add batch database helpers for entity/relation endpoint reads, including `getEntitiesByUidCached`, `getRelationsForUids`, and `getTouchingRelationsWithEndpoints`.
- Add request-scoped entity/relation caches and reduce repeated JSON parse work for hot read paths.
- Track query-count deltas in tests/benchmarks so the new APIs prove fewer SQLite round trips instead of only moving logic around.

### 98. Refactor search, context-pack, impact, and CLI graph paths onto batched reads

Status: done

- Move `semanticSearch`, `buildContextPack`, `streamNeighbors`, `analyzeImpact`, and graph-heavy CLI commands onto the new batched database APIs.
- Preserve deterministic ordering plus provenance/confidence data while removing repeated `getEntity`, `getRelationsFrom`, and `getRelationsTo` loops.
- Add latency-focused regression coverage that compares output stability and verifies fewer SQL statements on medium/large fixtures.

### 99. Cache TypeScript project resolution state

Status: done

- Cache `tsconfigPath -> compilerOptions` and reuse `ts.createModuleResolutionCache` instead of re-reading or reparsing project config for each import.
- Support `baseUrl`, `paths`, project references, and mixed TS/JS module extensions while keeping current resolution behavior deterministic.
- Add alias-resolution integration tests and cold-vs-warm timing metrics to prove warm indexing gets faster on import-heavy TypeScript projects.

### 100. Replace per-file Python and Ruby external parsing with persistent workers

Status: done

- Add long-lived Python and Ruby parser workers with a stable request protocol, per-job timeout, bounded lifetime, crash restart, and explicit fallback telemetry.
- Preserve safe syntax-error handling and existing fallback parsers so one worker failure cannot fail the full index run.
- Add worker-path tests for success, syntax error, timeout, crash/restart, and fallback activation.

### 101. Add reverse dependency indexes for more precise incremental updates

Status: done

- Add persistent `file_dependencies` and `symbol_dependencies` tables with safe migrations and bounded write/update paths.
- Compare old/new public API snapshots for changed files so private-only edits do not fan out, while public API changes trigger bounded reverse-dependent reindexing.
- Cover TypeScript, Python, Ruby, and Rust incremental cases including rename reconciliation, truncation, and changed-only speedups versus full index.

### 102. Tighten SQLite schema for hot paths and migration safety

Status: done

- Add or verify the remaining hot-path indexes, update schema versioning, and make `doctor` verify the active schema plus migration compatibility.
- Evaluate targeted storage changes such as `WITHOUT ROWID`, typed hot metadata columns, batched upserts, and reduced JSON stringify/parse churn without breaking existing DBs.
- Keep benchmark guardrails in place so schema work must be faster or neutral on the current smoke suite.

### 103. Improve semantic/vector search scalability and recall measurement

Status: done

- Replace the current embedding bucket strategy with a stronger ANN path or a materially better bounded-LSH alternative that works locally.
- Make embedding cache identity include provider key/content hash and keep lexical fallback behavior intact when embeddings are disabled or missing.
- Add recall@5/10 benchmarks and large-entity-set latency checks so semantic search changes are measurable, not anecdotal.

### 104. Expand benchmark fixtures and CI performance gates

Status: done

- Add realistic fixtures for a small TS app, Next.js-like app, Rails-like app, Rust workspace, FastAPI-like app, and a mixed monorepo scale target.
- Extend benchmark results with changed-only timings, search/context-pack p50/p95, impact p95, validate time, RSS, DB size, parser fallback counters, worker restarts/timeouts, query count, and recall metrics.
- Keep PR smoke benchmarks fast, move medium coverage onto `main`, and publish soak artifacts on schedule/manual runs with regression thresholds enforced in CI.

### 105. Harden crash recovery, doctor/repair, and large-repo reliability

Status: done

- Add failure-mode tests for interrupted index runs, corrupted checkpoints, concurrent read-while-indexing, invalid UTF-8, binary/huge file skipping, stale parse cache, SQLite busy/retry, graph cycles, and truncation visibility.
- Extend `doctor`/`repair` with machine-readable output, stale-run/checkpoint detection, orphan cleanup, explicit destructive flags, and runtime/dependency capability checks.
- Update README, CLI help, examples, and CI workflows to document fallback behavior, large-repo mode, recovery semantics, and the final supported reliability contract.

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

Status: done

- Add async iterator variants for graph traversal and context assembly internals.
- Let CLI and MCP consume streaming internals while preserving existing JSON response contracts.
- Ensure traversal can stop early when token, file, entity, or relation budgets are reached.
- Add latency-focused tests or benchmarks that confirm first results are produced before full traversal completes.

## 51. Add semantic reranking to ContextPack

Status: done

- Use embeddings to rerank graph expansion candidates when embeddings are enabled.
- Combine lexical score, graph priority, and vector similarity into an explainable ContextPack ranking.
- Keep deterministic non-embedding behavior unchanged.
- Add mock-provider tests that verify semantically relevant nodes survive tight context budgets.

## 53. Add autonomous graph healing workflow

Status: done

- Add a repair workflow for unresolved references and dangling relations reported by validation.
- Reparse only the smallest affected file or dependency neighborhood needed to resolve a graph gap.
- Record repair provenance so automatic healing remains auditable.
- Add dry-run and test coverage for unresolved imports, stale hashes, and dangling relation cleanup.

### 54. Prevent test-only graph dependencies from leaking into ContextPack

Status: done

- When `includeTests` is `false`, filter dependencies whose endpoints are test entities.
- Keep relevant entity, file, code, and dependency lists consistent.
- Add regression coverage for a selected implementation that has a `tests` relation.

### 55. Enforce ContextPack token budgets after code payload assembly

Status: done

- Ensure `estimatedTokens` does not remain above `maxTokens` after adding snippets or full-file code payloads.
- Trim code payloads and secondary lists deterministically before returning.
- Add coverage for a small token budget with included code.

### 56. Honor configured embedding search policy by default

Status: done

- Make `runSearch` use `services.config.embeddings.enabled` unless the caller explicitly overrides `embeddingsEnabled`.
- Preserve explicit lexical-only and semantic-search call sites.
- Add API-level coverage with a configured provider.

### 57. Clamp negative semantic similarity during search scoring

Status: done

- Treat negative cosine similarity as zero so embeddings cannot penalize lexical matches.
- Keep ContextPack reranking and search scoring consistent.
- Add coverage for an embedding provider that returns an opposite vector.

### 58. Pin supported local Node runtimes

Status: done

- Restrict supported local Node.js versions to 20.x and 22.x instead of any future major.
- Add `.nvmrc` / `.node-version` defaults and a `pnpm doctor` runtime check for native dependency drift.
- Fail installer setup early when the local Node runtime is outside the supported range.

### 59. Skip full discovery during changed-only indexing

Status: done

- Make `changedOnly`, `fromGitDiff`, and explicit file indexing build the worklist directly instead of scanning the whole repo first.
- Keep git rename cleanup and neighbor expansion behavior intact.
- Preserve deterministic selected-file ordering for stable index results.

### 60. Prune ignored directories during file discovery

Status: done

- Replace recursive whole-tree walking with an iterative walker that skips ignored directories before descending.
- Ignore symlinked directories during discovery to avoid accidental loops and extra IO.
- Keep deterministic sorted file output after pruning.

### 61. Bound semantic-search fallback work

Status: done

- Stop semantic search from auto-expanding to the full entity set when embeddings are enabled.
- Limit embedding-backed fallback candidates to bounded lexical, neighbor, stored-embedding, and capped semantic-only seeds.
- Remove the hard `200000` entity ceiling from embedding refresh by iterating the full entity stream.

### 62. Stream heavy export and stats paths

Status: done

- Add ordered entity, relation, file, and unresolved-reference iterators in the database layer.
- Remove silent entity/relation export caps in snapshot, JSONL, protocol, and DSP export flows.
- Switch common CLI stats and path lookups to aggregated database queries instead of full-graph scans.

### 63. Apply earlier ContextPack budgeting

Status: done

- Tie traversal budgets to the request token budget before graph expansion gets too large.
- Cap total code payload size and per-file code reads before assembly instead of trimming only at the end.
- Limit full-file payload reads to bounded prefixes so very large files do not overrun the code budget path.

### 64. Reduce validation full-graph memory pressure

Status: done

- Iterate file entities and annotation-conflict candidates directly from SQLite during validation.
- Preserve existing validation semantics while avoiding another large eager entity snapshot.
- Keep unresolved, dangling, and low-confidence checks on their ordered database paths.

### 65. Accelerate full-tree discovery with git-aware enumeration

Status: done

- Use `git ls-files --cached --others --exclude-standard` as the fast path for repository file discovery.
- Keep subtree filtering and size limits intact when indexing a nested path inside a larger repo.
- Fall back to filesystem walking only when git-aware discovery is unavailable.

### 66. Cache fixed SQLite statements across index passes

Status: done

- Reuse prepared statements for hot entity, relation, hash, and run metadata operations instead of preparing SQL for every mutation.
- Keep dynamic chunked `IN (...)` queries unchanged where statement reuse is not practical.
- Preserve the existing public DB API while reducing per-entity and per-relation overhead.

### 67. Prefetch file hashes before parsing

Status: done

- Batch-load known file hashes for the selected file set before parse workers start.
- Remove per-file hash lookups from the parser hot path.
- Preserve unchanged-file skipping behavior for full, incremental, and explicit file runs.

### 68. Deduplicate repeated directory upserts and import resolution work

Status: done

- Avoid rewriting the same directory entities repeatedly during one index pass.
- Cache extensionless/internal file import resolution results across files in the same run.
- Keep relation output and index summaries stable while reducing duplicate work during tree recalculation.

### 69. Add real parser worker parallelism for builtin adapters

Status: done

- Add a reusable worker-thread parse pool in core indexing and wire builtin language adapters through worker-aware entrypoints.
- Keep custom adapters on the existing in-process path so external integrations do not break.
- Verify the worker path with a focused non-SQLite test that parses TypeScript through the pool.

### 70. Skip warm-scan file hashing when stat metadata is unchanged

Status: done

- Store file `mtime` and size alongside content hashes in the file-hash cache table.
- Short-circuit unchanged files by stat metadata before reading and hashing file contents.
- Fall back to content hashing when metadata is missing or suspicious so correctness stays intact.

### 71. Batch index write transactions across files

Status: done

- Replace per-file write transactions with chunked batched AST write commits during index runs.
- Preserve the existing parse-first, write-after-parse failure model so parse errors do not partially refresh the graph.
- Keep deterministic file ordering while reducing transaction and SQLite commit overhead.

### 72. Add a fast AST replace path in SQLite

Status: done

- Add batched `clearAstDataForPaths` and `replaceAstFiles` storage APIs for full AST refreshes.
- Use direct conflict-aware inserts for AST entities and relations instead of read-before-write merges on the hot path.
- Preserve higher-priority manual data by letting fast-path updates yield to stronger existing source priorities.

### 73. Tune SQLite pragmas for indexing workloads

Status: done

- Keep WAL, and add `synchronous=NORMAL`, `temp_store=MEMORY`, a larger negative cache size, and `mmap_size`.
- Run `PRAGMA optimize` after successful indexing work and before DB close.
- Keep the tuning local to the database layer so callers do not need special handling.

### 74. Stop persisting file-level contains edges and derive them on demand

Status: done

- Filter file-to-symbol `contains` edges out of persisted index writes while preserving class/module containment edges.
- Synthesize file containment relations on read/export paths from entity ownership instead of storing every one in SQLite.
- Drop redundant file-to-directory containment noise while keeping higher-level APIs and tests able to observe file containment.

### 75. Turn reindex benchmarks into enforced CI and soak coverage

Status: done

- Refactor the benchmark harness into reusable shared code so smoke and soak runs exercise the same reindex path.
- Make smoke benchmarks fail CI when they regress against the checked-in baseline instead of reporting best-effort artifacts only.
- Add a separate scheduled and manually triggerable soak benchmark job that captures repeated warm-index and changed-only behavior over time.

### 76. Add crash-safe checkpointing for long full-index runs

Status: done

- Persist resumable full-index checkpoints keyed by the discovered manifest so interrupted runs can continue from the last committed batch.
- Track checkpoint progress only after successful batch writes so a resumed run never overcounts or skips unwritten files.
- Clear stale checkpoints automatically when the file manifest changes or the full run completes successfully.

### 77. Separate SQLite read/write paths and harden busy handling

Status: done

- Open a dedicated readonly SQLite handle for graph reads while keeping writes on the primary WAL connection.
- Route hot query paths through the readonly statement cache so long-running reads stop contending with index writes as much as possible.
- Add `busy_timeout` and a bounded retry policy around index-run and checkpoint mutations so transient writer contention fails less often.

### 78. Add a deep database doctor command

Status: done

- Expose a `doctor` report that checks SQLite integrity plus orphaned file hashes, embeddings, unresolved paths, and lingering checkpoints/runs.
- Surface the report through the CLI so reliability debugging does not require ad hoc SQL.
- Keep an optional deep mode that layers full graph validation on top of the low-level DB health report.

### 79. Add worker-pool guardrails for parsing

Status: done

- Add parser worker timeouts, maximum input-size checks, and worker recycling after a configurable number of jobs.
- Thread the guardrail settings through the performance config so large repos can tune them without code changes.
- Verify that timed-out workers restart cleanly and that oversized files fail fast before they pressure the worker pool.

### 80. Add parser fallback telemetry to index runs

Status: done

- Track how many indexed files relied on fallback-style provenance instead of pure AST extraction.
- Break fallback counts out by language and aggregate observed parser provenance sources in the index summary metadata.
- Cover the telemetry with a regression test so fallback visibility stays present across future indexer refactors.

### 81. Cache parse payloads by content hash for rebuilds

Status: done

- Persist parsed payloads by language, file path, and content hash so AST data can be rebuilt without reparsing unchanged files.
- Consult the parse cache after hashing but before parser execution, then repopulate the graph from the cached payload when it is still valid.
- Keep a regression test that clears AST state and proves the second rebuild avoids another adapter parse call.

### 82. Build an in-memory import-resolution path index

Status: done

- Construct a path-resolution index from known file paths so extensionless and index-style imports resolve from memory before hitting the filesystem.
- Feed the index into canonical import rewriting during parsing while keeping `existsSync` as a fallback for uncached edge cases.
- Reuse the existing import canonicalization tests to guard the new fast path without changing outward behavior.

### 83. Cache file discovery manifests between full scans

Status: done

- Persist a discovery manifest keyed by the current working-tree fingerprint so repeated full scans can reuse the previous file list.
- Fall back to a lightweight non-git fingerprint when no repository metadata is available.
- Cover the cache with a unit test that forbids nested directory rescans on a clean manifest cache hit.

### 84. Reduce FTS write amplification during AST refreshes

Status: done

- Stop updating FTS row-by-row during fast AST inserts and instead refresh the touched UID set in bulk after each write batch.
- Preserve higher-priority manual entities by rebuilding FTS rows from the final stored entities, not from speculative AST payloads.
- Keep full FTS rebuilds working during migrations by using the same normalized tokenization logic as the incremental refresh path.

### 85. Filter low-value graph edges out of semantic search expansion

Status: done

- Restrict semantic-search graph expansion and neighbor scoring to high-signal relation kinds instead of every stored edge.
- Ignore synthetic containment plus file/directory hops during expansion so the candidate set stays focused on semantically meaningful entities.
- Add a regression test that proves containment-only file nodes do not leak into search results as noisy graph neighbors.

### 86. Add adaptive index parallelism

Status: done

- Add an adaptive parallelism mode that caps concurrency by both CPU availability and the current run size.
- Reuse the effective parallelism value for parse workers, async parse fanout, and write-batch sizing so the whole index path stays coordinated.
- Cover the helper with a regression test that proves tiny runs do not oversubscribe workers.

### 87. Add a dedicated fast path for rename-heavy git updates

Status: done

- Track content-stable rename reconciliations and exclude them from later parse selection during the same git-diff run.
- Skip neighbor-expansion work for already reconciled pure renames so large move/refactor operations stop paying the normal changed-file tax.
- Update the rename regression test to assert that pure renames now complete without burning skip slots on files we never need to parse.

### 88. Enforce a memory budget for index runs

Status: done

- Add an index memory budget setting and chunk parse work into byte-bounded windows instead of holding every parsed result in memory at once.
- Reuse the same checkpointing and write-batch logic inside each memory window so reliability stays intact while RSS stays flatter.
- Cover the new chunking helper with a regression test that proves byte budgets split work deterministically.

### 89. Remove inline entity embedding work from request paths

Status: done

- Stop `semanticSearch` and context-pack reranking from generating and writing missing entity embeddings inline during user-facing requests.
- Reuse only precomputed provider-matching embeddings for semantic scoring, and fall back to lexical/graph ranking when fresh vectors are not available yet.
- Add nearest stored-embedding ranking in the DB layer so semantic candidate selection stays off the write path.

### 90. Add a persistent repository watch mode

Status: done

- Add a long-lived repository watcher that keeps DSP services warm and incrementally reindexes only changed files between polling cycles.
- Reconcile deletions inside the watch loop by clearing stale AST/file-hash state before the next incremental pass.
- Expose the new mode in the CLI with structured cycle summaries so local automation can consume watch progress without parsing human text.

### 91. Add incremental validation modes

Status: done

- Split validation into a fast file-state pass and optional deep graph-consistency checks so routine runs avoid the heaviest traversal work.
- Reuse cached `mtime` and size metadata to skip rereading unchanged files, while still hashing changed files before reporting stale-index drift.
- Expose `validate --changed-only` and `validate --deep`, and reuse the focused mode in precommit-style CLI flows.

### 92. Stream heavy exports and trim CLI graph scans

Status: done

- Rewrite JSONL and DSP text exports to write rows incrementally instead of materializing the entire graph into arrays first.
- Rework protocol export bookkeeping around iterator-driven maps so entity and relation passes stay linear without snapshot copies.
- Replace CLI orphan detection with a direct SQL query and switch cycle detection to a single adjacency build from ordered iterators.

### 93. Add parse-cache lifecycle controls and DB maintenance

Status: done

- Track parse-cache volume in normal cache stats and `doctor`, including stale cache paths that no longer line up with indexed files.
- Prune parse-cache rows by age and total row budget during maintenance, and run WAL checkpointing plus conditional `VACUUM` from the same path.
- Make `clearCache()` actually clear `parse_cache` too so manual cache resets return the database to a clean state.

### 94. Parallelize and harden embeddings refreshes

Status: done

- Run embeddings refreshes with bounded concurrency instead of strict one-by-one provider calls.
- Add retry-with-backoff for transient provider failures so long refresh jobs are less brittle.
- Expose concurrency and retry knobs in the CLI while reusing the normal cache-maintenance path after the refresh completes.

### 95. Use a cheaper git fingerprint for discovery invalidation

Status: done

- Replace the full porcelain-status fingerprint with a lighter key built from HEAD, git-index metadata, and a compact dirty-path listing.
- Keep discovery-manifest invalidation sensitive to untracked and modified paths without forcing a full `git status` walk on every clean scan.
- Add a focused regression test around the new fingerprint shape so future changes do not quietly reintroduce the heavier status command.

### 96. Add bucketed vector prefiltering for semantic search

Status: done

- Store a lightweight sign-bucket index alongside embeddings so semantic candidate selection can start from a much smaller provider-specific subset.
- Reuse nearby bucket probes before falling back to the broader provider scan, keeping semantic recall intact while trimming average search work.
- Clear and maintain the bucket table alongside embeddings so cache resets and entity deletions do not leave stale vector-index rows behind.
