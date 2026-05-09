import fs from "node:fs";
import path from "node:path";
import type {
  ContextPackRequest,
  ContextPackResponse,
  EmbeddingProvider,
  Entity,
  Relation,
  TraversalTruncationReason
} from "./types.ts";
import { DSPDatabase } from "../storage/db.ts";
import { semanticSearch } from "../semantic/search.ts";
import { relationPriority, streamNeighbors } from "./query.ts";
import { contentHash } from "./uid.ts";

type StrategyDefaults = {
  maxFiles: number;
  maxDepth: number;
  includeTests: boolean;
};
type CodePayload = NonNullable<ContextPackResponse["code"]>[number];
type ContextPackServices = {
  db: DSPDatabase;
  config?: {
    embeddings?: {
      enabled?: boolean;
    };
  };
  embeddingProvider?: EmbeddingProvider;
};

const STRATEGY_DEFAULTS: Record<NonNullable<ContextPackRequest["strategy"]>, StrategyDefaults> = {
  minimal: { maxFiles: 8, maxDepth: 1, includeTests: false },
  balanced: { maxFiles: 20, maxDepth: 2, includeTests: true },
  deep: { maxFiles: 40, maxDepth: 3, includeTests: true },
  debug: { maxFiles: 30, maxDepth: 2, includeTests: true }
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index]! * b[index]!;
    normA += a[index]! * a[index]!;
    normB += b[index]! * b[index]!;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / Math.sqrt(normA * normB);
}

function providerCacheKey(provider: EmbeddingProvider): string {
  return provider.cacheKey?.() ?? provider.constructor.name;
}

function entitySemanticText(entity: Entity): string {
  return [entity.name, entity.signature ?? "", entity.description ?? "", entity.docstring ?? ""].join("\n");
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

function readUtf8Prefix(
  filePath: string,
  maxChars: number
): { content: string; truncated: boolean } {
  const maxBytes = Math.max(256, maxChars * 4);
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    const content = buffer.subarray(0, bytesRead).toString("utf8").slice(0, maxChars);
    const stat = fs.fstatSync(fd);
    return {
      content,
      truncated: stat.size > bytesRead || content.length >= maxChars
    };
  } finally {
    fs.closeSync(fd);
  }
}

function readCodePayload(
  db: DSPDatabase,
  files: string[],
  entities: Entity[],
  mode: NonNullable<ContextPackRequest["includeCode"]>,
  options: { maxCharsPerFile: number; maxTotalChars: number }
): NonNullable<ContextPackResponse["code"]> | undefined {
  if (mode === "none") {
    return undefined;
  }
  const rootDir = rootDirForDb(db);
  let remainingChars = options.maxTotalChars;
  return files.flatMap<CodePayload>((filePath) => {
    if (remainingChars <= 0) {
      return [];
    }
    const absPath = path.resolve(rootDir, filePath);
    const fileCharBudget = Math.max(160, Math.min(options.maxCharsPerFile, remainingChars));
    if (mode === "full-files") {
      try {
        const prefix = readUtf8Prefix(absPath, fileCharBudget);
        remainingChars -= prefix.content.length;
        return [
          {
            path: filePath,
            mode,
            content: prefix.content,
            truncated: prefix.truncated
          }
        ];
      } catch {
        return [];
      }
    }

    let raw: string;
    try {
      raw = fs.readFileSync(absPath, "utf8");
    } catch {
      return [];
    }
    if (fileCharBudget <= 0) {
      return [];
    }
    const fileEntities = entities.filter((entity) => entity.path === filePath);
    const range = lineRangeForEntities(fileEntities);
    const lines = raw.split(/\r?\n/);
    const startLine = range.startLine ?? 1;
    const endLine = range.endLine ?? Math.min(lines.length, 80);
    const snippetSource = lines.slice(startLine - 1, endLine).join("\n");
    const snippet = snippetSource.slice(0, fileCharBudget);
    remainingChars -= snippet.length;
    return [
      {
        path: filePath,
        mode,
        content: snippet,
        startLine,
        endLine,
        truncated: startLine > 1 || endLine < lines.length || snippetSource.length > snippet.length
      }
    ];
  });
}

