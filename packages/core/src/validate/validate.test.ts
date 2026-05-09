import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DSPDatabase } from "../storage/db.ts";
import { validateGraph } from "./validate.ts";
import { buildUid, contentHash, stableNowIso } from "../graph/uid.ts";

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
    expect(result.issues.find((issue) => issue.kind === "stale_hash")?.severity).toBe("warning");
    expect(result.summary).toEqual({ total: 1, errors: 0, warnings: 1, info: 0 });
  });

  it("skips unchanged files without rereading content when cached stat metadata matches", () => {
    const result = validateGraph(db, tempDir, { changedOnly: true });
    expect(result.ok).toBe(true);
    expect(result.summary).toEqual({ total: 0, errors: 0, warnings: 0, info: 0 });
  });

  it("keeps deep graph checks behind an explicit option", () => {
    const now = stableNowIso();
    db.upsertEntity({
      uid: buildUid("function", "src/auth.ts#login"),
      kind: "function",
      name: "login",
      path: "src/auth.ts",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });
    db.upsertRelation({
      from: buildUid("function", "src/auth.ts#login"),
      to: "function:missing#dep",
      kind: "calls",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
    });

    const shallow = validateGraph(db, tempDir, { deep: false });
    const deep = validateGraph(db, tempDir, { deep: true });

    expect(shallow.issues.some((issue) => issue.kind === "dangling_relation")).toBe(false);
    expect(deep.issues.some((issue) => issue.kind === "dangling_relation")).toBe(true);
  });

  it("reports binary files as warnings instead of treating them as missing", () => {
    fs.writeFileSync(path.join(tempDir, "src", "auth.ts"), Buffer.from([0x61, 0x00, 0x62]));

    const result = validateGraph(db, tempDir);

    expect(result.issues).toContainEqual(
      expect.objectContaining({
        kind: "binary_file",
        severity: "warning",
        path: "src/auth.ts"
      })
    );
  });

  it("reports invalid UTF-8 files as warnings", () => {
    fs.writeFileSync(path.join(tempDir, "src", "auth.ts"), Buffer.from([0xc3, 0x28]));

    const result = validateGraph(db, tempDir);

    expect(result.issues).toContainEqual(
      expect.objectContaining({
        kind: "invalid_utf8",
        severity: "warning",
        path: "src/auth.ts"
      })
    );
  });
});
