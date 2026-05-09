import path from "node:path";
import os from "node:os";
import { existsSync, readFileSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type {
  Entity,
  FileIndexRequest,
  IndexSkippedFile,
  IndexSkipReason,
  IndexSlowFile,
  IndexSummary,
  LanguageAdapter,
  ParseResult,
  Relation,
  UnresolvedReference
} from "../graph/types.ts";
import { buildUid, contentHash, normalizePath, stableNowIso } from "../graph/uid.ts";
import { discoverFilesDetailed, findRepoRoot } from "../util/fs.ts";
import { changedFileEntriesFromGit, changedFilesFromGit } from "../util/git.ts";
import { classifyTextBuffer } from "../util/text.ts";
import { ParseWorkerPool } from "./parse-pool.ts";
import type { DSPDatabase, FileHashEntry, IndexedAstFile } from "../storage/db.ts";
import type { DSPConfig } from "../config/types.ts";

const INCREMENTAL_DEPENDENT_MAX_DEPTH = 3;
const INCREMENTAL_DEPENDENT_MAX_FILES = 256;

function languageFromFile(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath);
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    return "typescript";
  }
  if (ext === ".py") {
    return "python";
  }
  if (ext === ".rs" || basename === "Cargo.toml") {
    return "rust";
  }
  if (ext === ".rb" || basename === "Gemfile" || basename === "Gemfile.lock") {
    return "ruby";
  }
  return undefined;
}

function isTestPath(filePath: string): boolean {
  const normalized = normalizePath(filePath).toLowerCase();
  return (
    normalized.includes("/test/") ||
    normalized.includes("/tests/") ||
    normalized.endsWith(".test.ts") ||
    normalized.endsWith(".spec.ts") ||
    normalized.endsWith("_test.py") ||
    normalized.endsWith("_spec.rb")
  );
}

