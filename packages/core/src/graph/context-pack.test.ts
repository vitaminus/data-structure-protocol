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
});
