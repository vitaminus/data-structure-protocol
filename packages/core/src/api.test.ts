import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config/types.ts";
import type { DSPServices } from "./api.ts";
import { runSearch } from "./api.ts";
import type { EmbeddingProvider } from "./graph/types.ts";
import { buildUid, contentHash, stableNowIso } from "./graph/uid.ts";
import { DSPDatabase } from "./storage/db.ts";

class KeywordEmbeddingProvider implements EmbeddingProvider {
  cacheKey(): string {
    return "api-keyword-test";
  }

  async embed(text: string): Promise<number[]> {
    const normalized = text.toLowerCase();
    if (normalized.includes("billing") || normalized.includes("payment")) {
      return [1, 0];
    }
    return [0, 1];
  }
}

describe("api", () => {
  let tempDir: string;
  let db: DSPDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-api-test-"));
    db = new DSPDatabase(tempDir);
    const now = stableNowIso();
    db.upsertEntity({
      uid: buildUid("function", "src/checkout.ts", "settleInvoice"),
      kind: "function",
      name: "settleInvoice",
      path: "src/checkout.ts",
      description: "payment settlement",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function services(): DSPServices {
    return {
      rootDir: tempDir,
      db,
      config: {
        ...DEFAULT_CONFIG,
        embeddings: { ...DEFAULT_CONFIG.embeddings, enabled: true, provider: "mock" }
      },
      embeddingProvider: new KeywordEmbeddingProvider(),
      adapters: []
    };
  }

  it("uses configured embeddings for search unless explicitly disabled", async () => {
    const semanticText = ["settleInvoice", "", "payment settlement", ""].join("\n");
    db.setEmbedding(
      buildUid("function", "src/checkout.ts", "settleInvoice"),
      contentHash(semanticText),
      await services().embeddingProvider!.embed(semanticText),
      services().embeddingProvider!.cacheKey!(),
      stableNowIso()
    );
    const semanticResults = await runSearch(services(), "billing", { topK: 3 });
    expect(semanticResults.map((result) => result.uid)).toContain(
      buildUid("function", "src/checkout.ts", "settleInvoice")
    );

    const lexicalOnlyResults = await runSearch(services(), "billing", {
      topK: 3,
      embeddingsEnabled: false
    });
    expect(lexicalOnlyResults).toEqual([]);
  });
});
