const SOURCE_PRIORITY = {
    human: 100,
    ast: 80,
    lsp: 70,
    test: 60,
    git: 50,
    regex: 40,
    llm: 20
};
export function sourcePriority(source) {
    return SOURCE_PRIORITY[source];
}
export function topSourcePriority(provenance) {
    if (provenance.length === 0) {
        return 0;
    }
    return Math.max(...provenance.map((p) => sourcePriority(p.source)));
}
export function mergeProvenance(existing, incoming) {
    const key = (p) => `${p.source}|${p.tool ?? ""}|${p.evidence ?? ""}|${p.timestamp}`;
    const merged = new Map();
    for (const item of existing) {
        merged.set(key(item), item);
    }
    for (const item of incoming) {
        merged.set(key(item), item);
    }
    return [...merged.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
//# sourceMappingURL=provenance.js.map