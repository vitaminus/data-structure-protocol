import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DSPDatabase } from "./db.js";
import { buildUid, stableNowIso } from "../graph/uid.js";

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
});
