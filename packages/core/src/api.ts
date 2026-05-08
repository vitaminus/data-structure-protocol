import path from "node:path";
import fs from "node:fs";
import type {
  ContextPackRequest,
  ContextPackResponse,
  FileIndexRequest,
  ImpactResult,
  IndexSummary,
  EmbeddingProvider,
  LanguageAdapter,
  RepairResult,
  SearchResult,
  ValidationOptions,
  ValidationResult
} from "./graph/types.ts";
import { DSPDatabase } from "./storage/db.ts";
import { loadConfig, writeDefaultConfig } from "./config/config.ts";
import type { DSPConfig } from "./config/types.ts";
import { buildContextPack } from "./graph/context-pack.ts";
import { indexRepository, bootstrapRepository, changedFiles } from "./indexer/indexer.ts";
import { semanticSearch } from "./semantic/search.ts";
import { analyzeImpact } from "./impact/impact.ts";
import { validateGraph } from "./validate/validate.ts";
import { repairGraph } from "./validate/repair.ts";
import { insertSourceMarkers } from "./markers/markers.ts";
import { createEmbeddingProvider, MockEmbeddingProvider } from "./semantic/providers.ts";
import { contentHash, normalizePath } from "./graph/uid.ts";
import { discoverFiles } from "./util/fs.ts";

export type DSPServices = {
  rootDir: string;
  db: DSPDatabase;
  config: DSPConfig;
  embeddingProvider?: EmbeddingProvider;
  adapters: LanguageAdapter[];
};

export type WatchSummary = {
  initialIndexed: boolean;
  cycles: number;
  filesIndexed: number;
  filesDeleted: number;
  lastSummary?: IndexSummary;
};

export function initDSP(rootDir: string): { rootDir: string; dbPath: string; createdConfig: boolean } {
  const resolved = path.resolve(rootDir);
  const dspDir = path.join(resolved, ".dsp");
  fs.mkdirSync(dspDir, { recursive: true });
  const configTarget = path.join(dspDir, "config.json");
  const createdConfig = !fs.existsSync(configTarget);
  if (createdConfig) {
    writeDefaultConfig(resolved);
  }
  const db = new DSPDatabase(resolved);
  db.close();
  return {
    rootDir: resolved,
    dbPath: path.join(dspDir, "dsp.sqlite"),
    createdConfig
  };
}

export function openDSP(rootDir: string, adapters: LanguageAdapter[]): DSPServices {
  const resolved = path.resolve(rootDir);
  const config = loadConfig(resolved);
  return {
    rootDir: resolved,
    db: new DSPDatabase(resolved),
    config,
    embeddingProvider: createEmbeddingProvider(config),
    adapters
  };
}

export async function runIndex(
  services: DSPServices,
  request: FileIndexRequest
): Promise<IndexSummary> {
  return indexRepository(services.db, services.adapters, request, services.config);
}

export async function runBootstrap(
  services: DSPServices,
  options: {
    lazy?: boolean;
    noEmbeddings?: boolean;
    dryRun?: boolean;
    largeRepo?: boolean;
  }
): Promise<IndexSummary> {
  return bootstrapRepository(services.db, services.adapters, services.rootDir, services.config, options);
}

export function runChanged(services: DSPServices): string[] {
  return changedFiles(services.db, services.rootDir);
}

export async function runSearch(
  services: DSPServices,
  query: string,
  opts: { topK?: number; embeddingsEnabled?: boolean } = {}
): Promise<SearchResult[]> {
  const embeddingsEnabled =
    opts.embeddingsEnabled ?? Boolean(services.config.embeddings.enabled && services.embeddingProvider);
  return semanticSearch(services.db, query, {
    topK: opts.topK,
    embeddingsEnabled,
    provider: embeddingsEnabled ? services.embeddingProvider : undefined
  });
}

export function runImpact(services: DSPServices, target: string): ImpactResult {
  return analyzeImpact(services.db, target);
}

export function runValidate(
  services: DSPServices,
  options: ValidationOptions = {}
): ValidationResult {
  return validateGraph(services.db, services.rootDir, options);
}

export async function runRepair(
  services: DSPServices,
  options: { dryRun?: boolean } = {}
): Promise<RepairResult> {
  return repairGraph(services.db, services.rootDir, services.adapters, services.config, options);
}

export async function runContextPack(
  services: DSPServices,
  request: ContextPackRequest
): Promise<ContextPackResponse> {
  return buildContextPack(services, request);
}

export function runExport(
  services: DSPServices,
  format: "json" | "jsonl" | "dsp" | "protocol",
  targetPath?: string
): { format: "json" | "jsonl" | "dsp" | "protocol"; targetPath: string } {
  if (format === "json") {
    const finalPath = targetPath ?? path.join(services.rootDir, ".dsp", "graph.json");
    services.db.exportJson(finalPath);
    return { format, targetPath: finalPath };
  }
  if (format === "jsonl") {
    const finalPath = targetPath ?? path.join(services.rootDir, ".dsp", "jsonl");
    services.db.exportJsonl(finalPath);
    return { format, targetPath: finalPath };
  }
  if (format === "protocol") {
    services.db.exportProtocol(services.rootDir);
    return { format, targetPath: path.join(services.rootDir, ".dsp", "protocol") };
  }
  services.db.exportDsp(services.rootDir);
  return { format, targetPath: path.join(services.rootDir, ".dsp", "export") };
}

