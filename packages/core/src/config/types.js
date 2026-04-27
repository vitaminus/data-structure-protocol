export const DEFAULT_EXCLUDES = [
    "node_modules/**",
    "vendor/**",
    "dist/**",
    "build/**",
    "target/**",
    ".git/**"
];
export const DEFAULT_CONFIG = {
    version: 2,
    performance: {
        mode: "default",
        lazyIndexing: false,
        parallelism: 8,
        maxFileSizeKb: 512,
        exclude: DEFAULT_EXCLUDES
    },
    embeddings: {
        enabled: false,
        provider: "mock"
    }
};
//# sourceMappingURL=types.js.map