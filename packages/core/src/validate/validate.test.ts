import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DSPDatabase } from "../storage/db.js";
import { validateGraph } from "./validate.js";
import { buildUid, contentHash, stableNowIso } from "../graph/uid.js";

describe("validation", () => {
  let tempDir: string;
  let db: DSPDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-validate-test-"));
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src", "auth.ts"), "export const x = 1;\n", "utf8");
    db = new DSPDatabase(tempDir);
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
    db.markFileHash("src/auth.ts", contentHash("export const x = 1;\n"), now);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports stale hash after file change", () => {
    fs.writeFileSync(path.join(tempDir, "src", "auth.ts"), "export const x = 2;\n", "utf8");
    const result = validateGraph(db, tempDir);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.kind === "stale_hash")).toBe(true);
  });
});
