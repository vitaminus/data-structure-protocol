import type { FileIndexRequest, IndexSummary, LanguageAdapter } from "../graph/types.js";
import type { DSPDatabase } from "../storage/db.js";
import type { DSPConfig } from "../config/types.js";
export declare function indexRepository(db: DSPDatabase, adapters: LanguageAdapter[], request: FileIndexRequest, config: DSPConfig): Promise<IndexSummary>;
export declare function bootstrapRepository(db: DSPDatabase, adapters: LanguageAdapter[], rootDir: string, config: DSPConfig, options?: {
    lazy?: boolean;
    noEmbeddings?: boolean;
    dryRun?: boolean;
    largeRepo?: boolean;
}): Promise<IndexSummary>;
export declare function changedFiles(db: DSPDatabase, rootDir: string): string[];
//# sourceMappingURL=indexer.d.ts.map