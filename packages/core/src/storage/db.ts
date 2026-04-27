import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  Entity,
  Provenance,
  Relation,
  RelationKind,
  UnresolvedReference
} from "../graph/types.js";
import { mergeProvenance, topSourcePriority } from "../graph/provenance.js";
import { ensureDir } from "../util/fs.js";

function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function fromJson<T>(value: string | null): T {
  return value ? (JSON.parse(value) as T) : (null as T);
}

export type GraphSnapshot = {
  entities: Entity[];
  relations: Relation[];
  unresolvedReferences: UnresolvedReference[];
};

export class DSPDatabase {
  readonly dbPath: string;
  private readonly db: Database.Database;

  constructor(rootDir: string) {
    this.dbPath = path.join(rootDir, ".dsp", "dsp.sqlite");
    ensureDir(path.dirname(this.dbPath));
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initialize();
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
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

      CREATE TABLE IF NOT EXISTS relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_uid TEXT NOT NULL,
        to_uid TEXT NOT NULL,
        kind TEXT NOT NULL,
        reason TEXT,
        weight REAL,
        confidence REAL NOT NULL,
        provenance_json TEXT NOT NULL,
        metadata_json TEXT,
        source_priority INTEGER NOT NULL,
        UNIQUE(from_uid, to_uid, kind)
      );

