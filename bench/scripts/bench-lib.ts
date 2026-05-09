import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  buildContextPack,
  buildUid,
  contentHash,
  DSPDatabase,
  indexRepository,
  type IndexTelemetry,
  MockEmbeddingProvider,
  semanticSearch,
  stableNowIso,
  validateGraph,
  type LanguageAdapter,
  type ParseResult
} from "../../packages/core/src/index.ts";
import { DEFAULT_CONFIG } from "../../packages/core/src/config/types.ts";

export type BenchResult = {
  case: string;
  parallelism: number;
  coldBootstrapMs: number;
  warmIndexMs: number;
  changedOnlyMs: number;
  searchP50Ms: number;
  searchP95Ms: number;
  searchCandidatesP50: number;
  contextPackP50Ms: number;
  contextPackP95Ms: number;
  retrievalRecallAt5: number;
  retrievalRecallAt10: number;
  validateMs: number;
  rssMb: number;
  dbSizeMb: number;
  parserFallbackFiles: number;
  workerRestarts: number;
  workerTimeouts: number;
  dbQueryCount?: number;
  coldTelemetry?: IndexTelemetry;
  warmTelemetry?: IndexTelemetry;
  changedTelemetry?: IndexTelemetry;
};

export type BenchCase = {
  name: string;
  files: number;
  searchIterations: number;
  contextIterations: number;
};

type GoldenQuery = {
  query: string;
  expectedPathIncludes: string[];
};

export const CASES: BenchCase[] = [
  { name: "tiny-synthetic-ts", files: 20, searchIterations: 10, contextIterations: 5 },
  { name: "medium-synthetic-ts", files: 120, searchIterations: 20, contextIterations: 10 },
  { name: "large-synthetic-ts", files: 400, searchIterations: 30, contextIterations: 12 }
];

const GOLDEN_QUERIES = JSON.parse(
  fs.readFileSync(path.resolve("bench/queries/retrieval.json"), "utf8")
) as GoldenQuery[];

class BenchAdapter implements LanguageAdapter {
  language = "typescript";

  canHandle(filePath: string): boolean {
    return filePath.endsWith(".ts");
  }

  async parseFile(filePath: string): Promise<ParseResult> {
    const now = stableNowIso();
    const uid = buildUid("function", filePath, "handleAuth");
    return {
      entities: [
        {
          uid,
          kind: "function",
          name: "handleAuth",
          path: filePath,
          language: "typescript",
          description: "auth token validation handler",
          confidence: 1,
          provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
          createdAt: now,
          updatedAt: now
        }
      ],
      relations: [],
      unresolvedReferences: []
    };
  }

  extractEntities(parseResult: ParseResult) {
    return parseResult.entities;
  }

  extractRelations(parseResult: ParseResult) {
    return parseResult.relations;
  }

