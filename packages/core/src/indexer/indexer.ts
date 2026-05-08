import path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import type {
  Entity,
  FileIndexRequest,
  IndexSummary,
  LanguageAdapter,
  Relation,
  UnresolvedReference
} from "../graph/types.ts";
import { buildUid, contentHash, normalizePath, stableNowIso } from "../graph/uid.ts";
import { discoverFiles, findRepoRoot } from "../util/fs.ts";
import { changedFileEntriesFromGit, changedFilesFromGit } from "../util/git.ts";
import { ParseWorkerPool } from "./parse-pool.ts";
import type { DSPDatabase, FileHashEntry, IndexedAstFile } from "../storage/db.ts";
import type { DSPConfig } from "../config/types.ts";

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

function canonicalFilePath(
  targetRelPath: string,
  fromRelPath: string | undefined,
  scanRoot: string,
  resolutionCache: Map<string, string | undefined>
): string | undefined {
  const cacheKey = `${fromRelPath ?? ""}\0${targetRelPath}`;
  const cached = resolutionCache.get(cacheKey);
  if (resolutionCache.has(cacheKey)) {
    return cached;
  }
  const resolved = pathCandidates(targetRelPath, fromRelPath).find((candidate) =>
    existsSync(path.resolve(scanRoot, candidate))
  );
  resolutionCache.set(cacheKey, resolved);
  return resolved;
}

