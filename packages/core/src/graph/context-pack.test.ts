import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DSPDatabase } from "../storage/db.js";
import { buildUid, stableNowIso } from "./uid.js";
import { buildContextPack } from "./context-pack.js";

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
});