function fileEntity(relPath: string, language: string, nowIso: string): Entity {
  return {
    uid: buildUid("file", relPath),
    kind: "file",
    name: path.basename(relPath),
    path: relPath,
    language,
    confidence: 1,
    provenance: [
      {
        source: "ast",
        tool: "dsp-indexer",
        confidence: 1,
        timestamp: nowIso,
        evidence: "discovered file"
      }
    ],
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

function testEntityForFile(relPath: string, nowIso: string): Entity | undefined {
  if (!isTestPath(relPath)) {
    return undefined;
  }
  return {
    uid: buildUid("test", relPath),
    kind: "test",
    name: path.basename(relPath),
    path: relPath,
    confidence: 0.85,
    provenance: [
      {
        source: "test",
        tool: "dsp-indexer",
        confidence: 0.85,
        timestamp: nowIso,
        evidence: "test naming heuristic"
      }
    ],
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

function dirEntitiesForFile(relPath: string, nowIso: string): Entity[] {
  const normalized = normalizePath(relPath);
  const parts = normalized.split("/");
  const entities: Entity[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    const dir = parts.slice(0, i).join("/");
    entities.push({
      uid: buildUid("directory", dir),
      kind: "directory",
      name: parts[i - 1],
      path: dir,
      confidence: 1,
      provenance: [
        {
          source: "ast",
          tool: "dsp-indexer",
          timestamp: nowIso,
          confidence: 1,
          evidence: "derived from path"
        }
      ],
      createdAt: nowIso,
      updatedAt: nowIso
    });
  }
  return entities;
}

function stableMarkerPrefix(kind: Entity["kind"]): "obj" | "func" {
  return ["function", "method", "route", "test"].includes(kind) ? "func" : "obj";
}

function stableMarkersFromContent(content: string): { uid: string; line: number }[] {
  return content
    .split("\n")
    .flatMap((line, index) => {
      const match = line.match(/@dsp\s+((?:obj|func)-[0-9a-fA-F]{8})\b/);
      return match ? [{ uid: match[1]!, line: index + 1 }] : [];
    });
}

function applyStableMarkers(
  content: string,
  entities: Entity[],
  relations: Relation[]
): { entities: Entity[]; relations: Relation[] } {
  const markers = stableMarkersFromContent(content);
  if (markers.length === 0) {
    return { entities, relations };
  }

  const sortedEntities = [...entities]
    .filter((entity) => entity.startLine !== undefined)
    .sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
  const usedEntityUids = new Set<string>();
  const uidMap = new Map<string, string>();

  for (const marker of markers) {
    const expectedPrefix = marker.uid.startsWith("func-") ? "func" : "obj";
    const entity = sortedEntities.find(
      (candidate) =>
        !usedEntityUids.has(candidate.uid) &&
        (candidate.startLine ?? 0) > marker.line &&
        stableMarkerPrefix(candidate.kind) === expectedPrefix
    );
    if (!entity) {
      continue;
    }
    usedEntityUids.add(entity.uid);
    uidMap.set(entity.uid, marker.uid);
  }

  if (uidMap.size === 0) {
    return { entities, relations };
  }

  return {
    entities: entities.map((entity) =>
      uidMap.has(entity.uid)
        ? {
            ...entity,
            uid: uidMap.get(entity.uid)!,
            metadata: {
              ...(entity.metadata ?? {}),
              structuralUid: entity.uid,
              stableUidSource: "source-marker"
            }
          }
        : entity
    ),
    relations: relations.map((relation) => ({
      ...relation,
      from: uidMap.get(relation.from) ?? relation.from,
      to: uidMap.get(relation.to) ?? relation.to
    }))
  };
}

function filePathFromFileUid(uid: string): string | undefined {
  if (!uid.startsWith("file:") || uid.includes("#")) {
    return undefined;
  }
  return uid.slice("file:".length);
}

function pathCandidates(targetRelPath: string, fromRelPath?: string): string[] {
  const normalizedTarget = normalizePath(targetRelPath);
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".rs"];
  const candidates: string[] = [];
  const addVariants = (candidate: string) => {
    const normalized = normalizePath(path.posix.normalize(candidate));
    candidates.push(normalized);
    if (!path.posix.extname(normalized)) {
      for (const ext of extensions) {
        candidates.push(`${normalized}${ext}`);
      }
      for (const ext of extensions) {
        candidates.push(`${normalized}/index${ext}`);
      }
      candidates.push(`${normalized}/mod.rs`);
    }
  };

  addVariants(normalizedTarget);
  if (fromRelPath && !normalizedTarget.includes("/")) {
    addVariants(path.posix.join(path.posix.dirname(fromRelPath), normalizedTarget));
  }

  return [...new Set(candidates)];
}

function buildPathResolutionIndex(availableRelPaths: Iterable<string>): Map<string, string> {
  const index = new Map<string, string>();
  for (const relPath of availableRelPaths) {
    const normalized = normalizePath(relPath);
    index.set(normalized, normalized);

    const extension = path.posix.extname(normalized);
    if (extension) {
      index.set(normalized.slice(0, -extension.length), normalized);
    }
    if (/\/index\.[^.]+$/.test(normalized)) {
      const withoutIndex = normalized.replace(/\/index\.[^.]+$/, "");
      index.set(withoutIndex, normalized);
    }
    if (normalized.endsWith("/mod.rs")) {
      index.set(normalized.slice(0, -"/mod.rs".length), normalized);
    }
  }
  return index;
}

function canonicalFilePath(
  targetRelPath: string,
  fromRelPath: string | undefined,
  scanRoot: string,
  resolutionCache: Map<string, string | undefined>,
  pathIndex: Map<string, string>
): string | undefined {
  const cacheKey = `${fromRelPath ?? ""}\0${targetRelPath}`;
  const cached = resolutionCache.get(cacheKey);
  if (resolutionCache.has(cacheKey)) {
    return cached;
  }
  const candidates = pathCandidates(targetRelPath, fromRelPath);
  const resolvedFromIndex = candidates.map((candidate) => pathIndex.get(candidate)).find(Boolean);
  const resolved = resolvedFromIndex ?? candidates.find((candidate) => existsSync(path.resolve(scanRoot, candidate)));
  resolutionCache.set(cacheKey, resolved);
  return resolved;
}

function canonicalizeFileRelations(
  relations: Relation[],
  scanRoot: string,
  resolutionCache: Map<string, string | undefined>,
  pathIndex: Map<string, string>
): Relation[] {
  return relations.map((relation) => {
    const targetRelPath = filePathFromFileUid(relation.to);
    if (!targetRelPath) {
      return relation;
    }
    const fromRelPath = filePathFromFileUid(relation.from);
    const resolvedPath = canonicalFilePath(targetRelPath, fromRelPath, scanRoot, resolutionCache, pathIndex);
    if (!resolvedPath || resolvedPath === targetRelPath) {
      return relation;
    }
    return {
      ...relation,
      to: buildUid("file", resolvedPath),
      metadata: {
        ...(relation.metadata ?? {}),
        resolvedPath
      }
    };
  });
}

type ParseOneResult =
  | {
      kind: "unsupported";
      relPath: string;
      telemetry: ParseOneTelemetry;
    }
  | {
      kind: "skipped";
      relPath: string;
      language: string;
      reason: IndexSkipReason;
      sizeBytes: number;
      telemetry: ParseOneTelemetry;
    }
  | {
      kind: "parsed";
      relPath: string;
      language: string;
      hash: string;
      mtimeMs: number;
      sizeBytes: number;
      nowIso: string;
      entities: Entity[];
      relations: Relation[];
      unresolved: UnresolvedReference[];
      parserSources: string[];
      usedFallback: boolean;
      publicApiSnapshot: PublicApiSnapshot;
      telemetry: ParseOneTelemetry;
    };

type ParseOneTelemetry = {
  readMs: number;
  hashMs: number;
  parseMs: number;
  dbWriteMs: number;
  tsResolutionMs: number;
  tsResolutionCacheHits: number;
  tsResolutionCacheMisses: number;
  workerRestarts: number;
  workerTimeouts: number;
  cacheHitFile: boolean;
  cacheHitParse: boolean;
  totalMs: number;
};

type ParsedResultTelemetry = {
  moduleResolutionMs?: number;
  moduleResolutionCacheHits?: number;
  moduleResolutionCacheMisses?: number;
  workerRestarts?: number;
  workerTimeouts?: number;
};

type ParseResultWithTelemetry = ParseResult & {
  telemetry?: ParsedResultTelemetry;
};

function sameCachedFileState(
  cached: FileHashEntry | undefined,
  mtimeMs: number,
  sizeBytes: number
): boolean {
  return cached?.mtimeMs !== undefined && cached.sizeBytes !== undefined && cached.mtimeMs === mtimeMs && cached.sizeBytes === sizeBytes;
}

function persistedRelationsForFile(fileUid: string, relations: Relation[]): Relation[] {
  return relations.filter((relation) => !(relation.kind === "contains" && relation.from === fileUid));
}

export function effectiveParallelismForIndex(config: DSPConfig["performance"], fileCount: number): number {
  const configured = Math.max(1, config.parallelism);
  if (!config.adaptiveParallelism) {
    return configured;
  }
  const cpuCount = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  const cpuBound = config.mode === "large-repo" ? Math.max(2, Math.floor(cpuCount * 0.75)) : Math.max(2, cpuCount - 1);
  return Math.max(1, Math.min(configured, fileCount, cpuBound));
}

function parseWorkerPoolFor(
  adapters: LanguageAdapter[],
  config: DSPConfig["performance"],
  parallelism: number
): ParseWorkerPool | undefined {
  if (parallelism <= 1 || !adapters.some((adapter) => adapter.worker)) {
    return undefined;
  }
  const useTsxLoader = adapters.some((adapter) => /\.tsx?$/.test(adapter.worker?.moduleUrl ?? ""));
  return new ParseWorkerPool(parallelism, useTsxLoader, {
    timeoutMs: config.workerTimeoutMs,
    maxInputBytes: config.workerMaxInputKb * 1024,
    maxJobsPerWorker: config.workerMaxJobsPerWorker
  });
}

function chunkItems<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

export function chunkEntriesByByteBudget<T>(
  items: T[],
  byteBudget: number,
  byteSizeOf: (item: T) => number
): T[][] {
  const chunks: T[][] = [];
  const effectiveBudget = Math.max(1, byteBudget);
  let currentChunk: T[] = [];
  let currentBytes = 0;

  for (const item of items) {
    const itemBytes = Math.max(1, byteSizeOf(item));
    if (currentChunk.length > 0 && currentBytes + itemBytes > effectiveBudget) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentBytes = 0;
    }
    currentChunk.push(item);
    currentBytes += itemBytes;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

type CheckpointState = {
  manifestHash: string;
  completedFiles: string[];
  filesIndexed: number;
  filesSkipped: number;
  languages: string[];
  entities: number;
  relations: number;
  unresolvedReferences: number;
  lowConfidenceRelations: number;
};

export function normalizeCheckpointState(
  metadata: unknown,
  manifestHash: string,
  allowedFiles: Iterable<string>
): CheckpointState | undefined {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const candidate = metadata as Partial<CheckpointState>;
  if (candidate.manifestHash !== manifestHash) {
    return undefined;
  }
  const allowed = new Set(allowedFiles);
  const completedFiles = Array.isArray(candidate.completedFiles)
    ? [...new Set(candidate.completedFiles.filter((value): value is string => typeof value === "string"))]
        .filter((value) => allowed.has(value))
        .sort()
    : [];
  if (completedFiles.length === 0) {
    return undefined;
  }
  const asSafeCount = (value: unknown, max = Number.MAX_SAFE_INTEGER): number => {
    const numeric = typeof value === "number" ? value : Number(value ?? 0);
    if (!Number.isFinite(numeric) || numeric < 0) {
      return 0;
    }
    return Math.min(max, Math.trunc(numeric));
  };
  const filesIndexed = Math.max(completedFiles.length, asSafeCount(candidate.filesIndexed, allowed.size));
  return {
    manifestHash,
    completedFiles,
    filesIndexed,
    filesSkipped: asSafeCount(candidate.filesSkipped),
    languages: Array.isArray(candidate.languages)
      ? [...new Set(candidate.languages.filter((value): value is string => typeof value === "string"))].sort()
      : [],
    entities: asSafeCount(candidate.entities),
    relations: asSafeCount(candidate.relations),
    unresolvedReferences: asSafeCount(candidate.unresolvedReferences),
    lowConfidenceRelations: asSafeCount(candidate.lowConfidenceRelations)
  };
}

function durationMs(start: number): number {
  return performance.now() - start;
}

function stableMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableMetadataValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !["previousPath", "renameReconciledAt", "stableUidSource", "structuralUid", "testedPath"].includes(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableMetadataValue(entry)])
    );
  }
  return value;
}

