import type { Entity, Relation, UnresolvedReference } from "../graph/types.js";
export type GraphSnapshot = {
    entities: Entity[];
    relations: Relation[];
    unresolvedReferences: UnresolvedReference[];
};
export declare class DSPDatabase {
    readonly dbPath: string;
    private readonly db;
    constructor(rootDir: string);
    initialize(): void;
    close(): void;
    beginRun(mode: string, startedAt: string): number;
    finishRun(runId: number, status: "ok" | "failed", endedAt: string, meta: unknown): void;
    private rowToEntity;
    private rowToRelation;
    getEntity(uid: string): Entity | undefined;
    getEntities(limit?: number): Entity[];
    getRelations(limit?: number): Relation[];
    getRelationsFrom(uid: string): Relation[];
    getRelationsTo(uid: string): Relation[];
    upsertEntity(entity: Entity): void;
    upsertRelation(relation: Relation): void;
    markFileHash(filePath: string, hash: string, indexedAt: string): void;
    getFileHash(filePath: string): string | undefined;
    clearUnresolvedForPath(filePath: string): void;
    upsertUnresolvedReference(ref: UnresolvedReference, createdAt: string): void;
    getUnresolvedReferences(): UnresolvedReference[];
    clearAstDataForPath(filePath: string): void;
    listFilesInHashTable(): string[];
    getSnapshot(): GraphSnapshot;
    exportJson(targetPath: string): void;
    importJson(sourcePath: string): GraphSnapshot;
    exportDsp(targetDir: string): void;
    setEmbedding(uid: string, hash: string, vector: number[], provider: string, updatedAt: string): void;
    getEmbedding(uid: string): {
        hash: string;
        vector: number[];
        provider: string;
    } | undefined;
    cacheStats(): {
        fileHashes: number;
        embeddings: number;
        unresolvedReferences: number;
    };
    clearCache(): void;
}
//# sourceMappingURL=db.d.ts.map