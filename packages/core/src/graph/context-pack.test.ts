import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DSPDatabase } from "../storage/db.ts";
import { buildUid, stableNowIso } from "./uid.ts";
import { buildContextPack } from "./context-pack.ts";
import { DEFAULT_CONFIG } from "../config/types.ts";
import { MockEmbeddingProvider } from "../semantic/providers.ts";
import type { EmbeddingProvider } from "./types.ts";

class KeywordEmbeddingProvider implements EmbeddingProvider {
  cacheKey(): string {
    return "keyword-test";
  }

  async embed(text: string): Promise<number[]> {
    const normalized = text.toLowerCase();
    if (normalized.includes("payment") || normalized.includes("billing") || normalized.includes("checkout")) {
      return [1, 0];
    }
    if (normalized.includes("cache")) {
      return [0, 1];
    }
    return [0.1, 0.1];
  }
}

describe("context pack", () => {
  let tempDir: string;
  let db: DSPDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-context-pack-test-"));
    db = new DSPDatabase(tempDir);
    const now = stableNowIso();
    db.upsertEntity({
      uid: buildUid("function", "src/auth.ts", "login"),
      kind: "function",
      name: "login",
      path: "src/auth.ts",
      description: "Handles authentication logic",
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

  it("returns bounded context response", async () => {
    const result = await buildContextPack(db, {
      task: "update authentication logic",
      maxTokens: 400
    });
    expect(result.maxTokens).toBe(400);
    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(result.relevantEntities.length).toBeGreaterThan(0);
  });

  it("includes transitive dependencies up to the requested depth without duplicates", async () => {
    const now = stableNowIso();
    const authUid = buildUid("function", "src/auth.ts", "login");
    const serviceUid = buildUid("function", "src/session.ts", "createSession");
    const storeUid = buildUid("function", "src/store.ts", "saveSession");
    const entities = [
      {
        uid: serviceUid,
        kind: "function" as const,
        name: "createSession",
        path: "src/session.ts",
        description: "Session service used by authentication login",
        confidence: 1
      },
      {
        uid: storeUid,
        kind: "function" as const,
        name: "saveSession",
        path: "src/store.ts",
        description: "Persists session records",
        confidence: 1
      }
    ];

    for (const entity of entities) {
      db.upsertEntity({
        ...entity,
        provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
        createdAt: now,
        updatedAt: now
      });
    }
    for (const [from, to] of [
      [authUid, serviceUid],
      [serviceUid, storeUid]
    ] as const) {
      db.upsertRelation({
        from,
        to,
        kind: "calls",
        confidence: 1,
        provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
      });
    }

    const result = await buildContextPack(db, {
      task: "authentication login",
      maxDepth: 2
    });
    const dependencyKeys = result.dependencies.map(
      (relation) => JSON.stringify([relation.from, relation.kind, relation.to])
    );
    const entityUids = result.relevantEntities.map((entity) => entity.uid);

    expect(dependencyKeys).toContain(JSON.stringify([authUid, "calls", serviceUid]));
    expect(dependencyKeys).toContain(JSON.stringify([serviceUid, "calls", storeUid]));
    expect(new Set(dependencyKeys).size).toBe(dependencyKeys.length);
    expect(entityUids).toContain(storeUid);
    expect(result.files).toContain("src/store.ts");
  });

  it("honors includeTests and includeCode options", async () => {
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "src", "auth.ts"),
      ["export function login() {", "  const token = createToken();", "  return token;", "}"].join(
        "\n"
      ),
      "utf8"
    );

    const now = stableNowIso();
    const authUid = buildUid("function", "src/auth.ts", "login");
    db.upsertEntity({
      uid: authUid,
      kind: "function",
      name: "login",
      path: "src/auth.ts",
      description: "Handles authentication logic",
      startLine: 1,
      endLine: 4,
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });
    db.upsertEntity({
      uid: buildUid("test", "src/auth.test.ts"),
      kind: "test",
      name: "auth.test.ts",
      path: "src/auth.test.ts",
      description: "authentication login regression",
      confidence: 1,
      provenance: [{ source: "test", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });

    const result = await buildContextPack(db, {
      task: "authentication login",
      includeTests: false,
      includeCode: "snippets-only",
      strategy: "debug"
    });

    expect(result.tests).toEqual([]);
    expect(result.relevantEntities.every((entity) => entity.kind !== "test")).toBe(true);
    expect(result.code?.[0]).toMatchObject({
      path: "src/auth.ts",
      mode: "snippets-only",
      truncated: false
    });
    expect(result.code?.[0]?.content).toContain("createToken");
  });

  it("uses configured embeddings provider when building context packs through services", async () => {
    const result = await buildContextPack(
      {
        db,
        config: {
          ...DEFAULT_CONFIG,
          embeddings: { ...DEFAULT_CONFIG.embeddings, enabled: true, provider: "mock" }
        },
        embeddingProvider: new MockEmbeddingProvider()
      },
      {
        task: "authentication logic",
        maxFiles: 3
      }
    );

    expect(result.relevantEntities.length).toBeGreaterThan(0);
    expect(db.cacheStats().embeddings).toBeGreaterThan(0);
  });

  it("uses semantic reranking to keep relevant graph nodes under tight file budgets", async () => {
    const now = stableNowIso();
    const checkoutUid = buildUid("function", "src/checkout.ts", "checkout");
    const billingUid = buildUid("function", "src/billing.ts", "settleInvoice");
    const cacheUid = buildUid("function", "src/cache.ts", "refreshCache");

    for (const entity of [
      {
        uid: checkoutUid,
        kind: "function" as const,
        name: "checkout",
        path: "src/checkout.ts",
        description: "checkout entry point for order submission"
      },
      {
        uid: billingUid,
        kind: "function" as const,
        name: "settleInvoice",
        path: "src/billing.ts",
        description: "payment billing settlement for invoices"
      },
      {
        uid: cacheUid,
        kind: "function" as const,
        name: "refreshCache",
        path: "src/cache.ts",
        description: "cache refresh utility"
      }
    ]) {
      db.upsertEntity({
        ...entity,
        confidence: 1,
        provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
        createdAt: now,
        updatedAt: now
      });
    }
    db.upsertRelation({
      from: checkoutUid,
      to: cacheUid,
      kind: "calls",
      weight: 0.95,
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
    });
    db.upsertRelation({
      from: checkoutUid,
      to: billingUid,
      kind: "uses",
      weight: 0.4,
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
    });

    const result = await buildContextPack(
      {
        db,
        config: {
          ...DEFAULT_CONFIG,
          embeddings: { ...DEFAULT_CONFIG.embeddings, enabled: true, provider: "mock" }
        },
        embeddingProvider: new KeywordEmbeddingProvider()
      },
      {
        task: "checkout payment bug",
        maxFiles: 2,
        maxDepth: 1
      }
    );

    expect(result.files).toContain("src/billing.ts");
    expect(result.files).not.toContain("src/cache.ts");
    expect(result.riskNotes).toContain("Semantic reranking applied to context entities.");
    expect(result.relevantEntities.find((entity) => entity.uid === billingUid)?.metadata?.contextRank).toMatchObject({
      semantic: 1
    });
  });

  it("orders suggested edits with dependencies before dependents", async () => {
    const now = stableNowIso();
    const serviceUid = buildUid("function", "src/service.ts", "loadUser");
    const appUid = buildUid("function", "src/app.ts", "renderUser");
    db.upsertEntity({
      uid: serviceUid,
      kind: "function",
      name: "loadUser",
      path: "src/service.ts",
      description: "user loading service dependency",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });
    db.upsertEntity({
      uid: appUid,
      kind: "function",
      name: "renderUser",
      path: "src/app.ts",
      description: "user rendering app dependent",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });
    db.upsertRelation({
      from: appUid,
      to: serviceUid,
      kind: "depends_on",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
    });

    const result = await buildContextPack(db, {
      task: "user service dependency render",
      maxFiles: 5,
      maxDepth: 1
    });

    expect(result.suggestedEditOrder.indexOf("src/service.ts")).toBeLessThan(
      result.suggestedEditOrder.indexOf("src/app.ts")
    );
  });

  it("does not silently drop direct graph neighbors after 5000 relations", async () => {
    const now = stableNowIso();
    const rootUid = buildUid("function", "src/root.ts", "root");
    const importantUid = buildUid("function", "src/zzzz-important.ts", "handler");
    db.transaction(() => {
      db.upsertEntity({
        uid: rootUid,
        kind: "function",
        name: "root",
        path: "src/root.ts",
        description: "root fanout",
        confidence: 1,
        provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
        createdAt: now,
        updatedAt: now
      });
      for (let index = 0; index < 5005; index += 1) {
        const uid = buildUid("function", `src/generated-${String(index).padStart(4, "0")}.ts`, "handler");
        db.upsertEntity({
          uid,
          kind: "function",
          name: `handler${index}`,
          path: `src/generated-${String(index).padStart(4, "0")}.ts`,
          description: "generated dependency",
          confidence: 1,
          provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
          createdAt: now,
          updatedAt: now
        });
        db.upsertRelation({
          from: rootUid,
          to: uid,
          kind: "calls",
          confidence: 1,
          provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
        });
      }
      db.upsertEntity({
        uid: importantUid,
        kind: "function",
        name: "handler",
        path: "src/zzzz-important.ts",
        description: "late ordered direct dependency",
        confidence: 1,
        provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
        createdAt: now,
        updatedAt: now
      });
      db.upsertRelation({
        from: rootUid,
        to: importantUid,
        kind: "calls",
        confidence: 1,
        provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
      });
    });

    const result = await buildContextPack(db, {
      task: "root fanout",
      maxDepth: 1,
      maxFiles: 6008
    });

    expect(result.relevantEntities.map((entity) => entity.uid)).toContain(importantUid);
    expect(result.truncated).toBe(true);
    expect(result.riskNotes.some((note) => note.includes("Graph dependencies truncated"))).toBe(true);
  });
});
