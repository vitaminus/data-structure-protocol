import type { DSPDatabase } from "../storage/db.js";
import type { EmbeddingProvider, SearchResult } from "../graph/types.js";
export declare function semanticSearch(db: DSPDatabase, query: string, options?: {
    topK?: number;
    provider?: EmbeddingProvider;
    embeddingsEnabled?: boolean;
}): Promise<SearchResult[]>;
//# sourceMappingURL=search.d.ts.map