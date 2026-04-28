import path from "node:path";
import fs from "node:fs";
import { DSPDatabase } from "./storage/db.js";
import { loadConfig, writeDefaultConfig } from "./config/config.js";
import { buildContextPack } from "./graph/context-pack.js";
import { indexRepository, bootstrapRepository, changedFiles } from "./indexer/indexer.js";
import { semanticSearch } from "./semantic/search.js";
import { analyzeImpact } from "./impact/impact.js";
import { validateGraph } from "./validate/validate.js";
import { insertSourceMarkers } from "./markers/markers.js";
import { MockEmbeddingProvider } from "./semantic/providers.js";
import { contentHash } from "./graph/uid.js";
export function initDSP(rootDir) {
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
export function openDSP(rootDir, adapters) {
    const resolved = path.resolve(rootDir);
    return {
        rootDir: resolved,
        db: new DSPDatabase(resolved),
        adapters
    };
}
export async function runIndex(services, request) {
    const config = loadConfig(services.rootDir);
    return indexRepository(services.db, services.adapters, request, config);
}
export async function runBootstrap(services, options) {
    const config = loadConfig(services.rootDir);
    return bootstrapRepository(services.db, services.adapters, services.rootDir, config, options);
}
export function runChanged(services) {
    return changedFiles(services.db, services.rootDir);
}
export async function runSearch(services, query, opts = {}) {
    return semanticSearch(services.db, query, {
        topK: opts.topK,
        embeddingsEnabled: opts.embeddingsEnabled ?? false
    });
}
export function runImpact(services, target) {
    return analyzeImpact(services.db, target);
}
export function runValidate(services) {
    return validateGraph(services.db, services.rootDir);
}
export async function runContextPack(services, request) {
    return buildContextPack(services.db, request);
}
export function runExport(services, format, targetPath) {
    if (format === "json") {
        const finalPath = targetPath ?? path.join(services.rootDir, ".dsp", "graph.json");
        services.db.exportJson(finalPath);
        return { format, targetPath: finalPath };
    }
    if (format === "protocol") {
        services.db.exportProtocol(services.rootDir);
        return { format, targetPath: path.join(services.rootDir, ".dsp", "protocol") };
    }
    services.db.exportDsp(services.rootDir);
    return { format, targetPath: path.join(services.rootDir, ".dsp", "export") };
}
export function runMarkersApply(services, options = {}) {
    return insertSourceMarkers(services.db, services.rootDir, options);
}
export function runImport(services, sourcePath) {
    const snapshot = services.db.importJson(sourcePath);
    return {
        entities: snapshot.entities.length,
        relations: snapshot.relations.length,
        unresolvedReferences: snapshot.unresolvedReferences.length
    };
}
export async function runEmbeddingsUpdate(services, options = {}) {
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
//# sourceMappingURL=api.js.map