async function relationDepthFilter(
  db: DSPDatabase,
  seedUids: Set<string>,
  maxDepth: number,
  options: { maxEntities: number; maxRelations: number; timeoutMs?: number }
): Promise<{ entities: Set<string>; relations: Relation[]; truncated: boolean; truncationReason?: TraversalTruncationReason }> {
  const accepted: Relation[] = [];
  const acceptedKeys = new Set<string>();
  const visited = new Set<string>(seedUids);
  let truncationReason: TraversalTruncationReason | undefined;

  for (const seedUid of seedUids) {
    if (accepted.length >= options.maxRelations || visited.size >= options.maxEntities) {
      truncationReason ??= accepted.length >= options.maxRelations ? "maxRelations" : "maxNodes";
      break;
    }
    for await (const event of streamNeighbors(db, seedUid, maxDepth, {
      maxEntities: options.maxEntities,
      maxRelations: options.maxRelations - accepted.length,
      timeoutMs: options.timeoutMs
    })) {
      if (event.type === "entity") {
        visited.add(event.entity.uid);
        continue;
      }
      if (event.type === "truncation") {
        truncationReason ??= event.reason;
        break;
      }
      const relation = event.relation;
      const relationKey = `${relation.from}\0${relation.kind}\0${relation.to}`;
      if (acceptedKeys.has(relationKey)) {
        continue;
      }
      const newNodes = [relation.from, relation.to].filter((uid) => !visited.has(uid));
      if (visited.size + newNodes.length > options.maxEntities) {
        continue;
      }
      acceptedKeys.add(relationKey);
      accepted.push(relation);
      visited.add(relation.from);
      visited.add(relation.to);
    }
    if (truncationReason) {
      break;
    }
  }
  return {
    entities: visited,
    relations: accepted,
    truncated: Boolean(truncationReason),
    ...(truncationReason ? { truncationReason } : {})
  };
}

function contextPackServices(input: DSPDatabase | ContextPackServices): ContextPackServices {
  return input instanceof DSPDatabase ? { db: input } : input;
}

function relationHasTestEndpoint(relation: Relation, entitiesByUid: Map<string, Entity>): boolean {
  return entitiesByUid.get(relation.from)?.kind === "test" || entitiesByUid.get(relation.to)?.kind === "test";
}

function topoSortByDependencies(
  files: string[],
  entities: Entity[],
  dependencies: Relation[]
): string[] {
  const fileSet = new Set(files);
  const entityPathByUid = new Map(entities.map((entity) => [entity.uid, entity.path]));
  const adjacency = new Map(files.map((file) => [file, new Set<string>()]));
  const indegree = new Map(files.map((file) => [file, 0]));
  const dependencyKinds = new Set(["imports", "depends_on", "calls", "routes_to", "uses"]);

  for (const relation of dependencies) {
    if (!dependencyKinds.has(relation.kind)) {
      continue;
    }
    const fromPath = entityPathByUid.get(relation.from);
    const toPath = entityPathByUid.get(relation.to);
    if (!fromPath || !toPath || fromPath === toPath || !fileSet.has(fromPath) || !fileSet.has(toPath)) {
      continue;
    }
    const dependents = adjacency.get(toPath);
    if (dependents && !dependents.has(fromPath)) {
      dependents.add(fromPath);
      indegree.set(fromPath, (indegree.get(fromPath) ?? 0) + 1);
    }
  }

  const orderRank = new Map(files.map((file, index) => [file, index]));
  const queue = files
    .filter((file) => (indegree.get(file) ?? 0) === 0)
    .sort((a, b) => (orderRank.get(a) ?? 0) - (orderRank.get(b) ?? 0));
  const ordered: string[] = [];

  while (queue.length > 0) {
    const file = queue.shift()!;
    ordered.push(file);
    for (const dependent of adjacency.get(file) ?? []) {
      indegree.set(dependent, (indegree.get(dependent) ?? 0) - 1);
      if ((indegree.get(dependent) ?? 0) === 0) {
        queue.push(dependent);
        queue.sort((a, b) => (orderRank.get(a) ?? 0) - (orderRank.get(b) ?? 0));
      }
    }
  }

  for (const file of files) {
    if (!ordered.includes(file)) {
      ordered.push(file);
    }
  }
  return ordered;
}

