import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DSPDatabase } from "../storage/db.ts";
import { analyzeImpact } from "./impact.ts";
import { buildUid, stableNowIso } from "../graph/uid.ts";

describe("impact analysis", () => {
  let tempDir: string;
  let db: DSPDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-impact-test-"));
    db = new DSPDatabase(tempDir);
    const now = stableNowIso();
    const target = buildUid("function", "src/billing/calc.ts", "calculate");
    const invoice = buildUid("file", "src/billing/invoice.ts");
    const api = buildUid("route", "src/api/invoices.ts", "/invoices");
    const test = buildUid("test", "src/billing/calc.test.ts");

    db.upsertEntity({
      uid: target,
      kind: "function",
      name: "calculate",
      path: "src/billing/calc.ts",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });
    for (const [uid, kind, name, filePath] of [
      [invoice, "file", "invoice.ts", "src/billing/invoice.ts"],
      [api, "route", "/invoices", "src/api/invoices.ts"],
      [test, "test", "calc.test.ts", "src/billing/calc.test.ts"]
    ] as const) {
      db.upsertEntity({
        uid,
        kind,
        name,
        path: filePath,
        confidence: 1,
        provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
        createdAt: now,
        updatedAt: now
      });
    }
    db.upsertRelation({
      from: invoice,
      to: target,
      kind: "calls",
      confidence: 0.9,
      provenance: [{ source: "ast", timestamp: now, confidence: 0.9 }]
    });
    db.upsertRelation({
      from: api,
      to: invoice,
      kind: "depends_on",
      confidence: 0.9,
      provenance: [{ source: "ast", timestamp: now, confidence: 0.9 }]
    });
    db.upsertRelation({
      from: test,
      to: target,
      kind: "tests",
      confidence: 1,
      provenance: [{ source: "test", timestamp: now, confidence: 1 }]
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns direct and transitive dependents", () => {
    const result = analyzeImpact(db, buildUid("function", "src/billing/calc.ts", "calculate"));
    expect(result.directDependents.length).toBeGreaterThanOrEqual(2);
    expect(result.transitiveDependents.length).toBeGreaterThanOrEqual(1);
    expect(result.testsAffected.length).toBeGreaterThanOrEqual(1);
  });
});