      CREATE TABLE IF NOT EXISTS file_hashes (
        path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS index_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        files_indexed INTEGER DEFAULT 0,
        files_skipped INTEGER DEFAULT 0,
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS annotations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT,
        path TEXT,
        note TEXT NOT NULL,
        metadata_json TEXT,
        confidence REAL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS embeddings (
        uid TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        vector_json TEXT NOT NULL,
        provider TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS unresolved_references (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        from_uid TEXT,
        symbol TEXT NOT NULL,
        kind TEXT NOT NULL,
        reason TEXT,
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_entities_path ON entities(path);
      CREATE INDEX IF NOT EXISTS idx_entities_kind_path ON entities(kind, path);
      CREATE INDEX IF NOT EXISTS idx_relations_from_uid ON relations(from_uid);
      CREATE INDEX IF NOT EXISTS idx_relations_to_uid ON relations(to_uid);
      CREATE INDEX IF NOT EXISTS idx_relations_kind ON relations(kind);
      CREATE INDEX IF NOT EXISTS idx_unresolved_references_path ON unresolved_references(path);
    `);
  }

  close(): void {
    this.db.close();
  }

  beginRun(mode: string, startedAt: string): number {
    const stmt = this.db.prepare(
      "INSERT INTO index_runs(started_at, mode, status, metadata_json) VALUES (?, ?, 'running', ?)"
    );
    const res = stmt.run(startedAt, mode, "{}");
    return Number(res.lastInsertRowid);
  }

  finishRun(runId: number, status: "ok" | "failed", endedAt: string, meta: unknown): void {
    this.db
      .prepare(
        "UPDATE index_runs SET status = ?, ended_at = ?, metadata_json = ? WHERE id = ?"
      )
      .run(status, endedAt, toJson(meta), runId);
  }

  private rowToEntity(row: Record<string, unknown>): Entity {
    return {
      uid: String(row.uid),
      kind: row.kind as Entity["kind"],
      name: String(row.name),
      path: row.path ? String(row.path) : undefined,
      language: row.language ? String(row.language) : undefined,
      signature: row.signature ? String(row.signature) : undefined,
      startLine: row.start_line ? Number(row.start_line) : undefined,
      endLine: row.end_line ? Number(row.end_line) : undefined,
      description: row.description ? String(row.description) : undefined,
      docstring: row.docstring ? String(row.docstring) : undefined,
      tags: fromJson<string[]>(row.tags_json ? String(row.tags_json) : "[]"),
      metadata: fromJson<Record<string, unknown>>(
        row.metadata_json ? String(row.metadata_json) : "{}"
      ),
      provenance: fromJson<Provenance[]>(String(row.provenance_json)),
      confidence: Number(row.confidence),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private rowToRelation(row: Record<string, unknown>): Relation {
    return {
      from: String(row.from_uid),
      to: String(row.to_uid),
      kind: row.kind as RelationKind,
      reason: row.reason ? String(row.reason) : undefined,
      weight: row.weight !== null && row.weight !== undefined ? Number(row.weight) : undefined,
      confidence: Number(row.confidence),
      provenance: fromJson<Provenance[]>(String(row.provenance_json)),
      metadata: fromJson<Record<string, unknown>>(
        row.metadata_json ? String(row.metadata_json) : "{}"
      )
    };
  }

  getEntity(uid: string): Entity | undefined {
    const row = this.db.prepare("SELECT * FROM entities WHERE uid = ?").get(uid) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToEntity(row) : undefined;
  }

  getEntities(limit = 10000): Entity[] {
    const rows = this.db.prepare("SELECT * FROM entities ORDER BY uid LIMIT ?").all(limit) as Record<
      string,
      unknown
    >[];
    return rows.map((row) => this.rowToEntity(row));
  }

  getRelations(limit = 50000): Relation[] {
    const rows = this.db
      .prepare("SELECT * FROM relations ORDER BY from_uid, to_uid, kind LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRelation(row));
  }

  getRelationsFrom(uid: string): Relation[] {
    const rows = this.db
      .prepare("SELECT * FROM relations WHERE from_uid = ? ORDER BY to_uid")
      .all(uid) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRelation(row));
  }

  getRelationsTo(uid: string): Relation[] {
    const rows = this.db
      .prepare("SELECT * FROM relations WHERE to_uid = ? ORDER BY from_uid")
      .all(uid) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRelation(row));
  }

  upsertEntity(entity: Entity): void {
    const existing = this.getEntity(entity.uid);
    const mergedProvenance = mergeProvenance(existing?.provenance ?? [], entity.provenance);
    const newPriority = topSourcePriority(entity.provenance);
    const oldPriority = existing ? topSourcePriority(existing.provenance) : -1;
    const shouldOverwrite = !existing || newPriority >= oldPriority;
    const mergedEntity: Entity = shouldOverwrite
      ? {
          ...entity,
          provenance: mergedProvenance,
          createdAt: existing?.createdAt ?? entity.createdAt
        }
      : {
          ...existing,
          provenance: mergedProvenance,
          updatedAt: entity.updatedAt
        };
    this.db
      .prepare(
        `
      INSERT INTO entities (
        uid, kind, name, path, language, signature, start_line, end_line,
        description, docstring, tags_json, metadata_json, confidence, provenance_json,
        source_priority, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uid) DO UPDATE SET
        kind = excluded.kind,
        name = excluded.name,
        path = excluded.path,
        language = excluded.language,
        signature = excluded.signature,
        start_line = excluded.start_line,
        end_line = excluded.end_line,
        description = excluded.description,
        docstring = excluded.docstring,
        tags_json = excluded.tags_json,
        metadata_json = excluded.metadata_json,
        confidence = excluded.confidence,
        provenance_json = excluded.provenance_json,
        source_priority = excluded.source_priority,
        updated_at = excluded.updated_at
      `
      )
      .run(
        mergedEntity.uid,
        mergedEntity.kind,
        mergedEntity.name,
        mergedEntity.path ?? null,
        mergedEntity.language ?? null,
        mergedEntity.signature ?? null,
        mergedEntity.startLine ?? null,
        mergedEntity.endLine ?? null,
        mergedEntity.description ?? null,
        mergedEntity.docstring ?? null,
        toJson(mergedEntity.tags ?? []),
        toJson(mergedEntity.metadata ?? {}),
        mergedEntity.confidence,
        toJson(mergedEntity.provenance),
        topSourcePriority(mergedEntity.provenance),
        mergedEntity.createdAt,
        mergedEntity.updatedAt
      );
  }

  upsertRelation(relation: Relation): void {
    const existingRow = this.db
      .prepare("SELECT * FROM relations WHERE from_uid = ? AND to_uid = ? AND kind = ?")
      .get(relation.from, relation.to, relation.kind) as Record<string, unknown> | undefined;

    const existing = existingRow ? this.rowToRelation(existingRow) : undefined;
    const mergedProvenance = mergeProvenance(existing?.provenance ?? [], relation.provenance);
    const newPriority = topSourcePriority(relation.provenance);
    const oldPriority = existing ? topSourcePriority(existing.provenance) : -1;
    const shouldOverwrite = !existing || newPriority >= oldPriority;
    const finalRelation = shouldOverwrite
      ? { ...relation, provenance: mergedProvenance }
      : { ...existing, provenance: mergedProvenance };

    this.db
      .prepare(
        `
      INSERT INTO relations (
        from_uid, to_uid, kind, reason, weight, confidence, provenance_json, metadata_json, source_priority
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(from_uid, to_uid, kind) DO UPDATE SET
        reason = excluded.reason,
        weight = excluded.weight,
        confidence = excluded.confidence,
        provenance_json = excluded.provenance_json,
        metadata_json = excluded.metadata_json,
        source_priority = excluded.source_priority
      `
      )
      .run(
        finalRelation.from,
        finalRelation.to,
        finalRelation.kind,
        finalRelation.reason ?? null,
        finalRelation.weight ?? null,
        finalRelation.confidence,
        toJson(finalRelation.provenance),
        toJson(finalRelation.metadata ?? {}),
        topSourcePriority(finalRelation.provenance)
      );
  }

  markFileHash(filePath: string, hash: string, indexedAt: string): void {
    this.db
      .prepare(
        `
      INSERT INTO file_hashes(path, content_hash, indexed_at)
      VALUES (?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET content_hash = excluded.content_hash, indexed_at = excluded.indexed_at
      `
      )
      .run(filePath, hash, indexedAt);
  }

  getFileHash(filePath: string): string | undefined {
    const row = this.db
      .prepare("SELECT content_hash FROM file_hashes WHERE path = ?")
      .get(filePath) as { content_hash: string } | undefined;
    return row?.content_hash;
  }

  removeFileHash(filePath: string): void {
    this.db.prepare("DELETE FROM file_hashes WHERE path = ?").run(filePath);
  }

  clearUnresolvedForPath(filePath: string): void {
    this.db.prepare("DELETE FROM unresolved_references WHERE path = ?").run(filePath);
  }

  upsertUnresolvedReference(ref: UnresolvedReference, createdAt: string): void {
    this.db
      .prepare(
        `
      INSERT INTO unresolved_references(path, from_uid, symbol, kind, reason, confidence, created_at, resolved)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `
      )
      .run(
        ref.path,
        ref.fromUid ?? null,
        ref.symbol,
        ref.kind,
        ref.reason ?? null,
        ref.confidence,
        createdAt
      );
  }

  getUnresolvedReferences(): UnresolvedReference[] {
    const rows = this.db
      .prepare(
        "SELECT path, from_uid, symbol, kind, reason, confidence FROM unresolved_references WHERE resolved = 0"
      )
      .all() as {
      path: string;
      from_uid: string | null;
      symbol: string;
      kind: UnresolvedReference["kind"];
      reason: string | null;
      confidence: number;
    }[];
    return rows.map((row) => ({
      path: row.path,
      fromUid: row.from_uid ?? undefined,
      symbol: row.symbol,
      kind: row.kind,
      reason: row.reason ?? undefined,
      confidence: row.confidence
    }));
  }

  clearAstDataForPath(filePath: string): void {
    const fileEntities = this.db
      .prepare("SELECT uid FROM entities WHERE path = ? AND source_priority < 100")
      .all(filePath) as { uid: string }[];
    const uids = fileEntities.map((row) => row.uid);
    if (uids.length === 0) {
      this.clearUnresolvedForPath(filePath);
      return;
    }
    const placeholders = uids.map(() => "?").join(", ");
    this.db.prepare(`DELETE FROM relations WHERE from_uid IN (${placeholders}) OR to_uid IN (${placeholders})`).run(
      ...uids,
      ...uids
    );
    this.db.prepare(`DELETE FROM entities WHERE uid IN (${placeholders})`).run(...uids);
    this.clearUnresolvedForPath(filePath);
  }

  listFilesInHashTable(): string[] {
    const rows = this.db.prepare("SELECT path FROM file_hashes ORDER BY path").all() as { path: string }[];
    return rows.map((r) => r.path);
  }

  getSnapshot(): GraphSnapshot {
    return {
      entities: this.getEntities(200000),
      relations: this.getRelations(500000),
      unresolvedReferences: this.getUnresolvedReferences()
    };
  }

  exportJson(targetPath: string): void {
    const snapshot = this.getSnapshot();
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }

  importJson(sourcePath: string): GraphSnapshot {
    const raw = fs.readFileSync(sourcePath, "utf8");
    const snapshot = JSON.parse(raw) as GraphSnapshot;
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      for (const entity of snapshot.entities) {
        this.upsertEntity({
          ...entity,
          createdAt: entity.createdAt ?? now,
          updatedAt: now
        });
      }
      for (const relation of snapshot.relations) {
        this.upsertRelation(relation);
      }
      for (const unresolved of snapshot.unresolvedReferences ?? []) {
        this.upsertUnresolvedReference(unresolved, now);
      }
    });
    tx();
    return snapshot;
  }

  exportDsp(targetDir: string): void {
    const dspDir = path.join(targetDir, ".dsp", "export");
    fs.mkdirSync(dspDir, { recursive: true });
    const entities = this.getEntities(200000);
    const relations = this.getRelations(500000);
    const unresolved = this.getUnresolvedReferences();
    const entitiesText = entities
      .sort((a, b) => a.uid.localeCompare(b.uid))
      .map((entity) => {
        return [
          `${entity.uid} [${entity.kind}]`,
          `name=${entity.name}`,
          `path=${entity.path ?? ""}`,
          `language=${entity.language ?? ""}`,
          `confidence=${entity.confidence.toFixed(2)}`
        ].join(" | ");
      })
      .join("\n");
    const relationsText = relations
      .sort((a, b) =>
        `${a.from}:${a.kind}:${a.to}`.localeCompare(`${b.from}:${b.kind}:${b.to}`)
      )
      .map((rel) => {
        return `${rel.from} --${rel.kind}--> ${rel.to} | confidence=${rel.confidence.toFixed(2)} | reason=${rel.reason ?? ""}`;
      })
      .join("\n");
    const unresolvedText = unresolved
      .sort((a, b) => `${a.path}:${a.symbol}`.localeCompare(`${b.path}:${b.symbol}`))
      .map((ref) => `${ref.path} :: ${ref.kind} :: ${ref.symbol} :: confidence=${ref.confidence.toFixed(2)}`)
      .join("\n");
    fs.writeFileSync(path.join(dspDir, "entities.txt"), `${entitiesText}\n`, "utf8");
    fs.writeFileSync(path.join(dspDir, "relations.txt"), `${relationsText}\n`, "utf8");
    fs.writeFileSync(path.join(dspDir, "unresolved.txt"), `${unresolvedText}\n`, "utf8");
    fs.writeFileSync(
      path.join(dspDir, "summary.json"),
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          entities: entities.length,
          relations: relations.length,
          unresolved: unresolved.length
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }

  setEmbedding(uid: string, hash: string, vector: number[], provider: string, updatedAt: string): void {
    this.db
      .prepare(
        `
      INSERT INTO embeddings(uid, content_hash, vector_json, provider, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(uid) DO UPDATE SET
        content_hash = excluded.content_hash,
        vector_json = excluded.vector_json,
        provider = excluded.provider,
        updated_at = excluded.updated_at
      `
      )
      .run(uid, hash, toJson(vector), provider, updatedAt);
  }

  getEmbedding(uid: string): { hash: string; vector: number[]; provider: string } | undefined {
    const row = this.db
      .prepare("SELECT content_hash, vector_json, provider FROM embeddings WHERE uid = ?")
      .get(uid) as { content_hash: string; vector_json: string; provider: string } | undefined;
    if (!row) {
      return undefined;
    }
    return { hash: row.content_hash, vector: fromJson<number[]>(row.vector_json), provider: row.provider };
  }

  cacheStats(): {
    fileHashes: number;
    embeddings: number;
    unresolvedReferences: number;
  } {
    const fileHashes = (this.db.prepare("SELECT COUNT(*) as count FROM file_hashes").get() as { count: number })
      .count;
    const embeddings = (this.db.prepare("SELECT COUNT(*) as count FROM embeddings").get() as { count: number })
      .count;
    const unresolvedReferences = (
      this.db.prepare("SELECT COUNT(*) as count FROM unresolved_references WHERE resolved = 0").get() as {
        count: number;
      }
    ).count;
    return { fileHashes, embeddings, unresolvedReferences };
  }

  clearCache(): void {
    this.db.exec(`
      DELETE FROM embeddings;
      DELETE FROM file_hashes;
    `);
  }
}
