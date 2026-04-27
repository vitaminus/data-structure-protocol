import path from "node:path";
import fs from "node:fs";
import type {
  ContextPackRequest,
  ContextPackResponse,
  FileIndexRequest,
  ImpactResult,
  IndexSummary,
  LanguageAdapter,
  SearchResult,
  ValidationResult
} from "./graph/types.js";
import { DSPDatabase } from "./storage/db.js";
import { loadConfig, writeDefaultConfig } from "./config/config.js";
import { buildContextPack } from "./graph/context-pack.js";
import { indexRepository, bootstrapRepository, changedFiles } from "./indexer/indexer.js";
import { semanticSearch } from "./semantic/search.js";
import { analyzeImpact } from "./impact/impact.js";
import { validateGraph } from "./validate/validate.js";
import { MockEmbeddingProvider } from "./semantic/providers.js";
import { contentHash } from "./graph/uid.js";

export type DSPServices = {
  rootDir: string;
  db: DSPDatabase;
  adapters: LanguageAdapter[];
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
  return {
    rootDir: resolved,
    db: new DSPDatabase(resolved),
    adapters
  };
}

export async function runIndex(
  services: DSPServices,
  request: FileIndexRequest
): Promise<IndexSummary> {
  const config = loadConfig(services.rootDir);
  return indexRepository(services.db, services.adapters, request, config);
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
  const config = loadConfig(services.rootDir);
  return bootstrapRepository(services.db, services.adapters, services.rootDir, config, options);
}

export function runChanged(services: DSPServices): string[] {
  return changedFiles(services.db, services.rootDir);
}

export async function runSearch(
  services: DSPServices,
  query: string,
  opts: { topK?: number; embeddingsEnabled?: boolean } = {}
): Promise<SearchResult[]> {
  return semanticSearch(services.db, query, {
    topK: opts.topK,
    embeddingsEnabled: opts.embeddingsEnabled ?? false
  });
}

export function runImpact(services: DSPServices, target: string): ImpactResult {
  return analyzeImpact(services.db, target);
}

export function runValidate(services: DSPServices): ValidationResult {
  return validateGraph(services.db, services.rootDir);
}

export async function runContextPack(
  services: DSPServices,
  request: ContextPackRequest
): Promise<ContextPackResponse> {
  return buildContextPack(services.db, request);
}

export function runExport(
  services: DSPServices,
  format: "json" | "dsp",
  targetPath?: string
): { format: "json" | "dsp"; targetPath: string } {
  if (format === "json") {
    const finalPath = targetPath ?? path.join(services.rootDir, ".dsp", "graph.json");
    services.db.exportJson(finalPath);
    return { format, targetPath: finalPath };
  }
  services.db.exportDsp(services.rootDir);
  return { format, targetPath: path.join(services.rootDir, ".dsp", "export") };
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
  const provider = new MockEmbeddingProvider();
  const entities = services.db.getEntities(200000);
  let updated = 0;
  let skipped = 0;
  const now = new Date().toISOString();
  for (const entity of entities) {
    const semanticText = [
      entity.name,
      entity.signature ?? "",
      entity.description ?? "",
      entity.docstring ?? ""
    ].join("\n");
    const hash = contentHash(semanticText);
    const existing = services.db.getEmbedding(entity.uid);
    if (options.changedOnly && existing?.hash === hash) {
      skipped += 1;
      continue;
    }
    const vector = await provider.embed(semanticText);
    services.db.setEmbedding(entity.uid, hash, vector, "mock", now);
    updated += 1;
  }
  return { updated, skipped, provider: "mock" };
}