function alignContextLists(context: ContextPackResponse): ContextPackResponse {
  const entityUids = new Set(context.relevantEntities.map((entity) => entity.uid));
  const entityFiles = new Set(
    context.relevantEntities.map((entity) => entity.path).filter((file): file is string => Boolean(file))
  );
  const files = context.files.filter((file) => entityFiles.has(file));
  const fileSet = new Set(files);
  return {
    ...context,
    files,
    dependencies: context.dependencies.filter((relation) => entityUids.has(relation.from) && entityUids.has(relation.to)),
    tests: context.tests.filter((entity) => entityUids.has(entity.uid)),
    code: context.code?.filter((payload) => fileSet.has(payload.path)),
    suggestedEditOrder: context.suggestedEditOrder.filter((file) => fileSet.has(file))
  };
}

function trimCodePayloads(
  code: NonNullable<ContextPackResponse["code"]> | undefined,
  maxChars: number
): NonNullable<ContextPackResponse["code"]> | undefined {
  if (!code) {
    return undefined;
  }
  return code.map((payload) => {
    if (payload.content.length <= maxChars) {
      return payload;
    }
    return {
      ...payload,
      content: payload.content.slice(0, maxChars),
      truncated: true
    };
  });
}

function estimateContextTokens(context: ContextPackResponse): number {
  return estimateTokens(JSON.stringify({ ...context, estimatedTokens: 0 }));
}

function enforceContextBudget(context: ContextPackResponse): ContextPackResponse {
  let current = alignContextLists(context);
  let estimatedTokens = estimateContextTokens(current);
  if (estimatedTokens <= current.maxTokens) {
    return { ...current, estimatedTokens };
  }

  const stages: Array<(input: ContextPackResponse) => ContextPackResponse> = [
    (input) => ({
      ...input,
      relevantEntities: input.relevantEntities.slice(0, Math.max(8, Math.floor(input.files.length * 1.5))),
      dependencies: input.dependencies.slice(0, 120),
      suggestedEditOrder: input.suggestedEditOrder.slice(0, 6)
    }),
    (input) => ({ ...input, code: trimCodePayloads(input.code, 4000) }),
    (input) => ({
      ...input,
      relevantEntities: input.relevantEntities.slice(0, 8),
      dependencies: input.dependencies.slice(0, 50),
      tests: input.tests.slice(0, 5),
      suggestedEditOrder: input.suggestedEditOrder.slice(0, 4),
      code: trimCodePayloads(input.code, 1000)
    }),
    (input) => ({
      ...input,
      relevantEntities: input.relevantEntities.slice(0, 4),
      dependencies: input.dependencies.slice(0, 20),
      tests: input.tests.slice(0, 2),
      riskNotes: input.riskNotes.slice(0, 2),
      suggestedEditOrder: input.suggestedEditOrder.slice(0, 2),
      code: trimCodePayloads(input.code, 400)
    }),
    (input) => ({
      ...input,
      relevantEntities: input.relevantEntities.slice(0, 2),
      dependencies: input.dependencies.slice(0, 5),
      tests: [],
      riskNotes: input.riskNotes.slice(0, 1),
      suggestedEditOrder: input.suggestedEditOrder.slice(0, 1),
      code: trimCodePayloads(input.code, 160)
    }),
    (input) => ({
      ...input,
      relevantEntities: input.relevantEntities.slice(0, 1),
      dependencies: [],
      tests: [],
      code: undefined,
      riskNotes: input.riskNotes.slice(0, 1),
      suggestedEditOrder: []
    })
  ];

  for (const stage of stages) {
    current = alignContextLists({
      ...stage(current),
      truncated: true,
      truncationReason: current.truncationReason ?? "maxTokens"
    });
    estimatedTokens = estimateContextTokens(current);
    if (estimatedTokens <= current.maxTokens) {
      return { ...current, estimatedTokens };
    }
  }

  return {
    ...current,
    estimatedTokens: Math.min(estimatedTokens, current.maxTokens),
    truncated: true,
    truncationReason: current.truncationReason ?? "maxTokens"
  };
}

