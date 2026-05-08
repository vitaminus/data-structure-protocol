import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DSPDatabase } from "../storage/db.ts";
import { buildUid, contentHash, stableNowIso } from "../graph/uid.ts";
import { semanticSearch } from "./search.ts";
import type { EmbeddingProvider } from "../graph/types.ts";

class CountingProvider implements EmbeddingProvider {
  calls = 0;
  constructor(private readonly key: string) {}

  cacheKey(): string {
    return this.key;
  }

  async embed(text: string): Promise<number[]> {
    this.calls += 1;
    return [text.length, this.key.length];
  }
}

class SynonymProvider implements EmbeddingProvider {
  cacheKey(): string {
    return "synonym-test";
  }

  async embed(text: string): Promise<number[]> {
    const normalized = text.toLowerCase();
    if (normalized.includes("signin") || normalized.includes("login")) {
      return [1, 0];
    }
    return [0, 1];
  }
}

class OppositeVectorProvider implements EmbeddingProvider {
  cacheKey(): string {
    return "opposite-vector-test";
  }

  async embed(text: string): Promise<number[]> {
    return text.trim().toLowerCase() === "auth" ? [1, 0] : [-1, 0];
  }
}

async function seedEmbedding(
  db: DSPDatabase,
  provider: EmbeddingProvider,
  uid: string,
  text: string
): Promise<void> {
  const providerKey = provider.cacheKey?.() ?? provider.constructor.name;
  db.setEmbedding(uid, contentHash(text), await provider.embed(text), providerKey, stableNowIso());
}

describe("semantic search", () => {
  let tempDir: string;
  let db: DSPDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-search-test-"));
    db = new DSPDatabase(tempDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("ranks camelCase exact token matches above weaker substring matches", async () => {
    const now = stableNowIso();
    const createUser = buildUid("function", "src/users.ts", "createUser");
    const session = buildUid("function", "src/session.ts", "createUserSession");

    for (const entity of [
      {
        uid: createUser,
        name: "createUser",
        description: "Creates an account"
      },
      {
        uid: session,
        name: "createUserSession",
        description: "Creates a session for a user account"
      }
    ]) {
      db.upsertEntity({
        ...entity,
        kind: "function",
        path: entity.uid.includes("users") ? "src/users.ts" : "src/session.ts",
        confidence: 1,
        provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
        createdAt: now,
        updatedAt: now
      });
    }

    const results = await semanticSearch(db, "create user", { topK: 2 });

    expect(results[0]?.uid).toBe(createUser);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it("uses neighbor text as a lightweight ranking signal", async () => {
    const now = stableNowIso();
    const login = buildUid("function", "src/auth.ts", "login");
    const token = buildUid("function", "src/token.ts", "createToken");

    for (const [uid, name, filePath] of [
      [login, "login", "src/auth.ts"],
      [token, "createToken", "src/token.ts"]
    ] as const) {
      db.upsertEntity({
        uid,
        kind: "function",
        name,
        path: filePath,
        confidence: 1,
        provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
        createdAt: now,
        updatedAt: now
      });
    }
    db.upsertRelation({
      from: login,
      to: token,
      kind: "calls",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
    });

    const results = await semanticSearch(db, "token", { topK: 5 });

    expect(results.map((result) => result.uid)).toContain(login);
    expect(results.find((result) => result.uid === login)?.explanation).toContain("neighbors=");
  });

  it("does not reuse embeddings from a different provider cache key", async () => {
    const now = stableNowIso();
    const uid = buildUid("function", "src/auth.ts", "login");
    db.upsertEntity({
      uid,
      kind: "function",
      name: "login",
      path: "src/auth.ts",
      description: "auth token validation",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });

    const first = new CountingProvider("mock:v1");
    await seedEmbedding(db, first, uid, ["login", "", "auth token validation", ""].join("\n"));
    expect(db.getEmbedding(uid)?.provider).toBe("mock:v1");

    const second = new CountingProvider("mock:v2");
    const results = await semanticSearch(db, "signin", { embeddingsEnabled: true, provider: second });

    expect(second.calls).toBe(1);
    expect(results).toEqual([]);
    expect(db.getEmbedding(uid)?.provider).toBe("mock:v1");
  });

  it("finds embedding-only matches when lexical FTS has no candidates", async () => {
    const now = stableNowIso();
    const loginUid = buildUid("function", "src/auth.ts", "login");
    const billingUid = buildUid("function", "src/billing.ts", "chargeCard");
    db.upsertEntity({
      uid: loginUid,
      kind: "function",
      name: "login",
      path: "src/auth.ts",
      description: "password session entrypoint",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });
    db.upsertEntity({
      uid: billingUid,
      kind: "function",
      name: "chargeCard",
      path: "src/billing.ts",
      description: "payment capture",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });

    expect(db.searchEntityUids("signin", 10)).toEqual([]);

    await seedEmbedding(db, new SynonymProvider(), loginUid, ["login", "", "password session entrypoint", ""].join("\n"));
    await seedEmbedding(db, new SynonymProvider(), billingUid, ["chargeCard", "", "payment capture", ""].join("\n"));

    const results = await semanticSearch(db, "signin", {
      topK: 2,
      embeddingsEnabled: true,
      provider: new SynonymProvider()
    });

    expect(results[0]?.uid).toBe(loginUid);
  });

  it("does not let negative semantic similarity penalize lexical matches", async () => {
    const now = stableNowIso();
    const uid = buildUid("function", "src/auth.ts", "validateToken");
    db.upsertEntity({
      uid,
      kind: "function",
      name: "validateToken",
      path: "src/auth.ts",
      description: "auth token validation",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });

    await seedEmbedding(db, new OppositeVectorProvider(), uid, ["validateToken", "", "auth token validation", ""].join("\n"));

    const results = await semanticSearch(db, "auth", {
      topK: 1,
      embeddingsEnabled: true,
      provider: new OppositeVectorProvider()
    });

    expect(results[0]?.uid).toBe(uid);
    expect(results[0]?.score).toBeGreaterThan(0);
    expect(results[0]?.explanation).toContain("lexical=");
  });

  it("ignores low-signal file containment relations during graph expansion", async () => {
    const now = stableNowIso();
    const tokenUid = buildUid("function", "src/session.ts", "createToken");
    const loginUid = buildUid("function", "src/auth.ts", "login");
    const tokenFileUid = buildUid("file", "src/session.ts");

    for (const entity of [
      {
        uid: tokenFileUid,
        kind: "file" as const,
        name: "session.ts",
        path: "src/session.ts"
      },
      {
        uid: tokenUid,
        kind: "function" as const,
        name: "createToken",
        path: "src/session.ts",
        description: "issues access token"
      },
      {
        uid: loginUid,
        kind: "function" as const,
        name: "login",
        path: "src/auth.ts"
      }
    ]) {
      db.upsertEntity({
        confidence: 1,
        provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
        createdAt: now,
        updatedAt: now,
        ...entity
      });
    }

    db.upsertRelation({
      from: tokenFileUid,
      to: tokenUid,
      kind: "contains",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
      metadata: { synthetic: true }
    });
    db.upsertRelation({
      from: loginUid,
      to: tokenUid,
      kind: "calls",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
    });

    const results = await semanticSearch(db, "token", { topK: 5 });

    expect(results.some((result) => result.uid === loginUid)).toBe(true);
    expect(results.some((result) => result.uid === tokenFileUid)).toBe(false);
  });
});
