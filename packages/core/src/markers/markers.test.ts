import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DSPDatabase } from "../storage/db.js";
import { buildUid, stableNowIso } from "../graph/uid.js";
import { insertSourceMarkers } from "./markers.js";

describe("source markers", () => {
  let tempDir: string;
  let db: DSPDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-markers-test-"));
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src", "auth.ts"), "export function login() {}\n", "utf8");
    db = new DSPDatabase(tempDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("inserts protocol-style markers before indexed symbols", () => {
    const now = stableNowIso();
    db.upsertEntity({
      uid: buildUid("function", "src/auth.ts", "login"),
      kind: "function",
      name: "login",
      path: "src/auth.ts",
      language: "typescript",
      startLine: 1,
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });

    const result = insertSourceMarkers(db, tempDir);

    expect(result.markersInserted).toBe(1);
    expect(fs.readFileSync(path.join(tempDir, "src", "auth.ts"), "utf8")).toMatch(
      /^\/\/ @dsp func-[0-9a-f]{8}\nexport function login/m
    );
  });
});