async function rerankContextEntities(
  db: DSPDatabase,
  task: string,
  entities: Entity[],
  dependencies: Relation[],
  searchScores: Map<string, number>,
  provider: EmbeddingProvider
): Promise<Entity[]> {
  const queryVector = await provider.embed(task);
  const providerKey = providerCacheKey(provider);
  const graphScores = new Map<string, number>();
  for (const relation of dependencies) {
    const score = Math.min(1, relationPriority(relation) / 200);
    graphScores.set(relation.from, Math.max(graphScores.get(relation.from) ?? 0, score));
    graphScores.set(relation.to, Math.max(graphScores.get(relation.to) ?? 0, score));
  }

  const ranked = await Promise.all(
    entities.map(async (entity, index) => {
      const semanticText = entitySemanticText(entity);
      const hash = contentHash(semanticText);
      const stored = db.getEmbedding(entity.uid);
      const vector =
        stored && stored.hash === hash && stored.provider === providerKey
          ? stored.vector
          : undefined;
      const lexicalGraphScore = searchScores.get(entity.uid) ?? 0;
      const graphScore = graphScores.get(entity.uid) ?? 0;
      const semanticScore = vector ? Math.max(0, cosineSimilarity(queryVector, vector)) : 0;
      const score = lexicalGraphScore * 0.45 + graphScore * 0.2 + semanticScore * 0.35;
      return {
        entity: {
          ...entity,
          metadata: {
            ...(entity.metadata ?? {}),
            contextRank: {
              score: Number(score.toFixed(4)),
              lexicalGraph: Number(lexicalGraphScore.toFixed(4)),
              graph: Number(graphScore.toFixed(4)),
              semantic: Number(semanticScore.toFixed(4))
            }
          }
        },
        index,
        score
      };
    })
  );

  return ranked
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.entity);
}

