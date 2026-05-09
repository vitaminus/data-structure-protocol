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

  it("exports deterministic JSONL graph files with a manifest", () => {
    const now = stableNowIso();
    const fileUid = buildUid("file", "src/auth.ts");
    const fnUid = buildUid("function", "src/auth.ts", "login");
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
    db.upsertRelation({
      from: fileUid,
      to: fnUid,
      kind: "contains",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
    });
    db.upsertUnresolvedReference(
      {
        path: "src/auth.ts",
        fromUid: fnUid,
        symbol: "MissingType",
        kind: "type",
        confidence: 0.4
      },
      now
    );

    const outputDir = path.join(tempDir, "jsonl-export");
    db.exportJsonl(outputDir);

    const entities = fs
      .readFileSync(path.join(outputDir, "entities.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { uid: string });
    const relations = fs
      .readFileSync(path.join(outputDir, "relations.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { from: string; to: string; kind: string });
    const unresolved = fs
      .readFileSync(path.join(outputDir, "unresolved.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { symbol: string });
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "manifest.json"), "utf8")) as {
      format: string;
      counts: { entities: number; relations: number; unresolvedReferences: number };
    };

    expect(entities.map((entity) => entity.uid)).toEqual([fileUid, fnUid].sort());
    expect(relations).toEqual([expect.objectContaining({ from: fileUid, to: fnUid, kind: "contains" })]);
    expect(unresolved).toEqual([expect.objectContaining({ symbol: "MissingType" })]);
    expect(manifest).toMatchObject({
      format: "dsp-jsonl",
      counts: { entities: 2, relations: 1, unresolvedReferences: 1 }
    });
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
        "idx_entities_language_kind_path",
        "idx_entities_path_kind",
        "idx_relations_from_uid",
        "idx_relations_to_uid",
        "idx_relations_kind",
        "idx_relations_kind_from_uid",
        "idx_relations_kind_to_uid",
        "idx_file_dependencies_to_path",
        "idx_file_dependencies_from_path",
        "idx_symbol_dependencies_to_uid",
        "idx_symbol_dependencies_from_uid",
        "idx_unresolved_references_path"
      ])
    );
  });

  it("finds non-container orphans with a direct SQL query", () => {
    const now = stableNowIso();
    const fileUid = buildUid("file", "src/auth.ts");
    const orphanUid = buildUid("function", "src/auth.ts", "orphan");
    const linkedUid = buildUid("function", "src/auth.ts", "linked");
    const callerUid = buildUid("function", "src/auth.ts", "caller");

    for (const entity of [
      {
        uid: fileUid,
        kind: "file" as const,
        name: "auth.ts"
      },
      {
        uid: orphanUid,
        kind: "function" as const,
        name: "orphan"
      },
      {
        uid: linkedUid,
        kind: "function" as const,
        name: "linked"
      },
      {
        uid: callerUid,
        kind: "function" as const,
        name: "caller"
      }
    ]) {
      db.upsertEntity({
        ...entity,
        path: "src/auth.ts",
        confidence: 1,
        provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
        createdAt: now,
        updatedAt: now
      });
    }

    db.upsertRelation({
      from: fileUid,
      to: orphanUid,
      kind: "contains",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
    });
    db.upsertRelation({
      from: callerUid,
      to: linkedUid,
      kind: "calls",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
    });

    expect(db.getOrphanEntities().map((entity) => entity.uid)).toEqual([callerUid, orphanUid].sort());
  });

  it("reports database integrity and orphaned records", () => {
    const sqlite = new Database(db.dbPath);
    sqlite
      .prepare(
        "INSERT INTO embeddings(uid, content_hash, vector_json, provider, updated_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run("missing:entity", "hash", "[1,2,3]", "test", stableNowIso());
    sqlite
      .prepare(
        "INSERT INTO unresolved_references(path, from_uid, symbol, kind, reason, confidence, created_at, resolved) VALUES (?, ?, ?, ?, ?, ?, ?, 0)"
      )
      .run("src/missing.ts", null, "GhostType", "type", null, 0.5, stableNowIso());
    sqlite
      .prepare("INSERT INTO file_hashes(path, content_hash, indexed_at) VALUES (?, ?, ?)")
      .run("src/missing.ts", "hash", stableNowIso());
    sqlite
      .prepare(
        "INSERT INTO parse_cache(language, file_path, content_hash, payload_json, updated_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run("typescript", "src/ghost.ts", "hash", "{\"entities\":[],\"relations\":[],\"unresolvedReferences\":[]}", stableNowIso());
    sqlite.close();

    const report = db.doctor();

    expect(report.schema).toEqual({
      currentVersion: db.expectedSchemaVersion(),
      expectedVersion: db.expectedSchemaVersion(),
      upToDate: true
    });
    expect(report.integrity.ok).toBe(true);
    expect(report.orphanedEmbeddings).toContain("missing:entity");
    expect(report.orphanedFileHashes).toContain("src/missing.ts");
    expect(report.danglingUnresolvedPaths).toContain("src/missing.ts");
    expect(report.parseCache.entries).toBe(1);
    expect(report.parseCache.stalePaths).toContain("src/ghost.ts");
    expect(report.maintenance.freelistPages).toBeGreaterThanOrEqual(0);
  });

  it("clears parse cache alongside other cache tables", () => {
    const now = stableNowIso();
    db.setEmbedding("uid:test", "hash", [1, 2, 3], "mock", now);
    db.markFileHash("src/auth.ts", "hash", now, { mtimeMs: 1, sizeBytes: 2 });
    db.setCachedParseResult("typescript", "src/auth.ts", "hash", {
      entities: [],
      relations: [],
      unresolvedReferences: []
    }, now);

    expect(db.cacheStats()).toMatchObject({ embeddings: 1, fileHashes: 1, parseCache: 1 });

    db.clearCache();

    expect(db.cacheStats()).toMatchObject({ embeddings: 0, fileHashes: 0, parseCache: 0 });
  });

  it("prefilters nearest embeddings through bucketed candidates", () => {
    const now = stableNowIso();
    db.setEmbedding("entity:alpha", "hash-a", [1, 1, 1, 1, 1, 1, 1, 1], "mock", now);
    db.setEmbedding("entity:beta", "hash-b", [0.8, 0.8, 0.7, 0.9, 1, 0.6, 0.7, 0.9], "mock", now);
    db.setEmbedding("entity:gamma", "hash-c", [-1, -1, -1, -1, -1, -1, -1, -1], "mock", now);

    const results = db.nearestEmbeddingsByProvider("mock", [1, 1, 1, 1, 1, 1, 1, 1], {
      topK: 2,
      scanLimit: 4
    });

    expect(results.map((row) => row.uid)).toEqual(["entity:alpha", "entity:beta"]);
  });

  it("stores multiple LSH bucket entries per embedding", () => {
    const now = stableNowIso();
    db.setEmbedding("entity:alpha", "hash-a", [1, 0.5, -0.25, 0.75, -0.5, 0.1, 0.2, -0.3], "mock", now);

    const sqlite = new Database(db.dbPath, { readonly: true });
    const rows = sqlite
      .prepare("SELECT bucket_key FROM embedding_buckets WHERE provider = ? AND uid = ? ORDER BY bucket_key")
      .all("mock", "entity:alpha") as { bucket_key: string }[];
    sqlite.close();

    expect(rows).toHaveLength(4);
    expect(rows.every((row) => /^f\d:/.test(row.bucket_key))).toBe(true);
  });

  it("indexes entities into SQLite FTS for lexical candidate lookup", () => {
    const now = stableNowIso();
    const uid = buildUid("function", "src/users.ts", "createUser");
    db.upsertEntity({
      uid,
      kind: "function",
      name: "createUser",
      path: "src/users.ts",
      description: "Creates account records",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });

    expect(db.searchEntityUids("create user", 10)).toContain(uid);
  });

  it("rebuilds FTS when opening a legacy database without schema metadata", () => {
    db.close();
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-legacy-db-test-"));
    const dspDir = path.join(legacyRoot, ".dsp");
    fs.mkdirSync(dspDir, { recursive: true });
    const sqlite = new Database(path.join(dspDir, "dsp.sqlite"));
    sqlite.exec(`
      CREATE TABLE entities (
        uid TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT,
        language TEXT,
        signature TEXT,
        start_line INTEGER,
        end_line INTEGER,
        description TEXT,
        docstring TEXT,
        tags_json TEXT,
        metadata_json TEXT,
        confidence REAL NOT NULL,
        provenance_json TEXT NOT NULL,
        source_priority INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const now = stableNowIso();
    const uid = buildUid("function", "src/auth.ts", "validateToken");
    sqlite
      .prepare(
        `
        INSERT INTO entities (
          uid, kind, name, path, language, signature, start_line, end_line,
          description, docstring, tags_json, metadata_json, confidence, provenance_json,
          source_priority, created_at, updated_at
        ) VALUES (?, 'function', 'validateToken', 'src/auth.ts', 'typescript', NULL, NULL, NULL,
          'Validates bearer tokens', NULL, '[]', '{}', 1, ?, 10, ?, ?)
        `
      )
      .run(uid, JSON.stringify([{ source: "ast", timestamp: now, confidence: 1 }]), now, now);
    sqlite.close();

    const migrated = new DSPDatabase(legacyRoot);
    try {
      expect(migrated.searchEntityUids("validate token", 10)).toContain(uid);
    } finally {
      migrated.close();
      fs.rmSync(legacyRoot, { recursive: true, force: true });
      db = new DSPDatabase(tempDir);
    }
  });

  it("reports embedding counts by provider", () => {
    const now = stableNowIso();
    db.setEmbedding("function:src/auth.ts#login", "hash-a", [0.1, 0.2], "mock", now);
    db.setEmbedding("function:src/user.ts#create", "hash-b", [0.3, 0.4], "openai-compatible", now);
    db.setEmbedding("function:src/user.ts#update", "hash-c", [0.5, 0.6], "mock", now);

    expect(db.embeddingStats()).toEqual({
      total: 3,
      byProvider: {
        mock: 2,
        "openai-compatible": 1
      }
    });
  });

  it("returns entity batches in requested UID order", () => {
    const now = stableNowIso();
    const uids = Array.from({ length: 1_205 }, (_, index) =>
      buildUid("function", `src/batch-${index}.ts`, `handler${index}`)
    );
    db.transaction(() => {
      for (const [index, uid] of uids.entries()) {
        db.upsertEntity({
          uid,
          kind: "function",
          name: `handler${index}`,
          path: `src/batch-${index}.ts`,
          confidence: 1,
          provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
          createdAt: now,
          updatedAt: now
        });
      }
    });

    const requested = [uids[1000]!, uids[3]!, "function:missing.ts#missing", uids[604]!, uids[0]!];
    expect(db.getEntitiesByUid(requested).map((entity) => entity.uid)).toEqual([
      uids[1000],
      uids[3],
      uids[604],
      uids[0]
    ]);
  });

  it("reuses a request-scoped cache for batched entity and relation reads", () => {
    const now = stableNowIso();
    const fileUid = buildUid("file", "src/auth.ts");
    const fnUid = buildUid("function", "src/auth.ts", "login");
    const callerUid = buildUid("function", "src/caller.ts", "handleLogin");
    for (const entity of [
      {
        uid: fileUid,
        kind: "file" as const,
        name: "auth.ts",
        path: "src/auth.ts"
      },
      {
        uid: fnUid,
        kind: "function" as const,
        name: "login",
        path: "src/auth.ts"
      },
      {
        uid: callerUid,
        kind: "function" as const,
        name: "handleLogin",
        path: "src/caller.ts"
      }
    ]) {
      db.upsertEntity({
        ...entity,
        confidence: 1,
        provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
        createdAt: now,
        updatedAt: now
      });
    }
    db.upsertRelation({
      from: callerUid,
      to: fnUid,
      kind: "calls",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
    });

    const cache = db.createGraphReadCache();
    const firstEntities = db.getEntitiesByUidCached([callerUid, fnUid], cache);
    const secondEntities = db.getEntitiesByUidCached([callerUid, fnUid], cache);
    const firstRelations = db.getRelationsToCached(fnUid, cache);
    const secondRelations = db.getRelationsToCached(fnUid, cache);

    expect(firstEntities.map((entity) => entity.uid)).toEqual([callerUid, fnUid]);
    expect(secondEntities).toEqual(firstEntities);
    expect(secondRelations).toBe(firstRelations);
    expect(firstRelations).toContainEqual(expect.objectContaining({ from: callerUid, to: fnUid, kind: "calls" }));
  });

  it("returns touching relations with endpoint entities for batched UID reads", () => {
    const now = stableNowIso();
    const rootUid = buildUid("function", "src/root.ts", "root");
    const childUid = buildUid("function", "src/child.ts", "child");
    const helperUid = buildUid("function", "src/helper.ts", "helper");

    for (const [uid, name, filePath] of [
      [rootUid, "root", "src/root.ts"],
      [childUid, "child", "src/child.ts"],
      [helperUid, "helper", "src/helper.ts"]
    ] as const) {
      db.upsertEntity({
        uid,
        kind: "function",
        name,
        path: filePath,
        confidence: 1,
        provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
        createdAt: now,
        updatedAt: now
      });
    }
    db.upsertRelation({
      from: rootUid,
      to: childUid,
      kind: "calls",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
    });
    db.upsertRelation({
      from: helperUid,
      to: childUid,
      kind: "uses",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
    });

    const cache = db.createGraphReadCache();
    const result = db.getTouchingRelationsWithEndpoints([childUid], cache);

    expect(result.relations).toEqual([
      expect.objectContaining({ from: helperUid, to: childUid, kind: "uses" }),
      expect.objectContaining({ from: rootUid, to: childUid, kind: "calls" })
    ]);
    expect(result.entities.map((entity) => entity.uid).sort()).toEqual([childUid, helperUid, rootUid].sort());
  });

  it("clears AST data for paths with more entities than SQLite variable limits allow", () => {
    const now = stableNowIso();
    const filePath = "src/large-module.ts";
    const externalUid = buildUid("function", "src/external.ts", "external");
    const uids = Array.from({ length: 650 }, (_, index) =>
      buildUid("function", filePath, `handler${index}`)
    );
    db.transaction(() => {
      db.upsertEntity({
        uid: externalUid,
        kind: "function",
        name: "external",
        path: "src/external.ts",
        confidence: 1,
        provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
        createdAt: now,
        updatedAt: now
      });
      for (const [index, uid] of uids.entries()) {
        db.upsertEntity({
          uid,
          kind: "function",
          name: `handler${index}`,
          path: filePath,
          description: "bulk cleanup target",
          confidence: 1,
          provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
          createdAt: now,
          updatedAt: now
        });
        db.upsertRelation({
          from: uid,
          to: externalUid,
          kind: "calls",
          confidence: 1,
          provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
        });
      }
    });

    db.clearAstDataForPath(filePath);

    expect(db.getEntitiesByUid(uids)).toEqual([]);
    expect(db.getEntity(externalUid)).toBeDefined();
    expect(db.getRelationsTo(externalUid)).toEqual([]);
    expect(db.searchEntityUids("bulk cleanup target", 10)).toEqual([]);
  });

  it("renames AST graph data across related lookup tables", () => {
    const now = stableNowIso();
    const oldPath = "src/old.ts";
    const newPath = "src/new.ts";
    const oldFileUid = buildUid("file", oldPath);
    const oldFunctionUid = buildUid("function", oldPath, "demo");
    const newFileUid = buildUid("file", newPath);
    const newFunctionUid = buildUid("function", newPath, "demo");
    const externalUid = buildUid("function", "src/external.ts", "caller");

    db.upsertEntity({
      uid: oldFileUid,
      kind: "file",
      name: "old.ts",
      path: oldPath,
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });
    db.upsertEntity({
      uid: oldFunctionUid,
      kind: "function",
      name: "demo",
      path: oldPath,
      description: "rename me",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });
    db.upsertEntity({
      uid: externalUid,
      kind: "function",
      name: "caller",
      path: "src/external.ts",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });
    db.upsertRelation({
      from: oldFileUid,
      to: oldFunctionUid,
      kind: "contains",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
    });
    db.upsertRelation({
      from: externalUid,
      to: oldFunctionUid,
      kind: "calls",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
    });
    db.upsertUnresolvedReference(
      {
        path: oldPath,
        fromUid: oldFunctionUid,
        symbol: "MissingType",
        kind: "type",
        confidence: 0.5
      },
      now
    );
    db.setEmbedding(oldFunctionUid, "semantic-hash", [0.1, 0.2], "mock", now);
    db.markFileHash(oldPath, "file-hash", now);

    expect(db.renameAstDataPath(oldPath, newPath, now)).toBe(true);

    expect(db.getEntity(oldFileUid)).toBeUndefined();
    expect(db.getEntity(oldFunctionUid)).toBeUndefined();
    expect(db.getEntity(newFileUid)).toBeDefined();
    expect(db.getEntity(newFunctionUid)?.path).toBe(newPath);
    expect(db.getRelationsFrom(newFileUid).some((relation) => relation.to === newFunctionUid)).toBe(true);
    expect(db.getRelationsFrom(externalUid).some((relation) => relation.to === newFunctionUid)).toBe(true);
    expect(db.getUnresolvedReferences()).toContainEqual(
      expect.objectContaining({ path: newPath, fromUid: newFunctionUid, symbol: "MissingType" })
    );
    expect(db.getEmbedding(newFunctionUid)).toMatchObject({ hash: "semantic-hash", provider: "mock" });
    expect(db.getEmbedding(oldFunctionUid)).toBeUndefined();
    expect(db.getFileHash(oldPath)).toBeUndefined();
    expect(db.getFileHash(newPath)).toBe("file-hash");
    expect(db.searchEntityUids("rename me", 10)).toContain(newFunctionUid);
  });
});
