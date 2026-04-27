export type DSPPerformanceConfig = {
    mode: "default" | "large-repo";
    lazyIndexing: boolean;
    parallelism: number;
    maxFileSizeKb: number;
    exclude: string[];
};
export type DSPConfig = {
    version: 2;
    performance: DSPPerformanceConfig;
    embeddings: {
        enabled: boolean;
        provider: "mock" | "openai-compatible";
    };
};
export declare const DEFAULT_EXCLUDES: string[];
export declare const DEFAULT_CONFIG: DSPConfig;
//# sourceMappingURL=types.d.ts.map