export async function buildContextPack(
  input: DSPDatabase | ContextPackServices,
  request: ContextPackRequest
): Promise<ContextPackResponse> {
  const services = contextPackServices(input);
  const db = services.db;
  const strategyDefaults = STRATEGY_DEFAULTS[request.strategy ?? "balanced"];
  const maxTokens = request.maxTokens ?? 8000;
  const maxFiles = request.maxFiles ?? strategyDefaults.maxFiles;
  const maxDepth = request.maxDepth ?? strategyDefaults.maxDepth;
  const includeTests = request.includeTests ?? strategyDefaults.includeTests;
  const includeCode = request.includeCode ?? "none";
  const embeddingsEnabled = Boolean(services.config?.embeddings?.enabled && services.embeddingProvider);
  const searchResults = await semanticSearch(db, request.task, {
    topK: Math.max(25, maxFiles * 2),
    embeddingsEnabled,
    provider: services.embeddingProvider
  });
  const searchScores = new Map(searchResults.map((result) => [result.uid, result.score]));
  const entitiesByUid = new Map<string, Entity>();
  const seedEntities = db.getEntitiesByUid(searchResults.map((result) => result.uid));
  for (const entity of seedEntities) {
    entitiesByUid.set(entity.uid, entity);
  }
  const rankedEntities = searchResults
    .map((result) => entitiesByUid.get(result.uid))
    .filter((entity): entity is Entity => Boolean(entity))
    .filter((entity) => includeTests || entity.kind !== "test");
  const selectedEntities = rankedEntities.slice(0, maxFiles * 3);
  const selectedUids = new Set(selectedEntities.map((entity) => entity.uid));
  const maxTraversalEntities = Math.min(
    request.maxNodes ?? Math.max(maxFiles * 8, selectedUids.size),
    Math.max(48, Math.floor(maxTokens / 40))
  );
  const maxTraversalRelations = Math.min(
    request.maxRelations ?? Math.max(maxFiles * 40, 300),
    Math.max(120, Math.floor(maxTokens / 12))
  );
  const graphSlice = await relationDepthFilter(db, selectedUids, maxDepth, {
    maxEntities: maxTraversalEntities,
    maxRelations: maxTraversalRelations,
    timeoutMs: request.timeoutMs
  });
  const contextEntities = [...selectedEntities];
  const contextEntityUids = new Set(contextEntities.map((entity) => entity.uid));
  for (const entity of db.getEntitiesByUid([...graphSlice.entities])) {
    entitiesByUid.set(entity.uid, entity);
  }
  const graphDependencies = graphSlice.relations.filter(
    (relation) =>
      graphSlice.entities.has(relation.from) &&
      graphSlice.entities.has(relation.to) &&
      (includeTests || !relationHasTestEndpoint(relation, entitiesByUid))
  );
  const dependencies = graphDependencies.slice(0, 300);
  const dependenciesTruncated = graphSlice.truncated || graphDependencies.length > dependencies.length;
  const traversalTruncationReason =
    graphDependencies.length > dependencies.length ? "maxRelations" : graphSlice.truncationReason;
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
  const rankedContextEntities =
    embeddingsEnabled && services.embeddingProvider
      ? await rerankContextEntities(db, request.task, contextEntities, graphDependencies, searchScores, services.embeddingProvider)
      : contextEntities;

  const files = [...new Set(rankedContextEntities.map((entity) => entity.path).filter(Boolean))].slice(
    0,
    maxFiles
  ) as string[];
  const tests = includeTests ? rankedContextEntities.filter((entity) => entity.kind === "test").slice(0, 20) : [];
  const maxCodeTokens = includeCode === "full-files" ? Math.max(400, Math.floor(maxTokens * 0.45)) : Math.max(240, Math.floor(maxTokens * 0.25));
  const maxCodeChars = Math.max(320, maxCodeTokens * 4);
  const maxCharsPerFile = Math.max(160, Math.floor(maxCodeChars / Math.max(1, files.length)));
  const code = readCodePayload(db, files, rankedContextEntities, includeCode, {
    maxCharsPerFile,
    maxTotalChars: maxCodeChars
  });
  const riskNotes = [
    dependencies.some((rel) => rel.kind === "exports")
      ? "Public API nodes involved in context."
      : "No direct public API edges in selected context.",
    tests.length > 0 ? `${tests.length} related tests included.` : "No tests in top-ranked context.",
    ...(embeddingsEnabled ? ["Semantic reranking applied to context entities."] : []),
    ...(dependenciesTruncated ? [`Graph dependencies truncated from ${graphDependencies.length} to ${dependencies.length}.`] : [])
  ];

  const suggestedEditOrder = topoSortByDependencies(files, rankedContextEntities, dependencies).slice(
    0,
    Math.min(files.length, 10)
  );
  const context: ContextPackResponse = {
    relevantEntities: rankedContextEntities.slice(0, maxFiles * 4),
    files,
    dependencies,
    tests,
    ...(code ? { code } : {}),
    riskNotes,
    suggestedEditOrder,
    estimatedTokens: 0,
    maxTokens,
    truncated: dependenciesTruncated,
    ...(traversalTruncationReason ? { truncationReason: traversalTruncationReason } : {})
  };
  return enforceContextBudget(context);
}
