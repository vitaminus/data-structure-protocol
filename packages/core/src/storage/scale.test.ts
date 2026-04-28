import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DSPDatabase } from "./db.ts";
import { stableNowIso } from "../graph/uid.ts";

const STRESS_ENTITIES = 300_000;
const STRESS_RELATIONS = 1_000_000;

describe("SQLite scale behavior", () => {
  let tempDir: string;
  let db: DSPDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-scale-test-"));
    db = new DSPDatabase(tempDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps search candidate scans bounded on a synthetic graph", () => {
    const now = stableNowIso();
    const entities = process.env.DSP_STRESS === "1" ? STRESS_ENTITIES : 1_000;
    const relations = process.env.DSP_STRESS === "1" ? STRESS_RELATIONS : 3_000;

    db.transaction(() => {
      for (let index = 0; index < entities; index += 1) {
        db.upsertEntity({
          uid: `function:src/file-${index}.ts#handler${index}`,
          kind: "function",
          name: `handler${index}`,
          path: `src/file-${index}.ts`,
          description: index % 10 === 0 ? "auth token validation" : "background utility",
          confidence: 1,
          provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
          createdAt: now,
          updatedAt: now
        });
      }
      for (let index = 0; index < relations; index += 1) {
        db.upsertRelation({
          from: `function:src/file-${index % entities}.ts#handler${index % entities}`,
          to: `function:src/file-${(index + 1) % entities}.ts#handler${(index + 1) % entities}`,
          kind: "calls",
          confidence: 0.8,
          provenance: [{ source: "ast", timestamp: now, confidence: 0.8 }]
        });
      }
    });

    const candidates = db.searchEntityCandidates("auth token validation", 500);
    expect(candidates.uids.length).toBeGreaterThan(0);
    expect(candidates.candidatesScanned).toBeLessThanOrEqual(500);
    expect(db.getDanglingRelations(10)).toEqual([]);
  }, 120_000);
});
