import type { ContextPackRequest, ContextPackResponse, FileIndexRequest, ImpactResult, IndexSummary, LanguageAdapter, SearchResult, ValidationResult } from "./graph/types.js";
import { DSPDatabase } from "./storage/db.js";
export type DSPServices = {
    rootDir: string;
    db: DSPDatabase;
    adapters: LanguageAdapter[];
};
export declare function initDSP(rootDir: string): {
    rootDir: string;
    dbPath: string;
    createdConfig: boolean;
};
export declare function openDSP(rootDir: string, adapters: LanguageAdapter[]): DSPServices;
export declare function runIndex(services: DSPServices, request: FileIndexRequest): Promise<IndexSummary>;
export declare function runBootstrap(services: DSPServices, options: {
    lazy?: boolean;
    noEmbeddings?: boolean;
    dryRun?: boolean;
    largeRepo?: boolean;
}): Promise<IndexSummary>;
export declare function runChanged(services: DSPServices): string[];
export declare function runSearch(services: DSPServices, query: string, opts?: {
    topK?: number;
    embeddingsEnabled?: boolean;
}): Promise<SearchResult[]>;
export declare function runImpact(services: DSPServices, target: string): ImpactResult;
export declare function runValidate(services: DSPServices): ValidationResult;
export declare function runContextPack(services: DSPServices, request: ContextPackRequest): Promise<ContextPackResponse>;
export declare function runExport(services: DSPServices, format: "json" | "dsp" | "protocol", targetPath?: string): {
    format: "json" | "dsp" | "protocol";
    targetPath: string;
};
export declare function runImport(services: DSPServices, sourcePath: string): {
    entities: number;
    relations: number;
    unresolvedReferences: number;
};
export declare function runEmbeddingsUpdate(services: DSPServices, options?: {
    changedOnly?: boolean;
}): Promise<{
    updated: number;
    skipped: number;
    provider: string;
}>;
//# sourceMappingURL=api.d.ts.map