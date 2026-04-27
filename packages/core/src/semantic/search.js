import { contentHash } from "../graph/uid.js";
function cosineSimilarity(a, b) {
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
export async function semanticSearch(db, query, options = {}) {
    const topK = options.topK ?? 20;
    const entities = db.getEntities(200000);
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    let queryVector;
    if (options.embeddingsEnabled && options.provider) {
        queryVector = await options.provider.embed(query);
    }
    const scored = [];
    for (const entity of entities) {
        const lexicalCorpus = [
            entity.name,
            entity.path ?? "",
            entity.signature ?? "",
            entity.description ?? "",
            entity.docstring ?? ""
        ]
            .join(" ")
            .toLowerCase();
        let lexicalScore = 0;
        for (const token of tokens) {
            if (lexicalCorpus.includes(token)) {
                lexicalScore += 0.2;
            }
        }
        lexicalScore = Math.min(1, lexicalScore);
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
            let vector;
            if (stored && stored.hash === hash) {
                vector = stored.vector;
            }
            else {
                vector = await options.provider.embed(semanticText);
                db.setEmbedding(entity.uid, hash, vector, options.provider.constructor.name, new Date().toISOString());
            }
            embeddingScore = cosineSimilarity(queryVector, vector);
        }
        const score = lexicalScore * 0.65 + embeddingScore * 0.35;
        if (score <= 0) {
            continue;
        }
        const neighbors = db.getRelationsFrom(entity.uid).slice(0, 5).map((r) => r.to);
        scored.push({
            uid: entity.uid,
            kind: entity.kind,
            path: entity.path,
            score,
            explanation: embeddingScore > 0
                ? `lexical=${lexicalScore.toFixed(2)}, semantic=${embeddingScore.toFixed(2)}`
                : `lexical=${lexicalScore.toFixed(2)}`,
            neighbors
        });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}
//# sourceMappingURL=search.js.map