export function runMarkersApply(
  services: DSPServices,
  options: { dryRun?: boolean } = {}
): { filesChanged: number; markersInserted: number; paths: string[] } {
  return insertSourceMarkers(services.db, services.rootDir, options);
}

export function runImport(
  services: DSPServices,
  sourcePath: string
): { entities: number; relations: number; unresolvedReferences: number } {
  const snapshot = services.db.importJson(sourcePath);
  return {
    entities: snapshot.entities.length,
    relations: snapshot.relations.length,
    unresolvedReferences: snapshot.unresolvedReferences.length
  };
}

export async function runEmbeddingsUpdate(
  services: DSPServices,
  options: { changedOnly?: boolean } = {}
): Promise<{ updated: number; skipped: number; provider: string }> {
  const provider = services.embeddingProvider ?? new MockEmbeddingProvider();
  const providerKey = provider.cacheKey?.() ?? provider.constructor.name;
  let updated = 0;
  let skipped = 0;
  const now = new Date().toISOString();
  for (const entity of services.db.iterateEntitiesOrdered()) {
    const semanticText = [
      entity.name,
      entity.signature ?? "",
      entity.description ?? "",
      entity.docstring ?? ""
    ].join("\n");
    const hash = contentHash(semanticText);
    const existing = services.db.getEmbedding(entity.uid);
    if (options.changedOnly && existing?.hash === hash && existing.provider === providerKey) {
      skipped += 1;
      continue;
    }
    const vector = await provider.embed(semanticText);
    services.db.setEmbedding(entity.uid, hash, vector, providerKey, now);
    updated += 1;
  }
  return { updated, skipped, provider: providerKey };
}

function statFingerprint(filePath: string): string {
  const stat = fs.statSync(filePath);
  return `${Math.trunc(stat.mtimeMs)}:${stat.size}`;
}

function currentWatchSnapshot(services: DSPServices): Map<string, string> {
  const files = discoverFiles(services.rootDir, {
    excludes: services.config.performance.exclude,
    maxFileSizeKb: services.config.performance.maxFileSizeKb
  });
  const snapshot = new Map<string, string>();
  for (const absPath of files) {
    snapshot.set(normalizePath(path.relative(services.rootDir, absPath)), statFingerprint(absPath));
  }
  return snapshot;
}

export async function watchRepository(
  services: DSPServices,
  options: {
    intervalMs?: number;
    runInitialIndex?: boolean;
    onCycle?: (summary: WatchSummary) => void;
  } = {}
): Promise<void> {
  const intervalMs = Math.max(100, options.intervalMs ?? 1000);
  let snapshot = currentWatchSnapshot(services);
  const summary: WatchSummary = {
    initialIndexed: false,
    cycles: 0,
    filesIndexed: 0,
    filesDeleted: 0
  };

  if (options.runInitialIndex ?? true) {
    summary.lastSummary = await runIndex(services, {
      rootDir: services.rootDir,
      full: true
    });
    summary.initialIndexed = true;
    options.onCycle?.({ ...summary });
    snapshot = currentWatchSnapshot(services);
  }

  await new Promise<void>((resolve, reject) => {
    let polling = false;
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;

    const stop = () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
      }
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve();
    };

    const onSignal = () => stop();

    const tick = async () => {
      if (stopped || polling) {
        return;
      }
      polling = true;
      try {
        const nextSnapshot = currentWatchSnapshot(services);
        const changed = new Set<string>();
        const deleted: string[] = [];

        for (const [filePath, fingerprint] of nextSnapshot) {
          if (snapshot.get(filePath) !== fingerprint) {
            changed.add(filePath);
          }
        }
        for (const filePath of snapshot.keys()) {
          if (!nextSnapshot.has(filePath)) {
            deleted.push(filePath);
          }
        }

        if (deleted.length > 0) {
          services.db.transaction(() => {
            for (const filePath of deleted) {
              services.db.clearAstDataForPath(filePath);
              services.db.removeFileHash(filePath);
            }
          });
          summary.filesDeleted += deleted.length;
        }

        if (changed.size > 0) {
          const indexSummary = await runIndex(services, {
            rootDir: services.rootDir,
            files: [...changed]
          });
          summary.lastSummary = indexSummary;
          summary.filesIndexed += indexSummary.filesIndexed;
        }

        if (changed.size > 0 || deleted.length > 0) {
          summary.cycles += 1;
          options.onCycle?.({ ...summary });
        }
        snapshot = nextSnapshot;
      } catch (error) {
        stopped = true;
        if (timer) {
          clearInterval(timer);
        }
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        reject(error);
      } finally {
        polling = false;
      }
    };

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
  });
}