type PublicApiSnapshot = {
  fingerprint: string;
  publicUids: string[];
};

function snapshotPublicApi(
  adapter: LanguageAdapter,
  entities: Entity[]
): PublicApiSnapshot {
  const publicEntities = adapter
    .extractPublicAPI(entities)
    .map((entity) => ({
      uid: entity.uid,
      kind: entity.kind,
      name: entity.name,
      language: entity.language,
      signature: entity.signature,
      metadata: stableMetadataValue(entity.metadata ?? {})
    }))
    .sort((left, right) => left.uid.localeCompare(right.uid));
  return {
    fingerprint: JSON.stringify(publicEntities),
    publicUids: publicEntities.map((entity) => entity.uid)
  };
}

type IncrementalSeed = {
  relPath: string;
  snapshotPath: string;
  oldPublicUids: string[];
};

type IncrementalExpansionResult = {
  files: string[];
  truncated: boolean;
  reason?: "maxDepth" | "maxFiles";
};

function expandReverseDependents(
  db: DSPDatabase,
  seeds: IncrementalSeed[],
  alreadySelected: Set<string>
): IncrementalExpansionResult {
  const selected = new Set(alreadySelected);
  const dependents = new Set<string>();
  let frontierPaths = [...new Set(seeds.map((seed) => seed.snapshotPath))].sort();
  let frontierSymbolUids = [...new Set(seeds.flatMap((seed) => seed.oldPublicUids))].sort();
  let truncated = false;
  let reason: "maxDepth" | "maxFiles" | undefined;

  for (let depth = 0; depth < INCREMENTAL_DEPENDENT_MAX_DEPTH; depth += 1) {
    const nextPaths = new Set<string>();
    const candidates = new Set<string>(db.getReverseFileDependents(frontierPaths, null));
    if (frontierSymbolUids.length > 0) {
      const symbolDependents = db.getReverseSymbolDependents(frontierSymbolUids, null);
      const symbolEntities = db.getEntitiesByUid(symbolDependents);
      for (const entity of symbolEntities) {
        if (entity.path) {
          candidates.add(entity.path);
        }
      }
    }

    for (const candidate of [...candidates].sort()) {
      if (selected.has(candidate) || dependents.has(candidate)) {
        continue;
      }
      if (dependents.size >= INCREMENTAL_DEPENDENT_MAX_FILES) {
        truncated = true;
        reason = "maxFiles";
        return { files: [...dependents].sort(), truncated, reason };
      }
      dependents.add(candidate);
      nextPaths.add(candidate);
    }

    if (nextPaths.size === 0) {
      return { files: [...dependents].sort(), truncated, reason };
    }

    frontierPaths = [...nextPaths].sort();
    frontierSymbolUids = [];
  }

  if (frontierPaths.length > 0) {
    truncated = true;
    reason = "maxDepth";
  }

  return { files: [...dependents].sort(), truncated, reason };
}

