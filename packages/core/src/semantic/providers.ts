import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "../graph/types.ts";
import type { DSPConfig } from "../config/types.ts";

export class MockEmbeddingProvider implements EmbeddingProvider {
  cacheKey(): string {
    return "mock";
  }

  async embed(text: string): Promise<number[]> {
    const hash = createHash("sha256").update(text).digest();
    const vector: number[] = [];
    for (let i = 0; i < 16; i += 1) {
      const value = hash[i] / 255;
      vector.push(value * 2 - 1);
    }
    return vector;
  }
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(baseUrl: string, apiKey: string, model: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.model = model;
  }

  cacheKey(): string {
    return `openai-compatible:${this.baseUrl}:${this.model}`;
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        input: text
      })
    });
    if (!response.ok) {
      throw new Error(`Embedding provider failed: ${response.status}`);
    }
    const json = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    return json.data[0]?.embedding ?? [];
  }
}

export function createEmbeddingProvider(config: DSPConfig): EmbeddingProvider | undefined {
  if (!config.embeddings.enabled) {
    return undefined;
  }
  if (config.embeddings.provider === "mock") {
    return new MockEmbeddingProvider();
  }

  const apiKeyEnv = config.embeddings.apiKeyEnv ?? "DSP_EMBEDDINGS_API_KEY";
  const apiKey = process.env[apiKeyEnv] ?? process.env.OPENAI_API_KEY;
  const baseUrl = config.embeddings.baseUrl ?? process.env.DSP_EMBEDDINGS_BASE_URL;
  const model = config.embeddings.model ?? process.env.DSP_EMBEDDINGS_MODEL;
  if (!apiKey || !baseUrl || !model) {
    return undefined;
  }
  return new OpenAICompatibleEmbeddingProvider(baseUrl, apiKey, model);
}
