import { semanticSearch } from "../semantic/search.js";
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
function relationDepthFilter(relations, seedUids, maxDepth) {
    const accepted = [];
    const acceptedKeys = new Set();
    const frontier = new Set(seedUids);
    const visited = new Set(seedUids);
    for (let depth = 0; depth < maxDepth; depth += 1) {
        const next = new Set();
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
export async function buildContextPack(db, request) {
    const maxTokens = request.maxTokens ?? 8000;
    const maxFiles = request.maxFiles ?? 20;
    const maxDepth = request.maxDepth ?? 2;
    const searchResults = await semanticSearch(db, request.task, {
        topK: Math.max(25, maxFiles * 2),
        embeddingsEnabled: false
    });
    const entitiesByUid = new Map();
    for (const entity of db.getEntities(200000)) {
        entitiesByUid.set(entity.uid, entity);
    }
    const rankedEntities = searchResults
        .map((result) => entitiesByUid.get(result.uid))
        .filter((entity) => Boolean(entity));
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
        if (entity && !contextEntityUids.has(uid)) {
            contextEntityUids.add(uid);
            contextEntities.push(entity);
        }
    }
    const files = [...new Set(contextEntities.map((entity) => entity.path).filter(Boolean))].slice(0, maxFiles);
    const tests = contextEntities.filter((entity) => entity.kind === "test").slice(0, 20);
    const riskNotes = [
        dependencies.some((rel) => rel.kind === "exports")
            ? "Public API nodes involved in context."
            : "No direct public API edges in selected context.",
        tests.length > 0 ? `${tests.length} related tests included.` : "No tests in top-ranked context."
    ];
    const suggestedEditOrder = files.slice(0, Math.min(files.length, 10));
    let context = {
        relevantEntities: contextEntities.slice(0, maxFiles * 4),
        files,
        dependencies,
        tests,
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
//# sourceMappingURL=context-pack.js.map