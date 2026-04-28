import fs from "node:fs";
import path from "node:path";
import type { ContextPackRequest, ContextPackResponse, Entity, Relation } from "./types.js";
import type { DSPDatabase } from "../storage/db.js";
import { semanticSearch } from "../semantic/search.js";

type StrategyDefaults = {
  maxFiles: number;
  maxDepth: number;
  includeTests: boolean;
};
type CodePayload = NonNullable<ContextPackResponse["code"]>[number];

const STRATEGY_DEFAULTS: Record<NonNullable<ContextPackRequest["strategy"]>, StrategyDefaults> = {
  minimal: { maxFiles: 8, maxDepth: 1, includeTests: false },
  balanced: { maxFiles: 20, maxDepth: 2, includeTests: true },
  deep: { maxFiles: 40, maxDepth: 3, includeTests: true },
  debug: { maxFiles: 30, maxDepth: 2, includeTests: true }
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function rootDirForDb(db: DSPDatabase): string {
  return path.dirname(path.dirname(db.dbPath));
}

function lineRangeForEntities(entities: Entity[]): { startLine?: number; endLine?: number } {
  const starts = entities.map((entity) => entity.startLine).filter((line): line is number => Boolean(line));
  const ends = entities.map((entity) => entity.endLine).filter((line): line is number => Boolean(line));
  if (starts.length === 0 || ends.length === 0) {
    return {};
  }
  return {
    startLine: Math.max(1, Math.min(...starts) - 3),
    endLine: Math.max(...ends) + 3
  };
}

function readCodePayload(
  db: DSPDatabase,
  files: string[],
  entities: Entity[],
  mode: NonNullable<ContextPackRequest["includeCode"]>
): NonNullable<ContextPackResponse["code"]> | undefined {
  if (mode === "none") {
    return undefined;
  }
  const rootDir = rootDirForDb(db);
  return files.flatMap<CodePayload>((filePath) => {
    const absPath = path.resolve(rootDir, filePath);
    let raw: string;
    try {
      raw = fs.readFileSync(absPath, "utf8");
    } catch {
      return [];
    }
    if (mode === "full-files") {
      const maxChars = 24_000;
      return [
        {
          path: filePath,
          mode,
          content: raw.slice(0, maxChars),
          truncated: raw.length > maxChars
        }
      ];
    }

    const fileEntities = entities.filter((entity) => entity.path === filePath);
    const range = lineRangeForEntities(fileEntities);
    const lines = raw.split(/\r?\n/);
    const startLine = range.startLine ?? 1;
    const endLine = range.endLine ?? Math.min(lines.length, 80);
    return [
      {
        path: filePath,
        mode,
        content: lines.slice(startLine - 1, endLine).join("\n"),
        startLine,
        endLine,
        truncated: startLine > 1 || endLine < lines.length
      }
    ];
  });
}

function relationDepthFilter(
  relations: Relation[],
  seedUids: Set<string>,
  maxDepth: number
): { entities: Set<string>; relations: Relation[] } {
  const accepted: Relation[] = [];
  const acceptedKeys = new Set<string>();
  const frontier = new Set(seedUids);
  const visited = new Set<string>(seedUids);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const next = new Set<string>();
    for (const relation of relations) {
      if (!frontier.has(relation.from) && !frontier.has(relation.to)) {
        continue;
      }
      const relationKey = `${relation.from}\0${relation.kind}\0${relation.to}`;
      if (!acceptedKeys.has(relationKey)) {
        acceptedKeys.add(relationKey);
        accepted.push(relation);
      }
      if (!visited.has(relation.from)) {
        visited.add(relation.from);
        next.add(relation.from);
      }
      if (!visited.has(relation.to)) {
        visited.add(relation.to);
        next.add(relation.to);
      }
    }
    frontier.clear();
    for (const uid of next) {
      frontier.add(uid);
    }
    if (frontier.size === 0) {
      break;
    }
  }
  return { entities: visited, relations: accepted };
}

export async function buildContextPack(
  db: DSPDatabase,
  request: ContextPackRequest
): Promise<ContextPackResponse> {
  const strategyDefaults = STRATEGY_DEFAULTS[request.strategy ?? "balanced"];
  const maxTokens = request.maxTokens ?? 8000;
  const maxFiles = request.maxFiles ?? strategyDefaults.maxFiles;
  const maxDepth = request.maxDepth ?? strategyDefaults.maxDepth;
  const includeTests = request.includeTests ?? strategyDefaults.includeTests;
  const includeCode = request.includeCode ?? "none";
  const searchResults = await semanticSearch(db, request.task, {
    topK: Math.max(25, maxFiles * 2),
    embeddingsEnabled: false
  });
  const entitiesByUid = new Map<string, Entity>();
  for (const entity of db.getEntities(200000)) {
    entitiesByUid.set(entity.uid, entity);
  }
  const rankedEntities = searchResults
    .map((result) => entitiesByUid.get(result.uid))
    .filter((entity): entity is Entity => Boolean(entity))
    .filter((entity) => includeTests || entity.kind !== "test");
  const selectedEntities = rankedEntities.slice(0, maxFiles * 3);
  const selectedUids = new Set(selectedEntities.map((entity) => entity.uid));
  const allRelations = db.getRelations(500000);
  const graphSlice = relationDepthFilter(allRelations, selectedUids, maxDepth);
  const dependencies = graphSlice.relations
    .filter((relation) => graphSlice.entities.has(relation.from) && graphSlice.entities.has(relation.to))
    .slice(0, 300);
  const contextEntities = [...selectedEntities];
  const contextEntityUids = new Set(contextEntities.map((entity) => entity.uid));
  for (const uid of graphSlice.entities) {
    const entity = entitiesByUid.get(uid);
    if (!includeTests && entity?.kind === "test") {
      continue;
    }
    if (entity && !contextEntityUids.has(uid)) {
      contextEntityUids.add(uid);
      contextEntities.push(entity);
    }
  }

  const files = [...new Set(contextEntities.map((entity) => entity.path).filter(Boolean))].slice(
    0,
    maxFiles
  ) as string[];
  const tests = includeTests ? contextEntities.filter((entity) => entity.kind === "test").slice(0, 20) : [];
  const code = readCodePayload(db, files, contextEntities, includeCode);
  const riskNotes = [
    dependencies.some((rel) => rel.kind === "exports")
      ? "Public API nodes involved in context."
      : "No direct public API edges in selected context.",
    tests.length > 0 ? `${tests.length} related tests included.` : "No tests in top-ranked context."
  ];

  const suggestedEditOrder = files.slice(0, Math.min(files.length, 10));
  let context: ContextPackResponse = {
    relevantEntities: contextEntities.slice(0, maxFiles * 4),
    files,
    dependencies,
    tests,
    ...(code ? { code } : {}),
    riskNotes,
    suggestedEditOrder,
    estimatedTokens: 0,
    maxTokens,
    truncated: false
  };

  let estimatedTokens = estimateTokens(JSON.stringify(context));
  if (estimatedTokens > maxTokens) {
    context = {
      ...context,
      relevantEntities: context.relevantEntities.slice(0, Math.max(8, Math.floor(maxFiles * 1.5))),
      dependencies: context.dependencies.slice(0, 120),
      suggestedEditOrder: context.suggestedEditOrder.slice(0, 6),
      truncated: true
    };
    estimatedTokens = estimateTokens(JSON.stringify(context));
  }

  context.estimatedTokens = estimatedTokens;
  return context;
}
