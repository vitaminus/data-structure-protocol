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
    baseUrl?: string;
    apiKeyEnv?: string;
    model?: string;
  };
};

export const DEFAULT_EXCLUDES = [
  "node_modules/**",
  "vendor/**",
  "dist/**",
  "build/**",
  "target/**",
  ".git/**"
];

export const DEFAULT_CONFIG: DSPConfig = {
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
    provider: "mock",
    apiKeyEnv: "DSP_EMBEDDINGS_API_KEY"
  }
};