function telemetryZero(): ParseOneTelemetry {
  return {
    readMs: 0,
    hashMs: 0,
    parseMs: 0,
    dbWriteMs: 0,
    tsResolutionMs: 0,
    tsResolutionCacheHits: 0,
    tsResolutionCacheMisses: 0,
    workerRestarts: 0,
    workerTimeouts: 0,
    cacheHitFile: false,
    cacheHitParse: false,
    totalMs: 0
  };
}

function recordSlowFile(
  slowestFiles: IndexSlowFile[],
  entry: IndexSlowFile,
  limit = 10
): void {
  slowestFiles.push(entry);
  slowestFiles.sort((a, b) => {
    if (b.ms !== a.ms) {
      return b.ms - a.ms;
    }
    return a.path.localeCompare(b.path);
  });
  if (slowestFiles.length > limit) {
    slowestFiles.length = limit;
  }
}

function incrementSkipReason(counts: Partial<Record<IndexSkipReason, number>>, reason: IndexSkipReason): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

function recordSkippedFile(skippedFiles: IndexSkippedFile[], entry: IndexSkippedFile, limit = 20): void {
  if (skippedFiles.some((existing) => existing.path === entry.path && existing.reason === entry.reason)) {
    return;
  }
  skippedFiles.push(entry);
  skippedFiles.sort((left, right) => left.path.localeCompare(right.path));
  if (skippedFiles.length > limit) {
    skippedFiles.length = limit;
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const workerCount = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex]!, currentIndex);
      }
    })
  );

  return results;
}

async function parseOne(
  absPath: string,
  scanRoot: string,
  db: DSPDatabase,
  adapters: LanguageAdapter[],
  cachedHash: FileHashEntry | undefined,
  resolutionCache: Map<string, string | undefined>,
  pathIndex: Map<string, string>,
  full: boolean,
  maxFileSizeBytes: number,
  workerPool?: ParseWorkerPool
): Promise<ParseOneResult> {
  const telemetry = telemetryZero();
  const startedAt = performance.now();
  const relPath = normalizePath(path.relative(scanRoot, absPath));
  const language = languageFromFile(relPath);
  if (!language) {
    telemetry.totalMs = durationMs(startedAt);
    return { kind: "unsupported", relPath, telemetry };
  }
  const adapter = adapters.find((candidate) => candidate.canHandle(relPath));
  if (!adapter) {
    telemetry.totalMs = durationMs(startedAt);
    return { kind: "unsupported", relPath, telemetry };
  }

  const stat = statSync(absPath);
  const mtimeMs = Math.trunc(stat.mtimeMs);
  const sizeBytes = stat.size;
  if (sizeBytes > maxFileSizeBytes) {
    telemetry.totalMs = durationMs(startedAt);
    return { kind: "skipped", relPath, language: adapter.language, reason: "tooLarge", sizeBytes, telemetry };
  }
  if (!full && sameCachedFileState(cachedHash, mtimeMs, sizeBytes)) {
    telemetry.cacheHitFile = true;
    telemetry.totalMs = durationMs(startedAt);
    return { kind: "skipped", relPath, language: adapter.language, reason: "unchanged", sizeBytes, telemetry };
  }

  const readStartedAt = performance.now();
  const rawContent = readFileSync(absPath);
  telemetry.readMs += durationMs(readStartedAt);
  const classified = classifyTextBuffer(rawContent);
  if (classified.kind !== "text") {
    telemetry.totalMs = durationMs(startedAt);
    return {
      kind: "skipped",
      relPath,
      language: adapter.language,
      reason: classified.kind,
      sizeBytes,
      telemetry
    };
  }
  const content = classified.content;
  const hashStartedAt = performance.now();
  const hash = contentHash(content);
  telemetry.hashMs += durationMs(hashStartedAt);
  if (!full && cachedHash?.hash === hash) {
    telemetry.cacheHitFile = true;
    telemetry.totalMs = durationMs(startedAt);
    return { kind: "skipped", relPath, language: adapter.language, reason: "unchanged", sizeBytes, telemetry };
  }

  const cachedParse = db.getCachedParseResult(adapter.language, relPath, hash);
  telemetry.cacheHitParse = Boolean(cachedParse);
  const parseStartedAt = performance.now();
  const parsed = (
    cachedParse ??
    (workerPool && adapter.worker
      ? await workerPool.run(adapter.worker, relPath, content)
      : await adapter.parseFile(relPath, content))
  ) as ParseResultWithTelemetry;
  if (!cachedParse) {
    telemetry.parseMs += durationMs(parseStartedAt);
  }
  if (!cachedParse) {
    const cacheWriteStartedAt = performance.now();
    db.setCachedParseResult(
      adapter.language,
      relPath,
      hash,
      {
        entities: parsed.entities,
        relations: parsed.relations,
        unresolvedReferences: parsed.unresolvedReferences ?? [],
        telemetry: parsed.telemetry
      },
      stableNowIso()
    );
    telemetry.dbWriteMs += durationMs(cacheWriteStartedAt);
    telemetry.tsResolutionMs += parsed.telemetry?.moduleResolutionMs ?? 0;
    telemetry.tsResolutionCacheHits += parsed.telemetry?.moduleResolutionCacheHits ?? 0;
    telemetry.tsResolutionCacheMisses += parsed.telemetry?.moduleResolutionCacheMisses ?? 0;
    telemetry.workerRestarts += parsed.telemetry?.workerRestarts ?? 0;
    telemetry.workerTimeouts += parsed.telemetry?.workerTimeouts ?? 0;
  }
  const parsedEntities = adapter.extractEntities(parsed);
  const parsedRelations = adapter.extractRelations(parsed, parsedEntities);
  const extracted = applyStableMarkers(content, parsedEntities, parsedRelations);
  const nowIso = stableNowIso();

  const fileNode = fileEntity(relPath, adapter.language, nowIso);
  const testNode = testEntityForFile(relPath, nowIso);
  const directories = dirEntitiesForFile(relPath, nowIso);
  const extractedEntities = extracted.entities;
  const publicApiSnapshot = snapshotPublicApi(adapter, extractedEntities);
  const extractedRelations = canonicalizeFileRelations(
    persistedRelationsForFile(fileNode.uid, extracted.relations),
    scanRoot,
    resolutionCache,
    pathIndex
  );
  const unresolved = parsed.unresolvedReferences ?? [];
  const allEntities = [fileNode, ...directories, ...(testNode ? [testNode] : []), ...extractedEntities];
  const allRelations = [
    ...extractedRelations,
    ...(testNode
      ? [
          {
            from: testNode.uid,
            to: fileNode.uid,
            kind: "tests" as const,
            confidence: 0.85,
            provenance: [
              {
                source: "test" as const,
                tool: "dsp-indexer",
                confidence: 0.85,
                timestamp: nowIso,
                evidence: "test file relation"
              }
            ]
          }
        ]
      : [])
  ];
  const parserSources = [
    ...new Set(
      [...extractedEntities.flatMap((entity) => entity.provenance.map((provenance) => provenance.source)),
      ...allRelations.flatMap((relation) => relation.provenance.map((provenance) => provenance.source))]
    )
  ];

  return {
    kind: "parsed",
    relPath,
    language: adapter.language,
    hash,
    mtimeMs,
    sizeBytes,
    nowIso,
    entities: allEntities,
    relations: allRelations,
    unresolved,
    parserSources,
    usedFallback: parserSources.some((source) => source !== "ast" && source !== "test" && source !== "human"),
    publicApiSnapshot,
    telemetry: {
      ...telemetry,
      totalMs: durationMs(startedAt)
    }
  };
}

