import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DSPDatabase } from "./db.ts";
import { buildUid, stableNowIso } from "../graph/uid.ts";

describe("DSPDatabase", () => {
  let tempDir: string;
  let db: DSPDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-core-test-"));
    db = new DSPDatabase(tempDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("stores entity and relation with provenance", () => {
    const now = stableNowIso();
    db.upsertEntity({
      uid: buildUid("file", "src/auth.ts"),
      kind: "file",
      name: "auth.ts",
      path: "src/auth.ts",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });
    db.upsertRelation({
      from: buildUid("file", "src/auth.ts"),
      to: buildUid("function", "src/auth.ts", "login"),
      kind: "contains",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
    });
    expect(db.getEntity(buildUid("file", "src/auth.ts"))?.name).toBe("auth.ts");
    expect(db.getRelationsFrom(buildUid("file", "src/auth.ts")).length).toBe(1);
  });

  it("deletes manual entities and relations", () => {
    const now = stableNowIso();
    const fileUid = buildUid("file", "src/auth.ts");
    const fnUid = buildUid("function", "src/auth.ts", "login");
    db.upsertEntity({
      uid: fileUid,
      kind: "file",
      name: "auth.ts",
      path: "src/auth.ts",
      confidence: 1,
      provenance: [{ source: "human", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });
    db.upsertEntity({
      uid: fnUid,
      kind: "function",
      name: "login",
      path: "src/auth.ts",
      confidence: 1,
      provenance: [{ source: "human", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });
    db.upsertRelation({
      from: fileUid,
      to: fnUid,
      kind: "exports",
      confidence: 1,
      provenance: [{ source: "human", timestamp: now, confidence: 1 }]
    });

    expect(db.deleteRelation(fileUid, fnUid, "exports")).toBe(1);
    expect(db.getRelationsFrom(fileUid)).toHaveLength(0);
    expect(db.deleteEntity(fnUid)).toBe(true);
    expect(db.getEntity(fnUid)).toBeUndefined();
  });

  it("roundtrips json export/import", () => {
    const now = stableNowIso();
    const uid = buildUid("file", "src/main.ts");
    db.upsertEntity({
      uid,
      kind: "file",
      name: "main.ts",
      path: "src/main.ts",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });
    const output = path.join(tempDir, "graph.json");
    db.exportJson(output);

    const fresh = new DSPDatabase(path.join(tempDir, "fresh"));
    fresh.importJson(output);
    expect(fresh.getEntity(uid)?.name).toBe("main.ts");
    fresh.close();
  });

  it("exports a protocol-compatible plain text graph", () => {
    const now = stableNowIso();
    const fileUid = buildUid("file", "src/auth.ts");
    const fnUid = "func-1234abcd";
    db.upsertEntity({
      uid: fileUid,
      kind: "file",
      name: "auth.ts",
      path: "src/auth.ts",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });
    db.upsertEntity({
      uid: fnUid,
      kind: "function",
      name: "login",
      path: "src/auth.ts",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });
    db.upsertRelation({
      from: fileUid,
      to: fnUid,
      kind: "exports",
      reason: "public login API",
      confidence: 0.9,
      provenance: [{ source: "ast", timestamp: now, confidence: 0.9 }]
    });

    db.exportProtocol(tempDir);
    const protocolDir = path.join(tempDir, ".dsp", "protocol");
    const uidMap = JSON.parse(fs.readFileSync(path.join(protocolDir, "uid-map.json"), "utf8")) as Record<string, string>;
    expect(uidMap[fileUid]).toMatch(/^obj-/);
    expect(uidMap[fnUid]).toBe(fnUid);
    expect(fs.existsSync(path.join(protocolDir, uidMap[fileUid]!, "description"))).toBe(true);
    expect(fs.readFileSync(path.join(protocolDir, "TOC"), "utf8")).toContain(uidMap[fileUid]!);
  });

  it("creates indexes for common graph lookups", () => {
    const sqlite = new Database(db.dbPath, { readonly: true });
    const rows = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as { name: string }[];
    sqlite.close();

    expect(rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "idx_entities_path",
        "idx_entities_kind_path",
        "idx_relations_from_uid",
        "idx_relations_to_uid",
        "idx_relations_kind",
        "idx_unresolved_references_path"
      ])
    );
  });
});
