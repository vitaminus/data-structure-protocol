import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LanguageAdapter, ParseResult } from "../graph/types.ts";
import { buildUid, contentHash, stableNowIso } from "../graph/uid.ts";
import { DEFAULT_CONFIG } from "../config/types.ts";
import { DSPDatabase } from "../storage/db.ts";
import { repairGraph } from "./repair.ts";
import { validateGraph } from "./validate.ts";

class RepairAdapter implements LanguageAdapter {
  language = "typescript";

  canHandle(filePath: string): boolean {
    return filePath.endsWith(".ts");
  }

  async parseFile(filePath: string): Promise<ParseResult> {
    const now = stableNowIso();
    const fileUid = buildUid("file", filePath);
    const functionUid = buildUid("function", filePath, "fixed");
    return {
      entities: [
        {
          uid: functionUid,
          kind: "function",
          name: "fixed",
          path: filePath,
          confidence: 1,
          provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
          createdAt: now,
          updatedAt: now
        }
      ],
      relations: [
        {
          from: fileUid,
          to: functionUid,
          kind: "contains",
          confidence: 1,
          provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
        }
      ],
      unresolvedReferences: []
    };
  }

  extractEntities(parseResult: ParseResult) {
    return parseResult.entities;
  }

  extractRelations(parseResult: ParseResult) {
    return parseResult.relations;
  }

  extractPublicAPI() {
    return [];
  }
}

describe("graph repair", () => {
  let tempDir: string;
  let db: DSPDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-repair-test-"));
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
    db = new DSPDatabase(tempDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("plans repairs without changing graph data in dry-run mode", async () => {
    const now = stableNowIso();
    const missingUid = buildUid("file", "src/missing.ts");
    db.upsertEntity({
      uid: missingUid,
      kind: "file",
      name: "missing.ts",
      path: "src/missing.ts",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });

    const result = await repairGraph(db, tempDir, [new RepairAdapter()], DEFAULT_CONFIG, { dryRun: true });

    expect(result.actions).toContainEqual(
      expect.objectContaining({ kind: "missing_file", status: "planned", path: "src/missing.ts" })
    );
    expect(result.validationAfter).toBeUndefined();
    expect(db.getEntity(missingUid)).toBeDefined();
  });

  it("defaults to planning mode until apply is explicitly enabled", async () => {
    const now = stableNowIso();
    const missingUid = buildUid("file", "src/missing.ts");
    db.upsertEntity({
      uid: missingUid,
      kind: "file",
      name: "missing.ts",
      path: "src/missing.ts",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });

    const result = await repairGraph(db, tempDir, [new RepairAdapter()], DEFAULT_CONFIG);

    expect(result.dryRun).toBe(true);
    expect(result.actions).toContainEqual(
      expect.objectContaining({ kind: "missing_file", status: "planned", path: "src/missing.ts" })
    );
    expect(db.getEntity(missingUid)).toBeDefined();
  });

  it("repairs missing files, stale hashes, unresolved references, and dangling relations", async () => {
    const now = stableNowIso();
    const stalePath = "src/stale.ts";
    const staleFileUid = buildUid("file", stalePath);
    const missingPath = "src/missing.ts";
    const missingUid = buildUid("file", missingPath);
    fs.writeFileSync(path.join(tempDir, stalePath), "export const fixed = 2;\n", "utf8");

    for (const [uid, filePath] of [
      [staleFileUid, stalePath],
      [missingUid, missingPath]
    ] as const) {
      db.upsertEntity({
        uid,
        kind: "file",
        name: path.basename(filePath),
        path: filePath,
        confidence: 1,
        provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
        createdAt: now,
        updatedAt: now
      });
    }
    db.markFileHash(stalePath, contentHash("export const fixed = 1;\n"), now);
    db.upsertRelation({
      from: staleFileUid,
      to: buildUid("function", "src/missing-endpoint.ts", "gone"),
      kind: "calls",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
    });
    db.upsertUnresolvedReference(
      {
        path: stalePath,
        fromUid: staleFileUid,
        symbol: "Fixed",
        kind: "type",
        confidence: 0.5
      },
      now
    );

    expect(validateGraph(db, tempDir).ok).toBe(false);

    const result = await repairGraph(db, tempDir, [new RepairAdapter()], DEFAULT_CONFIG, { apply: true });

    expect(result.actions.map((action) => action.kind)).toEqual(
      expect.arrayContaining(["missing_file", "stale_hash", "dangling_relation", "unresolved_reference"])
    );
    expect(result.validationAfter?.errors).toBe(0);
    expect(result.validationAfter?.warnings).toBe(0);
    expect(db.getEntity(missingUid)).toBeUndefined();
    expect(db.getRelationsFrom(staleFileUid).some((relation) => relation.kind === "calls")).toBe(false);
    expect(db.getEntity(buildUid("function", stalePath, "fixed"))).toBeDefined();
    expect(db.getUnresolvedReferences()).toEqual([]);
  });

  it("cleans orphaned cache rows and stale operational state only when explicitly requested", async () => {
    const now = stableNowIso();
    const oldIso = stableNowIso(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
    db.markFileHash("src/orphan.ts", "hash", now);
    db.setCachedParseResult(
      "typescript",
      "src/orphan.ts",
      "hash",
      { entities: [], relations: [], unresolvedReferences: [] },
      now
    );
    const raw = new Database(db.dbPath);
    raw
      .prepare("INSERT INTO embeddings(uid, content_hash, vector_json, provider, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("missing:entity", "hash", "[1,2,3]", "mock", now);
    raw
      .prepare("INSERT INTO checkpoints(name, metadata_json, created_at) VALUES (?, ?, ?)")
      .run("index:stale", "{}", oldIso);
    raw
      .prepare("INSERT INTO index_runs(started_at, mode, status, metadata_json) VALUES (?, ?, 'running', ?)")
      .run(oldIso, "index", "{}");
    raw.close();

    const result = await repairGraph(db, tempDir, [new RepairAdapter()], DEFAULT_CONFIG, {
      apply: true,
      cleanOrphanedFileHashes: true,
      cleanOrphanedEmbeddings: true,
      cleanStaleParseCache: true,
      clearStaleCheckpoints: true,
      failAbandonedRuns: true
    });

    expect(result.actions.map((action) => action.kind)).toEqual(
      expect.arrayContaining([
        "orphaned_file_hash",
        "orphaned_embedding",
        "stale_parse_cache",
        "stale_checkpoint",
        "abandoned_run"
      ])
    );
    const report = db.doctor();
    expect(report.orphanedFileHashes).not.toContain("src/orphan.ts");
    expect(report.orphanedEmbeddings).not.toContain("missing:entity");
    expect(report.parseCache.stalePaths).not.toContain("src/orphan.ts");
    expect(report.staleCheckpoints).toEqual([]);
    expect(report.abandonedIndexRuns).toEqual([]);
  });
});