export async function indexRepository(
  db: DSPDatabase,
  adapters: LanguageAdapter[],
  request: FileIndexRequest,
  config: DSPConfig
): Promise<IndexSummary> {
  const scanRoot = path.resolve(request.rootDir);
  const repoRoot = findRepoRoot(scanRoot);
  const now = stableNowIso();
  const runId = db.beginRun(request.fromGitDiff ? "update-git-diff" : "index", now);
  let filesIndexed = 0;
  let filesSkipped = 0;
  const languageSet = new Set<string>();
  let entityCount = 0;
  let relationCount = 0;
  let unresolvedCount = 0;
  let lowConfidenceCount = 0;
  let parserFallbackFiles = 0;
  let discoveryMs = 0;
  let readMs = 0;
  let hashMs = 0;
  let parseMs = 0;
  let dbWriteMs = 0;
  let tsResolutionMs = 0;
  let tsResolutionCacheHits = 0;
  let tsResolutionCacheMisses = 0;
  let incrementalDependentFiles = 0;
  let incrementalExpansionTruncated = false;
  let incrementalExpansionReason: "maxDepth" | "maxFiles" | undefined;
  let cacheHitFiles = 0;
  let cacheHitParses = 0;
  const skippedByReason: Partial<Record<IndexSkipReason, number>> = {};
  const skippedFiles: IndexSkippedFile[] = [];
  const fallbackByLanguage = new Map<string, number>();
  const parserSourceCounts = new Map<string, number>();
  const slowestFiles: IndexSlowFile[] = [];
  const resolutionCache = new Map<string, string | undefined>();
  const directoryEntityUids = new Set<string>();
  const renameReconciledPaths = new Set<string>();
  let parsePool: ParseWorkerPool | undefined;
  let workerRestarts = 0;
  let workerTimeouts = 0;
  let dbQueryCount: number | undefined;

  try {
    const discoveryStartedAt = performance.now();
    const requestedFiles = request.files?.map((file) => path.resolve(scanRoot, file));
    const changedEntries =
      request.fromGitDiff || request.changedOnly
        ? changedFileEntriesFromGit(repoRoot, request.baseRef).filter((entry) => {
            const paths = [entry.path, entry.oldPath].filter(Boolean) as string[];
            return paths.some((file) => file === scanRoot || file.startsWith(`${scanRoot}${path.sep}`));
          })
        : undefined;
    const changedFromGit = changedEntries?.map((entry) => entry.path);
    const requiresFullDiscovery =
      !requestedFiles?.length && (!changedFromGit || changedFromGit.length === 0) && !request.changedOnly;
    const changedEntryByRelPath = new Map<string, { snapshotPath: string; adapter: LanguageAdapter; oldPublicApi: PublicApiSnapshot }>();

    if (changedEntries) {
      for (const entry of changedEntries) {
        if (!existsSync(entry.path)) {
          continue;
        }
        const relPath = normalizePath(path.relative(scanRoot, entry.path));
        const snapshotPath = normalizePath(path.relative(scanRoot, entry.oldPath ?? entry.path));
        const adapter = adapters.find((candidate) => candidate.canHandle(relPath));
        if (!adapter) {
          continue;
        }
        changedEntryByRelPath.set(relPath, {
          snapshotPath,
          adapter,
          oldPublicApi: snapshotPublicApi(adapter, db.getEntitiesForPath(snapshotPath))
        });
      }
    }

    if (changedEntries) {
      const staleWriteStartedAt = performance.now();
      db.transaction(() => {
        for (const entry of changedEntries) {
          let renameReconciled = false;
          if (entry.oldPath && entry.oldPath !== entry.path && existsSync(entry.path)) {
            const oldRelPath = normalizePath(path.relative(scanRoot, entry.oldPath));
            const newRelPath = normalizePath(path.relative(scanRoot, entry.path));
            const oldHashEntry = db.getFileHashEntry(oldRelPath);
            const currentStat = statSync(entry.path);
            const newHash =
              oldHashEntry && sameCachedFileState(oldHashEntry, Math.trunc(currentStat.mtimeMs), currentStat.size)
                ? oldHashEntry.hash
                : contentHash(readFileSync(entry.path, "utf8"));
            if (oldHashEntry?.hash && oldHashEntry.hash === newHash) {
              renameReconciled = db.renameAstDataPath(oldRelPath, newRelPath, stableNowIso());
              if (renameReconciled) {
                renameReconciledPaths.add(normalizePath(entry.path));
              }
            }
          }
          const stalePaths = [
            ...(entry.oldPath && entry.oldPath !== entry.path && !renameReconciled ? [entry.oldPath] : []),
            ...(!existsSync(entry.path) || entry.status.startsWith("D") ? [entry.path] : [])
          ];
          for (const stalePath of stalePaths) {
            if (stalePath === scanRoot || !stalePath.startsWith(`${scanRoot}${path.sep}`)) {
              continue;
            }
            const relPath = normalizePath(path.relative(scanRoot, stalePath));
            db.clearAstDataForPath(relPath);
            db.removeFileHash(relPath);
          }
        }
      });
      dbWriteMs += durationMs(staleWriteStartedAt);
    }

    const discovered = requiresFullDiscovery
      ? discoverFilesDetailed(scanRoot, {
          excludes: config.performance.exclude,
          maxFileSizeKb: config.performance.maxFileSizeKb
        })
      : undefined;

    let selectedFiles = requiresFullDiscovery
      ? discovered!.files
      : (requestedFiles ?? changedFromGit ?? []).filter((absPath) => existsSync(absPath));

    if (discovered) {
      filesSkipped += discovered.skipped.length;
      for (const skipped of discovered.skipped) {
        incrementSkipReason(skippedByReason, "tooLarge");
        recordSkippedFile(skippedFiles, {
          path: normalizePath(path.relative(scanRoot, skipped.path)),
          reason: "tooLarge",
          sizeBytes: skipped.sizeBytes
        });
      }
    }

    if (renameReconciledPaths.size > 0) {
      selectedFiles = selectedFiles.filter((absPath) => !renameReconciledPaths.has(normalizePath(absPath)));
    }

    selectedFiles = selectedFiles.sort();
    discoveryMs += durationMs(discoveryStartedAt);
    const checkpointName = `index:${scanRoot}`;
    const selectedRelPaths = selectedFiles.map((absPath) => normalizePath(path.relative(scanRoot, absPath)));
    const checkpointEligible =
      Boolean(request.full) &&
      !requestedFiles?.length &&
      !request.changedOnly &&
      !request.fromGitDiff &&
      !changedEntries;
    const manifestHash = checkpointEligible ? contentHash(JSON.stringify(selectedRelPaths)) : undefined;
    let restoredCheckpointState: CheckpointState | undefined;
    if (checkpointEligible && manifestHash) {
      const checkpoint = db.getCheckpoint(checkpointName);
      restoredCheckpointState = normalizeCheckpointState(checkpoint?.metadata, manifestHash, selectedRelPaths);
      if (restoredCheckpointState) {
        const completedFiles = new Set(restoredCheckpointState.completedFiles);
        selectedFiles = selectedFiles.filter((absPath) => !completedFiles.has(normalizePath(path.relative(scanRoot, absPath))));
        filesIndexed = restoredCheckpointState.filesIndexed;
        filesSkipped = restoredCheckpointState.filesSkipped;
        entityCount = restoredCheckpointState.entities;
        relationCount = restoredCheckpointState.relations;
        unresolvedCount = restoredCheckpointState.unresolvedReferences;
        lowConfidenceCount = restoredCheckpointState.lowConfidenceRelations;
        for (const language of restoredCheckpointState.languages) {
          languageSet.add(language);
        }
      } else if (checkpoint) {
        db.clearCheckpoint(checkpointName);
      }
    }

    const selectedEntries = selectedFiles.map((absPath) => ({
      absPath,
      relPath: normalizePath(path.relative(scanRoot, absPath)),
      sizeBytes: statSync(absPath).size
    }));
    const effectiveParallelism = effectiveParallelismForIndex(config.performance, selectedFiles.length);
    parsePool = parseWorkerPoolFor(adapters, config.performance, effectiveParallelism);
    const completedFiles = new Set<string>(restoredCheckpointState?.completedFiles ?? []);

    try {
      const processSelectedEntries = async (
        entries: Array<{ absPath: string; relPath: string; sizeBytes: number }>,
        options: { allowCheckpoint: boolean; forceFull: boolean }
      ): Promise<Array<{ relPath: string; publicApiSnapshot: PublicApiSnapshot }>> => {
        if (entries.length === 0) {
          return [];
        }
        const localPathIndex = buildPathResolutionIndex(new Set([...db.listFilesInHashTable(), ...entries.map((entry) => entry.relPath)]));
        const localKnownHashes = db.getFileHashEntries(entries.map((entry) => entry.relPath));
        const parsedPublicApiSnapshots: Array<{ relPath: string; publicApiSnapshot: PublicApiSnapshot }> = [];
        const parseWindows = chunkEntriesByByteBudget(
          entries,
          config.performance.indexMemoryBudgetMb * 1024 * 1024,
          (entry) => entry.sizeBytes
        );

        for (const windowEntries of parseWindows) {
          const parsedResults = await mapWithConcurrency(
            windowEntries,
            effectiveParallelism,
            (entry) =>
              parseOne(
                entry.absPath,
                scanRoot,
                db,
                adapters,
                localKnownHashes.get(entry.relPath),
                resolutionCache,
                localPathIndex,
                options.forceFull || Boolean(request.full),
                config.performance.maxFileSizeKb * 1024,
                parsePool
              )
          );

          const writableFiles: IndexedAstFile[] = [];
          for (const result of parsedResults) {
            readMs += result.telemetry.readMs;
            hashMs += result.telemetry.hashMs;
            parseMs += result.telemetry.parseMs;
            dbWriteMs += result.telemetry.dbWriteMs;
            tsResolutionMs += result.telemetry.tsResolutionMs;
            tsResolutionCacheHits += result.telemetry.tsResolutionCacheHits;
            tsResolutionCacheMisses += result.telemetry.tsResolutionCacheMisses;
            workerRestarts += result.telemetry.workerRestarts;
            workerTimeouts += result.telemetry.workerTimeouts;
            if (result.telemetry.cacheHitFile) {
              cacheHitFiles += 1;
            }
            if (result.telemetry.cacheHitParse) {
              cacheHitParses += 1;
            }
            if (result.kind === "unsupported") {
              filesSkipped += 1;
              incrementSkipReason(skippedByReason, "unsupported");
              continue;
            }
            languageSet.add(result.language);
            if (result.kind === "skipped") {
              filesSkipped += 1;
              incrementSkipReason(skippedByReason, result.reason);
              if (result.reason !== "unchanged" && result.reason !== "unsupported") {
                recordSkippedFile(skippedFiles, {
                  path: result.relPath,
                  reason: result.reason,
                  sizeBytes: result.sizeBytes,
                  language: result.language
                });
              }
              continue;
            }
            parsedPublicApiSnapshots.push({
              relPath: result.relPath,
              publicApiSnapshot: result.publicApiSnapshot
            });
            const entitiesToWrite = result.entities.filter((entity) => {
              if (entity.kind !== "directory") {
                return true;
              }
              if (directoryEntityUids.has(entity.uid)) {
                return false;
              }
              directoryEntityUids.add(entity.uid);
              return true;
            });
            writableFiles.push({
              relPath: result.relPath,
              language: result.language,
              hash: result.hash,
              indexedAt: result.nowIso,
              mtimeMs: result.mtimeMs,
              sizeBytes: result.sizeBytes,
              entities: entitiesToWrite,
              relations: result.relations,
              unresolved: result.unresolved
            });
            recordSlowFile(slowestFiles, {
              path: result.relPath,
              ms: result.telemetry.totalMs,
              sizeBytes: result.sizeBytes,
              language: result.language
            });
            if (result.usedFallback) {
              parserFallbackFiles += 1;
              fallbackByLanguage.set(result.language, (fallbackByLanguage.get(result.language) ?? 0) + 1);
            }
            for (const source of result.parserSources) {
              parserSourceCounts.set(source, (parserSourceCounts.get(source) ?? 0) + 1);
            }
          }

          const writeBatchSize = Math.max(32, effectiveParallelism * 8);
          for (const batch of chunkItems(writableFiles, writeBatchSize)) {
            const batchWriteStartedAt = performance.now();
            db.transaction(() => {
              db.replaceAstFiles(batch);
              for (const file of batch) {
                languageSet.add(file.language);
                filesIndexed += 1;
                entityCount += file.entities.length;
                relationCount += file.relations.length;
                unresolvedCount += file.unresolved.length;
                for (const relation of file.relations) {
                  if (relation.confidence < 0.4) {
                    lowConfidenceCount += 1;
                  }
                }
              }
              if (options.allowCheckpoint && checkpointEligible && manifestHash) {
                for (const file of batch) {
                  completedFiles.add(file.relPath);
                }
                const checkpointState: CheckpointState = {
                  manifestHash,
                  completedFiles: [...completedFiles].sort(),
                  filesIndexed,
                  filesSkipped,
                  languages: [...languageSet].sort(),
                  entities: entityCount,
                  relations: relationCount,
                  unresolvedReferences: unresolvedCount,
                  lowConfidenceRelations: lowConfidenceCount
                };
                db.saveCheckpoint(checkpointName, stableNowIso(), checkpointState);
                db.updateRunProgress(runId, filesIndexed, filesSkipped, checkpointState);
              }
            });
            dbWriteMs += durationMs(batchWriteStartedAt);
          }
        }

        return parsedPublicApiSnapshots;
      };

      const directParsedPublicApi = await processSelectedEntries(selectedEntries, {
        allowCheckpoint: checkpointEligible,
        forceFull: false
      });

      if (changedEntries && changedEntries.length > 0) {
        const changedSeeds: IncrementalSeed[] = [];
        for (const parsed of directParsedPublicApi) {
          const oldSnapshot = changedEntryByRelPath.get(parsed.relPath);
          if (!oldSnapshot) {
            continue;
          }
          if (oldSnapshot.oldPublicApi.fingerprint !== parsed.publicApiSnapshot.fingerprint) {
            changedSeeds.push({
              relPath: parsed.relPath,
              snapshotPath: oldSnapshot.snapshotPath,
              oldPublicUids: oldSnapshot.oldPublicApi.publicUids
            });
          }
        }

        if (changedSeeds.length > 0) {
          const directSelection = new Set(selectedEntries.map((entry) => entry.relPath));
          const expanded = expandReverseDependents(db, changedSeeds, directSelection);
          incrementalExpansionTruncated = expanded.truncated;
          incrementalExpansionReason = expanded.reason;
          const dependentEntries = expanded.files
            .filter((relPath) => !directSelection.has(relPath))
            .map((relPath) => path.resolve(scanRoot, relPath))
            .filter((absPath) => existsSync(absPath))
            .sort()
            .map((absPath) => ({
              absPath,
              relPath: normalizePath(path.relative(scanRoot, absPath)),
              sizeBytes: statSync(absPath).size
            }));

          incrementalDependentFiles = dependentEntries.length;
          await processSelectedEntries(dependentEntries, { allowCheckpoint: false, forceFull: true });
        }
      }
    } finally {
      workerRestarts += parsePool?.getStats().restarts ?? 0;
      workerTimeouts += parsePool?.getStats().timeouts ?? 0;
      await parsePool?.close();
      parsePool = undefined;
    }

    const allFiles = filesIndexed + filesSkipped;
    const estimatedCoverage = allFiles === 0 ? 0 : filesIndexed / allFiles;
    const maintenanceStartedAt = performance.now();
    db.maintainCaches();
    db.optimize();
    dbWriteMs += durationMs(maintenanceStartedAt);
    if (checkpointEligible) {
      const checkpointClearStartedAt = performance.now();
      db.clearCheckpoint(checkpointName);
      dbWriteMs += durationMs(checkpointClearStartedAt);
    }
    const summary: IndexSummary = {
      mode: request.fromGitDiff ? "update" : "index",
      filesScanned: allFiles,
      filesIndexed,
      filesSkipped,
      languages: [...languageSet].sort(),
      entities: entityCount,
      relations: relationCount,
      unresolvedReferences: unresolvedCount,
      lowConfidenceRelations: lowConfidenceCount,
      estimatedCoverage,
      telemetry: {
        discoveryMs,
        readMs,
        hashMs,
        parseMs,
        dbWriteMs,
        tsResolutionMs,
        tsResolutionCacheHits,
        tsResolutionCacheMisses,
        incrementalDependentFiles,
        incrementalExpansionTruncated,
        incrementalExpansionReason,
        cacheHitFiles,
        cacheHitParses,
        workerRestarts,
        workerTimeouts,
        parserFallbackFiles,
        fallbackByLanguage: Object.fromEntries([...fallbackByLanguage.entries()].sort(([a], [b]) => a.localeCompare(b))),
        parserSourceCounts: Object.fromEntries([...parserSourceCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
        skippedByReason,
        skippedFiles,
        slowestFiles,
        dbQueryCount
      }
    };
    db.finishRun(runId, "ok", stableNowIso(), summary);
    return summary;
  } catch (error) {
    await parsePool?.close();
    db.finishRun(runId, "failed", stableNowIso(), {
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

export async function bootstrapRepository(
  db: DSPDatabase,
  adapters: LanguageAdapter[],
  rootDir: string,
  config: DSPConfig,
  options: {
    lazy?: boolean;
    noEmbeddings?: boolean;
    dryRun?: boolean;
    largeRepo?: boolean;
  } = {}
): Promise<IndexSummary> {
  if (options.largeRepo) {
    config.performance.mode = "large-repo";
    config.performance.lazyIndexing = true;
  }
  if (options.dryRun) {
    const discovered = discoverFilesDetailed(rootDir, {
      excludes: config.performance.exclude,
      maxFileSizeKb: config.performance.maxFileSizeKb
    });
    return {
      mode: "bootstrap",
      filesScanned: discovered.files.length + discovered.skipped.length,
      filesIndexed: 0,
      filesSkipped: discovered.files.length + discovered.skipped.length,
      languages: [],
      entities: 0,
      relations: 0,
      unresolvedReferences: 0,
      lowConfidenceRelations: 0,
      estimatedCoverage: 0
    };
  }
  const summary = await indexRepository(
    db,
    adapters,
    {
      rootDir,
      lazy: options.lazy ?? config.performance.lazyIndexing,
      full: true
    },
    config
  );
  return {
    ...summary,
    mode: "bootstrap"
  };
}

export function changedFiles(db: DSPDatabase, rootDir: string, baseRef?: string): string[] {
  const scanRoot = path.resolve(rootDir);
  const repoRoot = findRepoRoot(scanRoot);
  const gitChanged = changedFilesFromGit(repoRoot, baseRef).filter((file) => {
    if (file === scanRoot) {
      return true;
    }
    return file.startsWith(`${scanRoot}${path.sep}`);
  });
  const indexed = new Set(db.listFilesInHashTable());
  return gitChanged
    .map((file) => normalizePath(path.relative(scanRoot, file)))
    .filter((rel) => indexed.has(rel));
}
