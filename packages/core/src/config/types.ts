export type DSPPerformanceConfig = {
  mode: "default" | "large-repo";
  lazyIndexing: boolean;
  parallelism: number;
  adaptiveParallelism: boolean;
  maxFileSizeKb: number;
  workerTimeoutMs: number;
  workerMaxInputKb: number;
  workerMaxJobsPerWorker: number;
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
    adaptiveParallelism: true,
    maxFileSizeKb: 512,
    workerTimeoutMs: 15000,
    workerMaxInputKb: 2048,
    workerMaxJobsPerWorker: 200,
    exclude: DEFAULT_EXCLUDES
  },
  embeddings: {
    enabled: false,
    provider: "mock",
    apiKeyEnv: "DSP_EMBEDDINGS_API_KEY"
  }
};