function canonicalizeFileRelations(
  relations: Relation[],
  scanRoot: string,
  resolutionCache: Map<string, string | undefined>
): Relation[] {
  return relations.map((relation) => {
    const targetRelPath = filePathFromFileUid(relation.to);
    if (!targetRelPath) {
      return relation;
    }
    const fromRelPath = filePathFromFileUid(relation.from);
    const resolvedPath = canonicalFilePath(targetRelPath, fromRelPath, scanRoot, resolutionCache);
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
    }
  | {
      kind: "skipped";
      relPath: string;
      language: string;
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

function parseWorkerPoolFor(adapters: LanguageAdapter[], config: DSPConfig["performance"]): ParseWorkerPool | undefined {
  const parallelism = config.parallelism;
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
  adapters: LanguageAdapter[],
  cachedHash: FileHashEntry | undefined,
  resolutionCache: Map<string, string | undefined>,
  full: boolean,
  workerPool?: ParseWorkerPool
): Promise<ParseOneResult> {
  const relPath = normalizePath(path.relative(scanRoot, absPath));
  const language = languageFromFile(relPath);
  if (!language) {
    return { kind: "unsupported", relPath };
  }
  const adapter = adapters.find((candidate) => candidate.canHandle(relPath));
  if (!adapter) {
    return { kind: "unsupported", relPath };
  }

  const stat = statSync(absPath);
  const mtimeMs = Math.trunc(stat.mtimeMs);
  const sizeBytes = stat.size;
  if (!full && sameCachedFileState(cachedHash, mtimeMs, sizeBytes)) {
    return { kind: "skipped", relPath, language: adapter.language };
  }

  const content = readFileSync(absPath, "utf8");
  const hash = contentHash(content);
  if (!full && cachedHash?.hash === hash) {
    return { kind: "skipped", relPath, language: adapter.language };
  }

  const parsed =
    workerPool && adapter.worker
      ? await workerPool.run(adapter.worker, relPath, content)
      : await adapter.parseFile(relPath, content);
  const parsedEntities = adapter.extractEntities(parsed);
  const parsedRelations = adapter.extractRelations(parsed, parsedEntities);
  const extracted = applyStableMarkers(content, parsedEntities, parsedRelations);
  const nowIso = stableNowIso();

  const fileNode = fileEntity(relPath, adapter.language, nowIso);
  const testNode = testEntityForFile(relPath, nowIso);
  const directories = dirEntitiesForFile(relPath, nowIso);
  const extractedEntities = extracted.entities;
  const extractedRelations = canonicalizeFileRelations(
    persistedRelationsForFile(fileNode.uid, extracted.relations),
    scanRoot,
    resolutionCache
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
    usedFallback: parserSources.some((source) => source !== "ast" && source !== "test" && source !== "human")
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
  const fallbackByLanguage = new Map<string, number>();
  const parserSourceCounts = new Map<string, number>();
  const resolutionCache = new Map<string, string | undefined>();
  const directoryEntityUids = new Set<string>();
  const parsePool = parseWorkerPoolFor(adapters, config.performance);

  try {
    const requestedFiles = request.files?.map((file) => path.resolve(scanRoot, file));
    const changedEntries =
      request.fromGitDiff || request.changedOnly
        ? changedFileEntriesFromGit(repoRoot).filter((entry) => {
            const paths = [entry.path, entry.oldPath].filter(Boolean) as string[];
            return paths.some((file) => file === scanRoot || file.startsWith(`${scanRoot}${path.sep}`));
          })
        : undefined;
    const changedFromGit = changedEntries?.map((entry) => entry.path);
    const requiresFullDiscovery =
      !requestedFiles?.length && (!changedFromGit || changedFromGit.length === 0) && !request.changedOnly;

    if (changedEntries) {
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
    }

    let selectedFiles = requiresFullDiscovery
      ? discoverFiles(scanRoot, {
          excludes: config.performance.exclude,
          maxFileSizeKb: config.performance.maxFileSizeKb
        })
      : (requestedFiles ?? changedFromGit ?? []).filter((absPath) => existsSync(absPath));

    if (changedFromGit && changedFromGit.length > 0) {
      const changedUids = changedFromGit.map((absPath) =>
        buildUid("file", normalizePath(path.relative(scanRoot, absPath)))
      );
      const neighborRelPaths = new Set<string>();
      for (const uid of changedUids) {
        for (const incoming of db.getRelationsTo(uid)) {
          const fromEntity = db.getEntity(incoming.from);
          if (fromEntity?.path) {
            neighborRelPaths.add(fromEntity.path);
          }
        }
      }
      for (const relPath of neighborRelPaths) {
        selectedFiles.push(path.resolve(scanRoot, relPath));
      }
      selectedFiles = [...new Set(selectedFiles)];
    }

    selectedFiles = selectedFiles.sort();
    const checkpointName = `index:${scanRoot}`;
    const selectedRelPaths = selectedFiles.map((absPath) => normalizePath(path.relative(scanRoot, absPath)));
    const checkpointEligible =
      Boolean(request.full) &&
      !requestedFiles?.length &&
      !request.changedOnly &&
      !request.fromGitDiff &&
      !changedEntries;
    const manifestHash = checkpointEligible ? contentHash(JSON.stringify(selectedRelPaths)) : undefined;
    if (checkpointEligible && manifestHash) {
      const checkpoint = db.getCheckpoint(checkpointName);
      const checkpointMeta = checkpoint?.metadata as Partial<CheckpointState> | undefined;
      if (checkpointMeta?.manifestHash === manifestHash) {
        const completedFiles = new Set(
          Array.isArray(checkpointMeta.completedFiles)
            ? checkpointMeta.completedFiles.filter((value): value is string => typeof value === "string")
            : []
        );
        if (completedFiles.size > 0) {
          selectedFiles = selectedFiles.filter(
            (absPath) => !completedFiles.has(normalizePath(path.relative(scanRoot, absPath)))
          );
          filesIndexed = Number(checkpointMeta.filesIndexed ?? 0);
          filesSkipped = Number(checkpointMeta.filesSkipped ?? 0);
          entityCount = Number(checkpointMeta.entities ?? 0);
          relationCount = Number(checkpointMeta.relations ?? 0);
          unresolvedCount = Number(checkpointMeta.unresolvedReferences ?? 0);
          lowConfidenceCount = Number(checkpointMeta.lowConfidenceRelations ?? 0);
          for (const language of checkpointMeta.languages ?? []) {
            if (typeof language === "string") {
              languageSet.add(language);
            }
          }
        }
      } else if (checkpoint) {
        db.clearCheckpoint(checkpointName);
      }
    }

    const activeSelectedRelPaths = selectedFiles.map((absPath) => normalizePath(path.relative(scanRoot, absPath)));
    const knownHashes = db.getFileHashEntries(activeSelectedRelPaths);

    const parsedResults = await (async () => {
      try {
        return await mapWithConcurrency(
          selectedFiles,
          config.performance.parallelism,
          (absPath, index) =>
            parseOne(
              absPath,
              scanRoot,
              adapters,
              knownHashes.get(activeSelectedRelPaths[index]!),
              resolutionCache,
              request.full ?? false,
              parsePool
            )
        );
      } finally {
        await parsePool?.close();
      }
    })();

    const writableFiles: IndexedAstFile[] = [];

    for (const result of parsedResults) {
      if (result.kind === "unsupported") {
        filesSkipped += 1;
        continue;
      }
      languageSet.add(result.language);
      if (result.kind === "skipped") {
        filesSkipped += 1;
        continue;
      }
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
      if (result.usedFallback) {
        parserFallbackFiles += 1;
        fallbackByLanguage.set(result.language, (fallbackByLanguage.get(result.language) ?? 0) + 1);
      }
      for (const source of result.parserSources) {
        parserSourceCounts.set(source, (parserSourceCounts.get(source) ?? 0) + 1);
      }
    }

    const writeBatchSize = Math.max(32, config.performance.parallelism * 8);
    const completedFiles = new Set<string>(
      checkpointEligible && manifestHash
        ? (((db.getCheckpoint(checkpointName)?.metadata as Partial<CheckpointState> | undefined)?.completedFiles as
            | string[]
            | undefined) ?? [])
        : []
    );
    for (const batch of chunkItems(writableFiles, writeBatchSize)) {
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
        if (checkpointEligible && manifestHash) {
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
    }

    const allFiles = filesIndexed + filesSkipped;
    const estimatedCoverage = allFiles === 0 ? 0 : filesIndexed / allFiles;
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
        parserFallbackFiles,
        fallbackByLanguage: Object.fromEntries([...fallbackByLanguage.entries()].sort(([a], [b]) => a.localeCompare(b))),
        parserSourceCounts: Object.fromEntries([...parserSourceCounts.entries()].sort(([a], [b]) => a.localeCompare(b)))
      }
    };
    db.optimize();
    if (checkpointEligible) {
      db.clearCheckpoint(checkpointName);
    }
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
    const discovered = discoverFiles(rootDir, {
      excludes: config.performance.exclude,
      maxFileSizeKb: config.performance.maxFileSizeKb
    });
    return {
      mode: "bootstrap",
      filesScanned: discovered.length,
      filesIndexed: 0,
      filesSkipped: discovered.length,
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

export function changedFiles(db: DSPDatabase, rootDir: string): string[] {
  const scanRoot = path.resolve(rootDir);
  const repoRoot = findRepoRoot(scanRoot);
  const gitChanged = changedFilesFromGit(repoRoot).filter((file) => {
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
