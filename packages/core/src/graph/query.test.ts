import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DSPDatabase } from "../storage/db.ts";
import { buildUid, stableNowIso } from "./uid.ts";
import { getNeighbors, streamNeighbors } from "./query.ts";

describe("graph query", () => {
  let tempDir: string;
  let db: DSPDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-query-test-"));
    db = new DSPDatabase(tempDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not duplicate relations while traversing cyclic graphs", () => {
    const now = stableNowIso();
    const first = buildUid("file", "src/first.ts");
    const second = buildUid("file", "src/second.ts");
    const third = buildUid("file", "src/third.ts");

    for (const uid of [first, second, third]) {
      db.upsertEntity({
        uid,
        kind: "file",
        name: path.basename(uid.slice("file:".length)),
        path: uid.slice("file:".length),
        confidence: 1,
        provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
        createdAt: now,
        updatedAt: now
      });
    }

    for (const [from, to] of [
      [first, second],
      [second, third],
      [third, first]
    ] as const) {
      db.upsertRelation({
        from,
        to,
        kind: "depends_on",
        confidence: 1,
        provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
      });
    }

    const result = getNeighbors(db, first, 3);
    const relationKeys = result.relations.map((relation) =>
      JSON.stringify([relation.from, relation.kind, relation.to])
    );

    expect(result.entities.map((entity) => entity.uid).sort()).toEqual([first, second, third].sort());
    expect(new Set(relationKeys).size).toBe(relationKeys.length);
    expect(relationKeys).toHaveLength(3);
  });

  it("prioritizes high-value relations when traversal budgets are tight", () => {
    const now = stableNowIso();
    const root = buildUid("function", "src/root.ts", "root");
    const directCall = buildUid("function", "src/direct.ts", "direct");
    const confidentDependency = buildUid("function", "src/dependency.ts", "dependency");
    const weakImport = buildUid("function", "src/import.ts", "weakImport");

    for (const [uid, name] of [
      [root, "root"],
      [directCall, "direct"],
      [confidentDependency, "dependency"],
      [weakImport, "weakImport"]
    ] as const) {
      db.upsertEntity({
        uid,
        kind: "function",
        name,
        path: uid.slice("function:".length).split("#")[0],
        confidence: 1,
        provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
        createdAt: now,
        updatedAt: now
      });
    }

    db.upsertRelation({
      from: root,
      to: weakImport,
      kind: "imports",
      weight: 0.2,
      confidence: 0.7,
      provenance: [{ source: "ast", timestamp: now, confidence: 0.7 }]
    });
    db.upsertRelation({
      from: root,
      to: confidentDependency,
      kind: "depends_on",
      weight: 0.85,
      confidence: 0.9,
      provenance: [{ source: "ast", timestamp: now, confidence: 0.9 }]
    });
    db.upsertRelation({
      from: root,
      to: directCall,
      kind: "calls",
      weight: 0.95,
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
    });

    const result = getNeighbors(db, root, 1, { maxEntities: 3, maxRelations: 2 });
    const relationTargets = result.relations.map((relation) => relation.to);

    expect(result.entities.map((entity) => entity.uid)).toEqual([root, directCall, confidentDependency]);
    expect(relationTargets).toEqual([directCall, confidentDependency]);
    expect(relationTargets).not.toContain(weakImport);
  });

  it("streams traversal events before callers collect the full graph", async () => {
    const now = stableNowIso();
    const root = buildUid("function", "src/root.ts", "root");
    const child = buildUid("function", "src/child.ts", "child");

    for (const [uid, name] of [
      [root, "root"],
      [child, "child"]
    ] as const) {
      db.upsertEntity({
        uid,
        kind: "function",
        name,
        path: uid.slice("function:".length).split("#")[0],
        confidence: 1,
        provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
        createdAt: now,
        updatedAt: now
      });
    }
    db.upsertRelation({
      from: root,
      to: child,
      kind: "calls",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
    });

    const iterator = streamNeighbors(db, root, 1);
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "entity", entity: { uid: root }, depth: 0 }
    });
    await iterator.return(undefined);
  });

  it("honors file and token budgets during traversal", () => {
    const now = stableNowIso();
    const root = buildUid("function", "src/root.ts", "root");
    const child = buildUid("function", "src/child.ts", "child");

    for (const [uid, name] of [
      [root, "root"],
      [child, "child"]
    ] as const) {
      db.upsertEntity({
        uid,
        kind: "function",
        name,
        path: uid.slice("function:".length).split("#")[0],
        confidence: 1,
        provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
        createdAt: now,
        updatedAt: now
      });
    }
    db.upsertRelation({
      from: root,
      to: child,
      kind: "calls",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
    });

    expect(getNeighbors(db, root, 1, { maxFiles: 1 }).entities.map((entity) => entity.uid)).toEqual([root]);
    expect(getNeighbors(db, root, 1, { maxEstimatedTokens: 1 })).toEqual({ entities: [], relations: [] });
  });
});