  extractPublicAPI() {
    return [];
  }
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

async function timedAsync<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

function createFixture(rootDir: string, files: number): void {
  fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
  for (let index = 0; index < files; index += 1) {
    fs.writeFileSync(
      path.join(rootDir, "src", `auth-${index}.ts`),
      `export function handleAuth${index}(token: string) { return token.length > ${index % 7}; }\n`,
      "utf8"
    );
  }
}

async function recallAt5(db: DSPDatabase): Promise<number> {
  return recallAtK(db, 5);
}

async function recallAt10(db: DSPDatabase): Promise<number> {
  return recallAtK(db, 10);
}

async function recallAtK(db: DSPDatabase, topK: number): Promise<number> {
  const provider = new MockEmbeddingProvider();
  let hits = 0;
  for (const golden of GOLDEN_QUERIES) {
    const results = await semanticSearch(db, golden.query, {
      topK,
      embeddingsEnabled: true,
      provider
    });
    if (
      results.some((result) =>
        golden.expectedPathIncludes.some((expected) => result.path?.includes(expected))
      )
    ) {
      hits += 1;
    }
  }
  return hits / GOLDEN_QUERIES.length;
}

export async function runCase(benchCase: BenchCase, parallelism: number): Promise<BenchResult> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-bench-smoke-"));
  createFixture(rootDir, benchCase.files);
  const db = new DSPDatabase(rootDir);
  const adapters = [new BenchAdapter()];
  const embeddingProvider = new MockEmbeddingProvider();
  const config = {
    ...DEFAULT_CONFIG,
    performance: { ...DEFAULT_CONFIG.performance, parallelism }
  };
  try {
    const cold = await timedAsync(() => indexRepository(db, adapters, { rootDir, full: true }, config));
    for (const entity of db.iterateEntitiesOrdered()) {
      const semanticText = [entity.name, entity.signature ?? "", entity.description ?? "", entity.docstring ?? ""].join("\n");
      const hash = contentHash(semanticText);
      db.setEmbedding(
        entity.uid,
        hash,
        await embeddingProvider.embed(semanticText),
        embeddingProvider.cacheKey?.() ?? embeddingProvider.constructor.name,
        stableNowIso()
      );
    }
    const warm = await timedAsync(() => indexRepository(db, adapters, { rootDir }, config));
    fs.appendFileSync(path.join(rootDir, "src", "auth-1.ts"), "\nexport const changed = true;\n", "utf8");
    const changed = await timedAsync(() =>
      indexRepository(db, adapters, { rootDir, files: ["src/auth-1.ts"] }, config)
    );

    const searchTimes: number[] = [];
    const searchCandidates: number[] = [];
    for (let index = 0; index < benchCase.searchIterations; index += 1) {
      searchTimes.push(
        (
          await timedAsync(() =>
            semanticSearch(db, "auth token validation", {
              embeddingsEnabled: true,
              provider: embeddingProvider
            })
          )
        ).ms
      );
      searchCandidates.push(db.searchEntityCandidates("auth token validation", 500).candidatesScanned);
    }
    const contextTimes: number[] = [];
    for (let index = 0; index < benchCase.contextIterations; index += 1) {
      contextTimes.push((await timedAsync(() => buildContextPack(db, { task: "auth token validation" }))).ms);
    }
    const retrievalRecall = await recallAt5(db);
    const retrievalRecallTop10 = await recallAt10(db);
    const validation = timed(() => validateGraph(db, rootDir));
    const dbSize = fs.statSync(db.dbPath).size / 1024 / 1024;
    return {
      case: benchCase.name,
      parallelism,
      coldBootstrapMs: cold.ms,
      warmIndexMs: warm.ms,
      changedOnlyMs: changed.ms,
      searchP50Ms: percentile(searchTimes, 0.5),
      searchP95Ms: percentile(searchTimes, 0.95),
      searchCandidatesP50: percentile(searchCandidates, 0.5),
      contextPackP50Ms: percentile(contextTimes, 0.5),
      contextPackP95Ms: percentile(contextTimes, 0.95),
      retrievalRecallAt5: retrievalRecall,
      retrievalRecallAt10: retrievalRecallTop10,
      validateMs: validation.ms,
      rssMb: process.memoryUsage().rss / 1024 / 1024,
      dbSizeMb: dbSize,
      parserFallbackFiles:
        (cold.value.telemetry?.parserFallbackFiles ?? 0) +
        (warm.value.telemetry?.parserFallbackFiles ?? 0) +
        (changed.value.telemetry?.parserFallbackFiles ?? 0),
      workerRestarts:
        (cold.value.telemetry?.workerRestarts ?? 0) +
        (warm.value.telemetry?.workerRestarts ?? 0) +
        (changed.value.telemetry?.workerRestarts ?? 0),
      workerTimeouts:
        (cold.value.telemetry?.workerTimeouts ?? 0) +
        (warm.value.telemetry?.workerTimeouts ?? 0) +
        (changed.value.telemetry?.workerTimeouts ?? 0),
      dbQueryCount:
        (cold.value.telemetry?.dbQueryCount ?? 0) +
        (warm.value.telemetry?.dbQueryCount ?? 0) +
        (changed.value.telemetry?.dbQueryCount ?? 0),
      coldTelemetry: cold.value.telemetry,
      warmTelemetry: warm.value.telemetry,
      changedTelemetry: changed.value.telemetry
    };
  } finally {
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

export function parseParallelismValues(value: string): number[] {
  return value
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
}

export function selectBenchCases(value: string): BenchCase[] {
  const requestedCases = new Set(value.split(",").map((entry) => entry.trim()));
  return CASES.filter((benchCase) => requestedCases.has(benchCase.name.split("-")[0]));
}
