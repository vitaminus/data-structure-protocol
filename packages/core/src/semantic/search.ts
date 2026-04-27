import type { DSPDatabase } from "../storage/db.js";
import type { EmbeddingProvider, SearchResult } from "../graph/types.js";
import { contentHash } from "../graph/uid.js";

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / Math.sqrt(normA * normB);
}

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

export async function semanticSearch(
  db: DSPDatabase,
  query: string,
  options: {
    topK?: number;
    provider?: EmbeddingProvider;
    embeddingsEnabled?: boolean;
  } = {}
): Promise<SearchResult[]> {
  const topK = options.topK ?? 20;
  const entities = db.getEntities(200000);
  const tokens = tokenize(query);
  const normalizedQuery = tokens.join(" ");

  let queryVector: number[] | undefined;
  if (options.embeddingsEnabled && options.provider) {
    queryVector = await options.provider.embed(query);
  }

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
      ...db.getRelationsFrom(entity.uid).slice(0, 5).map((relation) => relation.to),
      ...db.getRelationsTo(entity.uid).slice(0, 5).map((relation) => relation.from)
    ];
    let neighborScore = 0;
    if (tokens.length > 0 && neighborIds.length > 0) {
      const neighborTokens = new Set(
        neighborIds.flatMap((uid) => {
          const neighbor = db.getEntity(uid);
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
    if (queryVector && options.provider) {
      const semanticText = [
        entity.name,
        entity.signature ?? "",
        entity.description ?? "",
        entity.docstring ?? ""
      ].join("\n");
      const hash = contentHash(semanticText);
      const stored = db.getEmbedding(entity.uid);
      let vector: number[] | undefined;
      if (stored && stored.hash === hash) {
        vector = stored.vector;
      } else {
        vector = await options.provider.embed(semanticText);
        db.setEmbedding(entity.uid, hash, vector, options.provider.constructor.name, new Date().toISOString());
      }
      embeddingScore = cosineSimilarity(queryVector, vector);
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
