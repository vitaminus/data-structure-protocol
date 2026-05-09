import type { DSPDatabase, GraphReadCache, RankedEmbedding } from "../storage/db.ts";
import type { EmbeddingProvider, SearchResult } from "../graph/types.ts";

const HIGH_SIGNAL_RELATION_KINDS = new Set([
  "imports",
  "exports",
  "calls",
  "extends",
  "implements",
  "uses",
  "tests",
  "routes_to",
  "depends_on",
  "similar_to"
]);

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function normalizedText(text: string): string {
  return tokenize(text).join(" ");
}

function providerCacheKey(provider: EmbeddingProvider): string {
  return provider.cacheKey?.() ?? provider.constructor.name;
}

function highSignalRelations(db: DSPDatabase, uid: string, direction: "from" | "to", cache: GraphReadCache) {
  const relations =
    direction === "from" ? db.getRelationsFromCached(uid, cache) : db.getRelationsToCached(uid, cache);
  const endpointUids = relations.map((relation) => (direction === "from" ? relation.to : relation.from));
  const entityByUid = new Map(db.getEntitiesByUidCached(endpointUids, cache).map((entity) => [entity.uid, entity]));
  return relations.filter((relation) => {
    if (!HIGH_SIGNAL_RELATION_KINDS.has(relation.kind)) {
      return false;
    }
    if (relation.metadata?.synthetic) {
      return false;
    }
    const otherUid = direction === "from" ? relation.to : relation.from;
    const other = entityByUid.get(otherUid);
    return other?.kind !== "file" && other?.kind !== "directory";
  });
}

export async function semanticSearch(
  db: DSPDatabase,
  query: string,
  options: {
    topK?: number;
    candidateLimit?: number;
    provider?: EmbeddingProvider;
    embeddingsEnabled?: boolean;
  } = {}
): Promise<SearchResult[]> {
  const topK = options.topK ?? 20;
  const candidateLimit = options.candidateLimit ?? Math.max(500, topK * 20);
  const tokens = tokenize(query);
  const normalizedQuery = tokens.join(" ");
  const providerKey = options.provider ? providerCacheKey(options.provider) : undefined;
  const cache = db.createGraphReadCache();

  let queryVector: number[] | undefined;
  if (options.embeddingsEnabled && options.provider) {
    queryVector = await options.provider.embed(query);
  }

  const lexicalCandidateUids = db.searchEntityUids(query, candidateLimit);
  const expandedCandidateUids = new Set(lexicalCandidateUids);
  for (const uid of lexicalCandidateUids) {
    for (const relation of highSignalRelations(db, uid, "from", cache).slice(0, 10)) {
      expandedCandidateUids.add(relation.to);
    }
    for (const relation of highSignalRelations(db, uid, "to", cache).slice(0, 10)) {
      expandedCandidateUids.add(relation.from);
    }
  }

  let rankedEmbeddings: RankedEmbedding[] = [];
  if (queryVector && providerKey) {
    rankedEmbeddings = db.nearestEmbeddingsByProvider(providerKey, queryVector, {
      topK: candidateLimit,
      scanLimit: Math.max(candidateLimit * 20, 5000)
    });
    for (const embedding of rankedEmbeddings) {
      expandedCandidateUids.add(embedding.uid);
    }

    if (lexicalCandidateUids.length === 0) {
      for (const embedding of rankedEmbeddings) {
        expandedCandidateUids.add(embedding.uid);
      }
    }
  }

  const entities = db.getEntitiesByUidCached([...expandedCandidateUids], cache);
  const semanticScoresByUid = new Map(rankedEmbeddings.map((embedding) => [embedding.uid, embedding.score]));

  const scored: SearchResult[] = [];
  for (const entity of entities) {
    const lexicalParts = [
      entity.name,
      entity.path ?? "",
      entity.signature ?? "",
      entity.description ?? "",
      entity.docstring ?? ""
    ];
    const corpusTokens = new Set(tokenize(lexicalParts.join(" ")));

    let lexicalScore = 0;
    if (tokens.length > 0) {
      const matchedTokens = tokens.filter((token) => corpusTokens.has(token)).length;
      lexicalScore += (matchedTokens / tokens.length) * 0.55;
    }
    if (normalizedQuery && normalizedText(entity.name) === normalizedQuery) {
      lexicalScore += 0.35;
    }
    if (normalizedQuery && normalizedText(entity.path ?? "").includes(normalizedQuery)) {
      lexicalScore += 0.2;
    }
    if (normalizedQuery && normalizedText(entity.signature ?? "").includes(normalizedQuery)) {
      lexicalScore += 0.1;
    }
    lexicalScore = Math.min(1, lexicalScore);

    const neighborIds = [
      ...highSignalRelations(db, entity.uid, "from", cache).slice(0, 5).map((relation) => relation.to),
      ...highSignalRelations(db, entity.uid, "to", cache).slice(0, 5).map((relation) => relation.from)
    ];
    let neighborScore = 0;
    if (tokens.length > 0 && neighborIds.length > 0) {
      const neighborTokens = new Set(
        neighborIds.flatMap((uid) => {
          const neighbor = db.getEntityCached(uid, cache);
          if (!neighbor) {
            return [];
          }
          return tokenize(
            [neighbor.name, neighbor.path ?? "", neighbor.signature ?? "", neighbor.description ?? ""].join(" ")
          );
        })
      );
      const matchedNeighborTokens = tokens.filter((token) => neighborTokens.has(token)).length;
      neighborScore = Math.min(1, matchedNeighborTokens / tokens.length);
    }

    let embeddingScore = 0;
    if (queryVector && options.provider && providerKey) {
      embeddingScore = semanticScoresByUid.get(entity.uid) ?? 0;
    }

    const lexicalAndGraphScore = Math.min(1, lexicalScore * 0.85 + neighborScore * 0.15);
    const score = lexicalAndGraphScore * 0.65 + embeddingScore * 0.35;
    if (score <= 0) {
      continue;
    }
    const neighbors = neighborIds.slice(0, 5);
    scored.push({
      uid: entity.uid,
      kind: entity.kind,
      path: entity.path,
      score,
      explanation:
        embeddingScore > 0
          ? `lexical=${lexicalScore.toFixed(2)}, neighbors=${neighborScore.toFixed(2)}, semantic=${embeddingScore.toFixed(2)}`
          : `lexical=${lexicalScore.toFixed(2)}, neighbors=${neighborScore.toFixed(2)}`,
      neighbors
    });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}
