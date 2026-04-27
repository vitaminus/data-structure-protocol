import type { EmbeddingProvider } from "../graph/types.js";
export declare class MockEmbeddingProvider implements EmbeddingProvider {
    embed(text: string): Promise<number[]>;
}
export declare class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
    private readonly baseUrl;
    private readonly apiKey;
    private readonly model;
    constructor(baseUrl: string, apiKey: string, model: string);
    embed(text: string): Promise<number[]>;
}
//# sourceMappingURL=providers.d.ts.map