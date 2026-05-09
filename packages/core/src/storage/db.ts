import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type {
  Entity,
  Provenance,
  Relation,
  RelationKind,
  UnresolvedReference
} from "../graph/types.ts";
import { buildUid } from "../graph/uid.ts";
import { mergeProvenance, topSourcePriority } from "../graph/provenance.ts";
import { ensureDir } from "../util/fs.ts";

const SCHEMA_VERSION = 5;
const SQLITE_LIST_CHUNK_SIZE = 400;
const SQLITE_CACHE_SIZE_KB = 32 * 1024;
const SQLITE_MMAP_SIZE_BYTES = 256 * 1024 * 1024;
const SQLITE_BUSY_TIMEOUT_MS = 5000;
const SQLITE_BUSY_RETRIES = 4;
const PARSE_CACHE_MAX_ROWS = 20000;
const PARSE_CACHE_MAX_AGE_DAYS = 30;
const SQLITE_VACUUM_FREELIST_THRESHOLD = 2000;
const EMBEDDING_BUCKET_BITS = 8;

function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function fromJson<T>(value: string | null): T {
  return value ? (JSON.parse(value) as T) : (null as T);
}

function embeddingBucketKey(vector: number[]): string {
  const bits: string[] = [];
  for (let index = 0; index < EMBEDDING_BUCKET_BITS; index += 1) {
    bits.push((vector[index] ?? 0) >= 0 ? "1" : "0");
  }
  return bits.join("");
}

function embeddingBucketNeighbors(bucketKey: string): string[] {
  const neighbors = [bucketKey];
  for (let index = 0; index < bucketKey.length; index += 1) {
    const flipped = bucketKey.slice(0, index) + (bucketKey[index] === "1" ? "0" : "1") + bucketKey.slice(index + 1);
    neighbors.push(flipped);
  }
  return neighbors;
}

function protocolUidForEntity(entity: Entity): string {
  if (/^(?:obj|func)-[0-9a-fA-F]{8}$/.test(entity.uid)) {
    return entity.uid;
  }
  const prefix = ["function", "method", "route", "test"].includes(entity.kind) ? "func" : "obj";
  const hash = createHash("sha1").update(entity.uid).digest("hex").slice(0, 8);
  return `${prefix}-${hash}`;
}

function protocolKind(entity: Entity): "object" | "function" | "external" {
  if (entity.metadata?.external) {
    return "external";
  }
  return ["function", "method", "route", "test"].includes(entity.kind) ? "function" : "object";
}

function writeProtocolDescription(target: string, entity: Entity, protocolUid: string): void {
  const purpose = entity.description ?? entity.docstring ?? entity.signature ?? `${entity.kind} ${entity.name}`;
  const lines = [
    `source: ${entity.path ?? entity.uid}${entity.uid.includes("#") ? `#${entity.uid.split("#").at(-1)}` : ""}`,
    `kind: ${protocolKind(entity)}`,
    `purpose: ${purpose}`,
    `dsp_uid: ${entity.uid}`,
    `protocol_uid: ${protocolUid}`,
    `confidence: ${entity.confidence.toFixed(2)}`
  ];
  if (entity.language) {
    lines.push(`language: ${entity.language}`);
  }
  fs.writeFileSync(target, `${lines.join("\n")}\n`, "utf8");
}

function searchableText(value: string | undefined): string {
  return (value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase();
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index]! * b[index]!;
    normA += a[index]! * a[index]!;
    normB += b[index]! * b[index]!;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / Math.sqrt(normA * normB);
}

function chunks<T>(items: T[], chunkSize = SQLITE_LIST_CHUNK_SIZE): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    result.push(items.slice(index, index + chunkSize));
  }
  return result;
}

function rewritePathBasedUid(uid: string, oldPath: string, newPath: string): string {
  const separatorIndex = uid.indexOf(":");
  if (separatorIndex === -1) {
    return uid;
  }
  const prefix = uid.slice(0, separatorIndex);
  const suffix = uid.slice(separatorIndex + 1);
  if (suffix === oldPath || suffix.startsWith(`${oldPath}#`)) {
    return `${prefix}:${newPath}${suffix.slice(oldPath.length)}`;
  }
  return uid;
}

export type GraphSnapshot = {
  entities: Entity[];
  relations: Relation[];
  unresolvedReferences: UnresolvedReference[];
};

export type EmbeddingStats = {
  total: number;
  byProvider: Record<string, number>;
};

export type StoredEmbedding = {
  uid: string;
  hash: string;
  vector: number[];
  provider: string;
};

export type RankedEmbedding = StoredEmbedding & {
  score: number;
};

export type FileHashEntry = {
  hash: string;
  indexedAt: string;
  mtimeMs?: number;
  sizeBytes?: number;
};

export type IndexedAstFile = {
  relPath: string;
  language: string;
  hash: string;
  indexedAt: string;
  mtimeMs: number;
  sizeBytes: number;
  entities: Entity[];
  relations: Relation[];
  unresolved: UnresolvedReference[];
};

export type StoredCheckpoint = {
  id: number;
  name: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type DatabaseDoctorReport = {
  schema: {
    currentVersion: number;
    expectedVersion: number;
    upToDate: boolean;
  };
  integrity: {
    ok: boolean;
    rows: string[];
  };
  orphanedFileHashes: string[];
  orphanedEmbeddings: string[];
  danglingUnresolvedPaths: string[];
  runningIndexRuns: number;
  checkpoints: number;
  parseCache: {
    entries: number;
    stalePaths: string[];
  };
  maintenance: {
    freelistPages: number;
  };
};

export type CachedParseResult = {
  entities: Entity[];
  relations: Relation[];
  unresolvedReferences: UnresolvedReference[];
};

export type EntitySearchCandidates = {
  uids: string[];
  candidatesScanned: number;
};

export class DSPDatabase {
  readonly dbPath: string;
  private readonly db: Database.Database;
  private readonly readDb: Database.Database;
  private readonly statementCache = new Map<string, Database.Statement>();
  private readonly readStatementCache = new Map<string, Database.Statement>();

  constructor(rootDir: string) {
    this.dbPath = path.join(rootDir, ".dsp", "dsp.sqlite");
    ensureDir(path.dirname(this.dbPath));
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("temp_store = MEMORY");
    this.db.pragma(`cache_size = -${SQLITE_CACHE_SIZE_KB}`);
    this.db.pragma(`mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    this.initialize();
    this.readDb = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    this.readDb.pragma("query_only = ON");
    this.readDb.pragma("foreign_keys = ON");
    this.readDb.pragma("temp_store = MEMORY");
    this.readDb.pragma(`cache_size = -${SQLITE_CACHE_SIZE_KB}`);
    this.readDb.pragma(`mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
    this.readDb.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

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

      CREATE TABLE IF NOT EXISTS embedding_buckets (
        provider TEXT NOT NULL,
        bucket_key TEXT NOT NULL,
        uid TEXT NOT NULL,
        PRIMARY KEY(provider, bucket_key, uid)
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

      CREATE TABLE IF NOT EXISTS parse_cache (
        language TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(language, file_path, content_hash)
      );

      CREATE TABLE IF NOT EXISTS file_dependencies (
        from_path TEXT NOT NULL,
        to_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        confidence REAL NOT NULL,
        PRIMARY KEY(from_path, to_path, kind)
      );

      CREATE TABLE IF NOT EXISTS symbol_dependencies (
        from_uid TEXT NOT NULL,
        to_uid TEXT NOT NULL,
        kind TEXT NOT NULL,
        confidence REAL NOT NULL,
        PRIMARY KEY(from_uid, to_uid, kind)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS entity_fts
      USING fts5(uid UNINDEXED, name, path, description, docstring, tags);

      CREATE INDEX IF NOT EXISTS idx_entities_path ON entities(path);
      CREATE INDEX IF NOT EXISTS idx_entities_kind_path ON entities(kind, path);
      CREATE INDEX IF NOT EXISTS idx_entities_language_kind_path ON entities(language, kind, path);
      CREATE INDEX IF NOT EXISTS idx_entities_path_kind ON entities(path, kind);
      CREATE INDEX IF NOT EXISTS idx_relations_from_uid ON relations(from_uid);
      CREATE INDEX IF NOT EXISTS idx_relations_to_uid ON relations(to_uid);
      CREATE INDEX IF NOT EXISTS idx_relations_kind ON relations(kind);
      CREATE INDEX IF NOT EXISTS idx_relations_kind_from_uid ON relations(kind, from_uid);
      CREATE INDEX IF NOT EXISTS idx_relations_kind_to_uid ON relations(kind, to_uid);
      CREATE INDEX IF NOT EXISTS idx_file_dependencies_to_path ON file_dependencies(to_path);
      CREATE INDEX IF NOT EXISTS idx_file_dependencies_from_path ON file_dependencies(from_path);
      CREATE INDEX IF NOT EXISTS idx_symbol_dependencies_to_uid ON symbol_dependencies(to_uid);
      CREATE INDEX IF NOT EXISTS idx_symbol_dependencies_from_uid ON symbol_dependencies(from_uid);
      CREATE INDEX IF NOT EXISTS idx_unresolved_references_path ON unresolved_references(path);
      CREATE INDEX IF NOT EXISTS idx_embedding_buckets_uid ON embedding_buckets(uid);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_checkpoints_name ON checkpoints(name);
    `);
    this.migrate();
  }

  private schemaVersion(): number {
    const row = this.db
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  private setSchemaVersion(version: number): void {
    this.prepareCached(
      "set-schema-version",
      `
      INSERT INTO schema_meta(key, value)
      VALUES ('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `
    )
      .run(String(version));
  }

  private prepareCached(key: string, sql: string): Database.Statement {
    const existing = this.statementCache.get(key);
    if (existing) {
      return existing;
    }
    const statement = this.db.prepare(sql);
    this.statementCache.set(key, statement);
    return statement;
  }

  private prepareReadCached(key: string, sql: string): Database.Statement {
    const existing = this.readStatementCache.get(key);
    if (existing) {
      return existing;
    }
    const statement = this.readDb.prepare(sql);
    this.readStatementCache.set(key, statement);
    return statement;
  }

  private withBusyRetry<T>(fn: () => T): T {
    let attempt = 0;
    while (true) {
      try {
        return fn();
      } catch (error) {
        const code = (error as { code?: string } | undefined)?.code;
        if (code !== "SQLITE_BUSY" || attempt >= SQLITE_BUSY_RETRIES) {
          throw error;
        }
        attempt += 1;
        const waitState = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(waitState, 0, 0, 10 * attempt);
      }
    }
  }

  private migrate(): void {
    const current = this.schemaVersion();
    if (current < 2) {
      this.rebuildEntityFts();
    }
    if (current < 3) {
      this.ensureFileHashColumn("mtime_ms", "INTEGER");
      this.ensureFileHashColumn("size_bytes", "INTEGER");
    }
    if (current < 4) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS file_dependencies (
          from_path TEXT NOT NULL,
          to_path TEXT NOT NULL,
          kind TEXT NOT NULL,
          confidence REAL NOT NULL,
          PRIMARY KEY(from_path, to_path, kind)
        );
        CREATE TABLE IF NOT EXISTS symbol_dependencies (
          from_uid TEXT NOT NULL,
          to_uid TEXT NOT NULL,
          kind TEXT NOT NULL,
          confidence REAL NOT NULL,
          PRIMARY KEY(from_uid, to_uid, kind)
        );
        CREATE INDEX IF NOT EXISTS idx_file_dependencies_to_path ON file_dependencies(to_path);
        CREATE INDEX IF NOT EXISTS idx_file_dependencies_from_path ON file_dependencies(from_path);
        CREATE INDEX IF NOT EXISTS idx_symbol_dependencies_to_uid ON symbol_dependencies(to_uid);
        CREATE INDEX IF NOT EXISTS idx_symbol_dependencies_from_uid ON symbol_dependencies(from_uid);
      `);
    }
    if (current < 5) {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_entities_language_kind_path ON entities(language, kind, path);
        CREATE INDEX IF NOT EXISTS idx_entities_path_kind ON entities(path, kind);
        CREATE INDEX IF NOT EXISTS idx_relations_kind_from_uid ON relations(kind, from_uid);
        CREATE INDEX IF NOT EXISTS idx_relations_kind_to_uid ON relations(kind, to_uid);
      `);
    }
    if (current < SCHEMA_VERSION) {
      this.setSchemaVersion(SCHEMA_VERSION);
    }
  }

  currentSchemaVersion(): number {
    return this.schemaVersion();
  }

  expectedSchemaVersion(): number {
    return SCHEMA_VERSION;
  }

  private ensureFileHashColumn(column: string, definition: string): void {
    const columns = this.db.prepare("PRAGMA table_info(file_hashes)").all() as { name: string }[];
    if (columns.some((entry) => entry.name === column)) {
      return;
    }
    this.db.exec(`ALTER TABLE file_hashes ADD COLUMN ${column} ${definition}`);
  }

  close(): void {
    if ((this.db as Database.Database & { open?: boolean }).open === false) {
      return;
    }
    this.optimize();
    if ((this.readDb as Database.Database & { open?: boolean }).open !== false) {
      this.readDb.close();
    }
    this.db.close();
  }

  optimize(): void {
    if ((this.db as Database.Database & { open?: boolean }).open === false) {
      return;
    }
    this.db.pragma("optimize");
  }

  maintainCaches(options: { maxEntries?: number; maxAgeDays?: number; vacuumFreelistThreshold?: number } = {}): void {
    const maxEntries = Math.max(0, options.maxEntries ?? PARSE_CACHE_MAX_ROWS);
    const maxAgeDays = Math.max(0, options.maxAgeDays ?? PARSE_CACHE_MAX_AGE_DAYS);
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    this.withBusyRetry(() => {
      if (maxAgeDays > 0) {
        this.prepareCached("prune-parse-cache-by-age", "DELETE FROM parse_cache WHERE updated_at < ?").run(cutoff);
      }
      const row = this.prepareCached("count-parse-cache", "SELECT COUNT(*) AS count FROM parse_cache").get() as {
        count: number;
      };
      if (maxEntries > 0 && row.count > maxEntries) {
        this.db
          .prepare(
            `
            DELETE FROM parse_cache
            WHERE rowid IN (
              SELECT rowid
              FROM parse_cache
              ORDER BY updated_at ASC
              LIMIT ?
            )
            `
          )
          .run(row.count - maxEntries);
      }
      this.db.pragma("wal_checkpoint(PASSIVE)");
      this.optimize();
      const freelistPages = (
        this.db.prepare("PRAGMA freelist_count").get() as { freelist_count?: number; count?: number } | undefined
      )?.freelist_count ?? 0;
      if (freelistPages >= (options.vacuumFreelistThreshold ?? SQLITE_VACUUM_FREELIST_THRESHOLD)) {
        this.db.exec("VACUUM");
      }
    });
  }

  transaction<T>(fn: () => T): T {
    return this.withBusyRetry(() => this.db.transaction(fn)());
  }

  beginRun(mode: string, startedAt: string): number {
    const stmt = this.prepareCached(
      "begin-run",
      "INSERT INTO index_runs(started_at, mode, status, metadata_json) VALUES (?, ?, 'running', ?)"
    );
    const res = this.withBusyRetry(() => stmt.run(startedAt, mode, "{}"));
    return Number(res.lastInsertRowid);
  }

  finishRun(runId: number, status: "ok" | "failed", endedAt: string, meta: unknown): void {
    this.withBusyRetry(() =>
      this.prepareCached(
      "finish-run",
      "UPDATE index_runs SET status = ?, ended_at = ?, metadata_json = ? WHERE id = ?"
    )
        .run(status, endedAt, toJson(meta), runId)
    );
  }

  updateRunProgress(runId: number, filesIndexed: number, filesSkipped: number, meta: unknown): void {
    this.withBusyRetry(() =>
      this.prepareCached(
      "update-run-progress",
      "UPDATE index_runs SET files_indexed = ?, files_skipped = ?, metadata_json = ? WHERE id = ?"
    )
        .run(filesIndexed, filesSkipped, toJson(meta), runId)
    );
  }

  saveCheckpoint(name: string, createdAt: string, metadata: Record<string, unknown>): void {
    this.withBusyRetry(() =>
      this.prepareCached(
      "save-checkpoint",
      `
      INSERT INTO checkpoints(name, metadata_json, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        metadata_json = excluded.metadata_json,
        created_at = excluded.created_at
      `
    )
        .run(name, toJson(metadata), createdAt)
    );
  }

  getCheckpoint(name: string): StoredCheckpoint | undefined {
    const row = this.prepareReadCached(
      "get-checkpoint",
      "SELECT id, name, metadata_json, created_at FROM checkpoints WHERE name = ?"
    )
      .get(name) as { id: number; name: string; metadata_json: string | null; created_at: string } | undefined;
    if (!row) {
      return undefined;
    }
    return {
      id: row.id,
      name: row.name,
      metadata: fromJson<Record<string, unknown>>(row.metadata_json ?? "{}") ?? {},
      createdAt: row.created_at
    };
  }

  clearCheckpoint(name: string): void {
    this.withBusyRetry(() => this.prepareCached("clear-checkpoint", "DELETE FROM checkpoints WHERE name = ?").run(name));
  }

  integrityCheck(): { ok: boolean; rows: string[] } {
    const rows = this.readDb.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
    const values = rows.map((row) => row.integrity_check);
    return {
      ok: values.length === 1 && values[0] === "ok",
      rows: values
    };
  }

  doctor(limit = 100): DatabaseDoctorReport {
    const integrity = this.integrityCheck();
    const orphanedFileHashes = this.readDb
      .prepare(
        `
        SELECT file_hashes.path
        FROM file_hashes
        LEFT JOIN entities ON entities.uid = ('file:' || file_hashes.path)
        WHERE entities.uid IS NULL
        ORDER BY file_hashes.path
        LIMIT ?
        `
      )
      .all(limit) as { path: string }[];
    const orphanedEmbeddings = this.readDb
      .prepare(
        `
        SELECT embeddings.uid
        FROM embeddings
        LEFT JOIN entities ON entities.uid = embeddings.uid
        WHERE entities.uid IS NULL
        ORDER BY embeddings.uid
        LIMIT ?
        `
      )
      .all(limit) as { uid: string }[];
    const danglingUnresolvedPaths = this.readDb
      .prepare(
        `
        SELECT DISTINCT unresolved_references.path
        FROM unresolved_references
        LEFT JOIN entities ON entities.uid = ('file:' || unresolved_references.path)
        WHERE unresolved_references.resolved = 0
          AND entities.uid IS NULL
        ORDER BY unresolved_references.path
        LIMIT ?
        `
      )
      .all(limit) as { path: string }[];
    const runningIndexRuns = (
      this.readDb.prepare("SELECT COUNT(*) AS count FROM index_runs WHERE status = 'running'").get() as {
        count: number;
      }
    ).count;
    const checkpoints = (
      this.readDb.prepare("SELECT COUNT(*) AS count FROM checkpoints").get() as {
        count: number;
      }
    ).count;
    const parseCacheEntries = (
      this.readDb.prepare("SELECT COUNT(*) AS count FROM parse_cache").get() as {
        count: number;
      }
    ).count;
    const staleParseCachePaths = this.readDb
      .prepare(
        `
        SELECT DISTINCT parse_cache.file_path
        FROM parse_cache
        LEFT JOIN file_hashes ON file_hashes.path = parse_cache.file_path
        WHERE file_hashes.path IS NULL
        ORDER BY parse_cache.file_path
        LIMIT ?
        `
      )
      .all(limit) as { file_path: string }[];
    const freelistPages = (
      this.readDb.prepare("PRAGMA freelist_count").get() as { freelist_count?: number; count?: number } | undefined
    )?.freelist_count ?? 0;
    return {
      schema: {
        currentVersion,
        expectedVersion,
        upToDate: currentVersion === expectedVersion
      },
      integrity,
      orphanedFileHashes: orphanedFileHashes.map((row) => row.path),
      orphanedEmbeddings: orphanedEmbeddings.map((row) => row.uid),
      danglingUnresolvedPaths: danglingUnresolvedPaths.map((row) => row.path),
      runningIndexRuns,
      checkpoints,
      parseCache: {
        entries: parseCacheEntries,
        stalePaths: staleParseCachePaths.map((row) => row.file_path)
      },
      maintenance: {
        freelistPages
      }
    };
  }

  getCachedParseResult(language: string, filePath: string, hash: string): CachedParseResult | undefined {
    const row = this.readDb
      .prepare(
        `
        SELECT payload_json
        FROM parse_cache
        WHERE language = ? AND file_path = ? AND content_hash = ?
        `
      )
      .get(language, filePath, hash) as { payload_json: string } | undefined;
    if (!row) {
      return undefined;
    }
    return fromJson<CachedParseResult>(row.payload_json);
  }

  setCachedParseResult(language: string, filePath: string, hash: string, payload: CachedParseResult, updatedAt: string): void {
    this.prepareCached(
      "upsert-parse-cache",
      `
      INSERT INTO parse_cache(language, file_path, content_hash, payload_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(language, file_path, content_hash) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
      `
    )
      .run(language, filePath, hash, toJson(payload), updatedAt);
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

  private rowToUnresolvedReference(row: Record<string, unknown>): UnresolvedReference {
    return {
      path: String(row.path),
      fromUid: row.from_uid ? String(row.from_uid) : undefined,
      symbol: String(row.symbol),
      kind: row.kind as UnresolvedReference["kind"],
      reason: row.reason ? String(row.reason) : undefined,
      confidence: Number(row.confidence)
    };
  }

  private syntheticContainsForEntity(entity: Entity): Relation | undefined {
    if (!entity.path || entity.kind === "file" || entity.kind === "directory") {
      return undefined;
    }
    if (topSourcePriority(entity.provenance) >= 100) {
      return undefined;
    }
    return {
      from: buildUid("file", entity.path),
      to: entity.uid,
      kind: "contains",
      confidence: 1,
      provenance: [
        {
          source: "ast",
          tool: "dsp-indexer",
          timestamp: entity.updatedAt,
          confidence: 1,
          evidence: "derived file containment"
        }
      ],
      metadata: {
        synthetic: true
      }
    };
  }

  private syntheticContainsFromFileUid(fileUid: string): Relation[] {
    if (!fileUid.startsWith("file:") || fileUid.includes("#")) {
      return [];
    }
    if (!this.getEntity(fileUid)) {
      return [];
    }
    const filePath = fileUid.slice("file:".length);
    const rows = this.prepareReadCached(
      "synthetic-contains-from-file",
      `
      SELECT *
      FROM entities
      WHERE path = ? AND kind NOT IN ('file', 'directory')
      ORDER BY uid
      `
    )
      .all(filePath) as Record<string, unknown>[];
    return rows
      .map((row) => this.syntheticContainsForEntity(this.rowToEntity(row)))
      .filter((relation): relation is Relation => Boolean(relation));
  }

  private syntheticContainsToUid(uid: string): Relation[] {
    const entity = this.getEntity(uid);
    const relation = entity ? this.syntheticContainsForEntity(entity) : undefined;
    if (relation && !this.getEntity(relation.from)) {
      return [];
    }
    return relation ? [relation] : [];
  }

  private mergeSyntheticRelations(base: Relation[], extras: Relation[]): Relation[] {
    if (extras.length === 0) {
      return base;
    }
    const seen = new Set(base.map((relation) => `${relation.from}\0${relation.to}\0${relation.kind}`));
    const merged = [...base];
    for (const relation of extras) {
      const key = `${relation.from}\0${relation.to}\0${relation.kind}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(relation);
    }
    return merged.sort((a, b) => `${a.from}\0${a.to}\0${a.kind}`.localeCompare(`${b.from}\0${b.to}\0${b.kind}`));
  }

  getEntity(uid: string): Entity | undefined {
    const row = this.prepareReadCached("get-entity", "SELECT * FROM entities WHERE uid = ?").get(uid) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToEntity(row) : undefined;
  }

  getEntities(limit = 10000): Entity[] {
    const rows = this.prepareReadCached("get-entities-limit", "SELECT * FROM entities ORDER BY uid LIMIT ?").all(limit) as Record<
      string,
      unknown
    >[];
    return rows.map((row) => this.rowToEntity(row));
  }

  *iterateEntitiesOrdered(): IterableIterator<Entity> {
    const rows = this.prepareReadCached("iterate-entities", "SELECT * FROM entities ORDER BY uid").iterate() as Iterable<
      Record<string, unknown>
    >;
    for (const row of rows) {
      yield this.rowToEntity(row);
    }
  }

  entityCount(): number {
    return (this.prepareReadCached("entity-count", "SELECT COUNT(*) AS count FROM entities").get() as { count: number }).count;
  }

  entityCountsByKind(): Record<string, number> {
    const rows = this.readDb
      .prepare(
        `
        SELECT kind, COUNT(*) AS count
        FROM entities
        GROUP BY kind
        ORDER BY kind
        `
      )
      .all() as { kind: string; count: number }[];
    return Object.fromEntries(rows.map((row) => [row.kind, row.count]));
  }

  entityCountsByLanguage(): Record<string, number> {
    const rows = this.readDb
      .prepare(
        `
        SELECT language, COUNT(*) AS count
        FROM entities
        WHERE language IS NOT NULL AND language != ''
        GROUP BY language
        ORDER BY language
        `
      )
      .all() as { language: string; count: number }[];
    return Object.fromEntries(rows.map((row) => [row.language, row.count]));
  }

  listEntityUids(): string[] {
    const rows = this.prepareReadCached("list-entity-uids", "SELECT uid FROM entities ORDER BY uid").all() as {
      uid: string;
    }[];
    return rows.map((row) => row.uid);
  }

  findEntitiesByPath(sourcePath: string): Entity[] {
    const normalized = sourcePath.replaceAll("\\", "/").replace(/^\.\//, "");
    const rows = this.readDb
      .prepare(
        `
        SELECT *
        FROM entities
        WHERE path = ? OR path LIKE ?
        ORDER BY uid
        `
      )
      .all(normalized, `%/${normalized}`) as Record<string, unknown>[];
    return rows.map((row) => this.rowToEntity(row));
  }

  getEntitiesByUid(uids: string[]): Entity[] {
    if (uids.length === 0) {
      return [];
    }

    const byUid = new Map<string, Entity>();
    for (const chunk of chunks([...new Set(uids)])) {
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.readDb
        .prepare(`SELECT * FROM entities WHERE uid IN (${placeholders})`)
        .all(...chunk) as Record<string, unknown>[];
      for (const row of rows) {
        byUid.set(String(row.uid), this.rowToEntity(row));
      }
    }

    return uids.map((uid) => byUid.get(uid)).filter((entity): entity is Entity => Boolean(entity));
  }

  searchEntityUids(query: string, limit = 500): string[] {
    return this.searchEntityCandidates(query, limit).uids;
  }

  searchEntityCandidates(query: string, limit = 500): EntitySearchCandidates {
    const tokens = searchableText(query)
      .split(/\s+/)
      .filter(Boolean);
    if (tokens.length === 0) {
      const uids = this.getEntities(limit).map((entity) => entity.uid);
      return { uids, candidatesScanned: uids.length };
    }
    const match = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
    const rows = this.readDb
      .prepare(
        `
        SELECT uid
        FROM entity_fts
        WHERE entity_fts MATCH ?
        ORDER BY bm25(entity_fts)
        LIMIT ?
        `
      )
      .all(match, limit) as { uid: string }[];
    return {
      uids: rows.map((row) => row.uid),
      candidatesScanned: rows.length
    };
  }

  getRelations(limit = 50000): Relation[] {
    return [...this.iterateRelationsOrdered()].slice(0, limit);
  }

  relationCount(): number {
    const persistedCount = (
      this.prepareReadCached("relation-count", "SELECT COUNT(*) AS count FROM relations").get() as { count: number }
    ).count;
    const syntheticCount = (
      this.readDb.prepare(
        `
        SELECT COUNT(*) AS count
        FROM entities
        WHERE path IS NOT NULL AND kind NOT IN ('file', 'directory')
        `
      ).get() as { count: number }
    ).count;
    const duplicateCount = (
      this.readDb.prepare(
        `
        SELECT COUNT(*) AS count
        FROM relations
        JOIN entities ON entities.uid = relations.to_uid
        WHERE relations.kind = 'contains'
          AND entities.path IS NOT NULL
          AND entities.kind NOT IN ('file', 'directory')
          AND relations.from_uid = ('file:' || entities.path)
        `
      ).get() as { count: number }
    ).count;
    return persistedCount + syntheticCount - duplicateCount;
  }

  *iterateRelationsOrdered(): IterableIterator<Relation> {
    const persisted = [
      ...(this.prepareReadCached(
        "iterate-relations",
        "SELECT * FROM relations ORDER BY from_uid, to_uid, kind"
      )
        .iterate() as Iterable<Record<string, unknown>>)
    ].map((row) => this.rowToRelation(row));
    const synthetic = [
      ...(this.readDb.prepare(
        `
        SELECT *
        FROM entities
        WHERE path IS NOT NULL AND kind NOT IN ('file', 'directory')
        ORDER BY path, uid
        `
      ).iterate() as Iterable<Record<string, unknown>>)
    ]
      .map((row) => this.syntheticContainsForEntity(this.rowToEntity(row)))
      .filter((relation): relation is Relation => Boolean(relation));
    for (const relation of this.mergeSyntheticRelations(persisted, synthetic)) {
      yield relation;
    }
  }

  getFileEntities(limit = 300000): Entity[] {
    const rows = this.prepareReadCached(
      "get-file-entities-limit",
      "SELECT * FROM entities WHERE kind = 'file' ORDER BY uid LIMIT ?"
    )
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.rowToEntity(row));
  }

  *iterateFileEntitiesOrdered(): IterableIterator<Entity> {
    const rows = this.prepareReadCached(
      "iterate-file-entities",
      "SELECT * FROM entities WHERE kind = 'file' ORDER BY uid"
    )
      .iterate() as Iterable<Record<string, unknown>>;
    for (const row of rows) {
      yield this.rowToEntity(row);
    }
  }

  getOrphanEntities(limit = 300000): Entity[] {
    const rows = this.prepareReadCached(
      "get-orphan-entities-limit",
      `
      SELECT entities.*
      FROM entities
      LEFT JOIN relations
        ON relations.to_uid = entities.uid
       AND relations.kind != 'contains'
      WHERE entities.kind NOT IN ('repository', 'directory', 'file')
        AND relations.to_uid IS NULL
      ORDER BY entities.uid
      LIMIT ?
      `
    )
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.rowToEntity(row));
  }

  getDanglingRelations(limit = 600000): Relation[] {
    const rows = this.readDb
      .prepare(
        `
        SELECT relations.*
        FROM relations
        LEFT JOIN entities from_entities ON from_entities.uid = relations.from_uid
        LEFT JOIN entities to_entities ON to_entities.uid = relations.to_uid
        WHERE from_entities.uid IS NULL OR to_entities.uid IS NULL
        ORDER BY relations.from_uid, relations.to_uid, relations.kind
        LIMIT ?
        `
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRelation(row));
  }

  getLowConfidenceCriticalRelations(limit = 600000): Relation[] {
    const rows = this.readDb
      .prepare(
        `
        SELECT *
        FROM relations
        WHERE kind IN ('imports', 'depends_on', 'calls') AND confidence < 0.35
        ORDER BY from_uid, to_uid, kind
        LIMIT ?
        `
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRelation(row));
  }

  getRelationsFrom(uid: string): Relation[] {
    const rows = this.prepareReadCached(
      "get-relations-from",
      "SELECT * FROM relations WHERE from_uid = ? ORDER BY to_uid"
    )
      .all(uid) as Record<string, unknown>[];
    return this.mergeSyntheticRelations(
      rows.map((row) => this.rowToRelation(row)),
      this.syntheticContainsFromFileUid(uid)
    );
  }

  getRelationsTo(uid: string): Relation[] {
    const rows = this.prepareReadCached(
      "get-relations-to",
      "SELECT * FROM relations WHERE to_uid = ? ORDER BY from_uid"
    )
      .all(uid) as Record<string, unknown>[];
    return this.mergeSyntheticRelations(
      rows.map((row) => this.rowToRelation(row)),
      this.syntheticContainsToUid(uid)
    );
  }

  getRelationsTouching(uids: string[], limit: number | null = 5000): Relation[] {
    if (uids.length === 0) {
      return [];
    }
    const rows: Record<string, unknown>[] = [];
    for (const chunk of chunks([...new Set(uids)])) {
      if (limit !== null && rows.length >= limit) {
        break;
      }
      const placeholders = chunk.map(() => "?").join(", ");
      const remainingLimit = limit === null ? null : limit - rows.length;
      const sql = `
        SELECT *
        FROM relations
        WHERE from_uid IN (${placeholders}) OR to_uid IN (${placeholders})
        ORDER BY from_uid, to_uid, kind
        ${remainingLimit === null ? "" : "LIMIT ?"}
        `;
      const params = remainingLimit === null ? [...chunk, ...chunk] : [...chunk, ...chunk, remainingLimit];
      rows.push(...(this.readDb.prepare(sql).all(...params) as Record<string, unknown>[]));
    }
    const synthetic = [...new Set(uids)].flatMap((uid) => [
      ...this.syntheticContainsFromFileUid(uid),
      ...this.syntheticContainsToUid(uid)
    ]);
    const merged = this.mergeSyntheticRelations(
      rows.map((row) => this.rowToRelation(row)),
      synthetic
    );
    return limit === null ? merged : merged.slice(0, limit);
  }

  deleteRelation(fromUid: string, toUid: string, kind?: RelationKind): number {
    if (kind) {
      const result = this.prepareCached(
        "delete-relation-with-kind",
        "DELETE FROM relations WHERE from_uid = ? AND to_uid = ? AND kind = ?"
      )
        .run(fromUid, toUid, kind);
      return result.changes;
    }
    const result = this.prepareCached(
      "delete-relation",
      "DELETE FROM relations WHERE from_uid = ? AND to_uid = ?"
    )
      .run(fromUid, toUid);
    return result.changes;
  }

  deleteEntity(uid: string): boolean {
    const result = this.db.transaction(() => {
      this.db.prepare("DELETE FROM relations WHERE from_uid = ? OR to_uid = ?").run(uid, uid);
      this.db.prepare("DELETE FROM embeddings WHERE uid = ?").run(uid);
      this.db.prepare("DELETE FROM embedding_buckets WHERE uid = ?").run(uid);
      this.db.prepare("DELETE FROM entity_fts WHERE uid = ?").run(uid);
      return this.db.prepare("DELETE FROM entities WHERE uid = ?").run(uid).changes;
    })();
    return result > 0;
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
    this.prepareCached(
      "upsert-entity",
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
    this.upsertEntityFts(mergedEntity);
  }

  private upsertEntityFts(entity: Entity): void {
    this.prepareCached("delete-entity-fts", "DELETE FROM entity_fts WHERE uid = ?").run(entity.uid);
    this.prepareCached(
      "insert-entity-fts",
      `
      INSERT INTO entity_fts(uid, name, path, description, docstring, tags)
      VALUES (?, ?, ?, ?, ?, ?)
      `
    )
      .run(
        entity.uid,
        [entity.name, searchableText(entity.name), entity.signature ?? ""].join(" "),
        [entity.path ?? "", searchableText(entity.path)].join(" "),
        [entity.description ?? "", searchableText(entity.description)].join(" "),
        [entity.docstring ?? "", searchableText(entity.docstring)].join(" "),
        [...(entity.tags ?? []), searchableText((entity.tags ?? []).join(" "))].join(" ")
      );
  }

  private refreshEntityFtsByUid(uids: string[]): void {
    const uniqueUids = [...new Set(uids)];
    if (uniqueUids.length === 0) {
      return;
    }
    for (const chunk of chunks(uniqueUids)) {
      const placeholders = chunk.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM entity_fts WHERE uid IN (${placeholders})`).run(...chunk);
    }
    for (const entity of this.getEntitiesByUid(uniqueUids)) {
      this.prepareCached(
        "insert-entity-fts",
        `
        INSERT INTO entity_fts(uid, name, path, description, docstring, tags)
        VALUES (?, ?, ?, ?, ?, ?)
        `
      )
        .run(
          entity.uid,
          [entity.name, searchableText(entity.name), entity.signature ?? ""].join(" "),
          [entity.path ?? "", searchableText(entity.path)].join(" "),
          [entity.description ?? "", searchableText(entity.description)].join(" "),
          [entity.docstring ?? "", searchableText(entity.docstring)].join(" "),
          [...(entity.tags ?? []), searchableText((entity.tags ?? []).join(" "))].join(" ")
        );
    }
  }

  rebuildEntityFts(): void {
    this.prepareCached("clear-entity-fts", "DELETE FROM entity_fts").run();
    const rows = this.prepareCached("iterate-entities", "SELECT * FROM entities ORDER BY uid").all() as Record<
      string,
      unknown
    >[];
    for (const row of rows) {
      const entity = this.rowToEntity(row);
      this.prepareCached(
        "insert-entity-fts",
        `
        INSERT INTO entity_fts(uid, name, path, description, docstring, tags)
        VALUES (?, ?, ?, ?, ?, ?)
        `
      )
        .run(
          entity.uid,
          [entity.name, searchableText(entity.name), entity.signature ?? ""].join(" "),
          [entity.path ?? "", searchableText(entity.path)].join(" "),
          [entity.description ?? "", searchableText(entity.description)].join(" "),
          [entity.docstring ?? "", searchableText(entity.docstring)].join(" "),
          [...(entity.tags ?? []), searchableText((entity.tags ?? []).join(" "))].join(" ")
        );
    }
  }

  upsertRelation(relation: Relation): void {
    const existingRow = this.prepareCached(
      "get-relation-by-key",
      "SELECT * FROM relations WHERE from_uid = ? AND to_uid = ? AND kind = ?"
    )
      .get(relation.from, relation.to, relation.kind) as Record<string, unknown> | undefined;

    const existing = existingRow ? this.rowToRelation(existingRow) : undefined;
    const mergedProvenance = mergeProvenance(existing?.provenance ?? [], relation.provenance);
    const newPriority = topSourcePriority(relation.provenance);
    const oldPriority = existing ? topSourcePriority(existing.provenance) : -1;
    const shouldOverwrite = !existing || newPriority >= oldPriority;
    const finalRelation = shouldOverwrite
      ? { ...relation, provenance: mergedProvenance }
      : { ...existing, provenance: mergedProvenance };

    this.prepareCached(
      "upsert-relation",
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

  markFileHash(
    filePath: string,
    hash: string,
    indexedAt: string,
    metadata?: { mtimeMs: number; sizeBytes: number }
  ): void {
    this.prepareCached(
      "mark-file-hash",
      `
      INSERT INTO file_hashes(path, content_hash, indexed_at, mtime_ms, size_bytes)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        content_hash = excluded.content_hash,
        indexed_at = excluded.indexed_at,
        mtime_ms = excluded.mtime_ms,
        size_bytes = excluded.size_bytes
      `
    )
      .run(filePath, hash, indexedAt, Math.trunc(metadata?.mtimeMs ?? 0) || null, metadata?.sizeBytes ?? null);
  }

  getFileHash(filePath: string): string | undefined {
    const row = this.prepareReadCached(
      "get-file-hash",
      "SELECT content_hash FROM file_hashes WHERE path = ?"
    )
      .get(filePath) as { content_hash: string } | undefined;
    return row?.content_hash;
  }

  getFileHashEntry(filePath: string): FileHashEntry | undefined {
    const row = this.prepareReadCached(
      "get-file-hash-entry",
      "SELECT content_hash, indexed_at, mtime_ms, size_bytes FROM file_hashes WHERE path = ?"
    )
      .get(filePath) as
      | { content_hash: string; indexed_at: string; mtime_ms: number | null; size_bytes: number | null }
      | undefined;
    if (!row) {
      return undefined;
    }
    return {
      hash: row.content_hash,
      indexedAt: row.indexed_at,
      mtimeMs: row.mtime_ms ?? undefined,
      sizeBytes: row.size_bytes ?? undefined
    };
  }

  getFileHashEntries(filePaths: string[]): Map<string, FileHashEntry> {
    const hashes = new Map<string, FileHashEntry>();
    for (const chunk of chunks([...new Set(filePaths)])) {
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.readDb
        .prepare(`SELECT path, content_hash, indexed_at, mtime_ms, size_bytes FROM file_hashes WHERE path IN (${placeholders})`)
        .all(...chunk) as {
        path: string;
        content_hash: string;
        indexed_at: string;
        mtime_ms: number | null;
        size_bytes: number | null;
      }[];
      for (const row of rows) {
        hashes.set(row.path, {
          hash: row.content_hash,
          indexedAt: row.indexed_at,
          mtimeMs: row.mtime_ms ?? undefined,
          sizeBytes: row.size_bytes ?? undefined
        });
      }
    }
    return hashes;
  }

  getFileHashes(filePaths: string[]): Map<string, string> {
    return new Map([...this.getFileHashEntries(filePaths)].map(([filePath, entry]) => [filePath, entry.hash]));
  }

  removeFileHash(filePath: string): void {
    this.prepareCached("remove-file-hash", "DELETE FROM file_hashes WHERE path = ?").run(filePath);
  }

  renameAstDataPath(oldPath: string, newPath: string, indexedAt: string): boolean {
    if (oldPath === newPath) {
      return false;
    }
    const entityRows = this.readDb
      .prepare("SELECT * FROM entities WHERE path = ? AND source_priority < 100")
      .all(oldPath) as Record<string, unknown>[];
    if (entityRows.length === 0) {
      return false;
    }

    const oldEntities = entityRows.map((row) => this.rowToEntity(row));
    const uidMap = new Map(oldEntities.map((entity) => [entity.uid, rewritePathBasedUid(entity.uid, oldPath, newPath)]));
    const oldUids = [...uidMap.keys()];
    const relations = this.getRelationsTouching(oldUids, null);
    const unresolvedRows = this.readDb
      .prepare("SELECT from_uid, symbol, kind, reason, confidence FROM unresolved_references WHERE path = ? AND resolved = 0")
      .all(oldPath) as {
      from_uid: string | null;
      symbol: string;
      kind: UnresolvedReference["kind"];
      reason: string | null;
      confidence: number;
    }[];
    const embeddingRows = chunks(oldUids).flatMap((chunk) => {
      const placeholders = chunk.map(() => "?").join(", ");
      return this.readDb
        .prepare(`SELECT uid, content_hash, vector_json, provider, updated_at FROM embeddings WHERE uid IN (${placeholders})`)
        .all(...chunk) as {
        uid: string;
        content_hash: string;
        vector_json: string;
        provider: string;
        updated_at: string;
      }[];
    });
    const oldHashEntry = this.getFileHashEntry(oldPath);

    this.clearAstDataForPath(newPath);
    this.clearAstDataForPath(oldPath);
    for (const chunk of chunks(oldUids)) {
      const placeholders = chunk.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM embeddings WHERE uid IN (${placeholders})`).run(...chunk);
      this.db.prepare(`DELETE FROM embedding_buckets WHERE uid IN (${placeholders})`).run(...chunk);
    }
    this.removeFileHash(oldPath);

    for (const entity of oldEntities) {
      this.upsertEntity({
        ...entity,
        uid: uidMap.get(entity.uid)!,
        path: newPath,
        metadata: {
          ...(entity.metadata ?? {}),
          previousPath: oldPath,
          renameReconciledAt: indexedAt
        },
        updatedAt: indexedAt
      });
    }
    for (const relation of relations) {
      this.upsertRelation({
        ...relation,
        from: uidMap.get(relation.from) ?? relation.from,
        to: uidMap.get(relation.to) ?? relation.to,
        metadata: {
          ...(relation.metadata ?? {}),
          renameReconciledAt: indexedAt
        }
      });
    }
    for (const ref of unresolvedRows) {
      this.upsertUnresolvedReference(
        {
          path: newPath,
          fromUid: ref.from_uid ? uidMap.get(ref.from_uid) ?? ref.from_uid : undefined,
          symbol: ref.symbol,
          kind: ref.kind,
          reason: ref.reason ?? undefined,
          confidence: ref.confidence
        },
        indexedAt
      );
    }
    for (const row of embeddingRows) {
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
        .run(uidMap.get(row.uid) ?? row.uid, row.content_hash, row.vector_json, row.provider, indexedAt);
    }
    if (oldHashEntry) {
      this.markFileHash(newPath, oldHashEntry.hash, indexedAt, {
        mtimeMs: oldHashEntry.mtimeMs ?? 0,
        sizeBytes: oldHashEntry.sizeBytes ?? 0
      });
    }
    return true;
  }

  clearUnresolvedForPath(filePath: string): void {
    this.prepareCached("clear-unresolved-for-path", "DELETE FROM unresolved_references WHERE path = ?").run(filePath);
  }

  upsertUnresolvedReference(ref: UnresolvedReference, createdAt: string): void {
    this.prepareCached(
      "insert-unresolved-reference",
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
    const rows = this.readDb
      .prepare(
        `
        SELECT path, from_uid, symbol, kind, reason, confidence
        FROM unresolved_references
        WHERE resolved = 0
        ORDER BY path, kind, symbol, from_uid
        `
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.rowToUnresolvedReference(row));
  }

  *iterateUnresolvedReferencesOrdered(): IterableIterator<UnresolvedReference> {
    const rows = this.readDb
      .prepare(
        `
        SELECT path, from_uid, symbol, kind, reason, confidence
        FROM unresolved_references
        WHERE resolved = 0
        ORDER BY path, kind, symbol, from_uid
        `
      )
      .iterate() as Iterable<Record<string, unknown>>;
    for (const row of rows) {
      yield this.rowToUnresolvedReference(row);
    }
  }

  unresolvedReferenceCount(): number {
    return (
      this.readDb.prepare("SELECT COUNT(*) AS count FROM unresolved_references WHERE resolved = 0").get() as {
        count: number;
      }
    ).count;
  }

  private insertEntityFast(entity: Entity): void {
    this.prepareCached(
      "upsert-entity-fast",
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
        created_at = entities.created_at,
        updated_at = excluded.updated_at
      WHERE entities.source_priority <= excluded.source_priority
      `
    )
      .run(
        entity.uid,
        entity.kind,
        entity.name,
        entity.path ?? null,
        entity.language ?? null,
        entity.signature ?? null,
        entity.startLine ?? null,
        entity.endLine ?? null,
        entity.description ?? null,
        entity.docstring ?? null,
        toJson(entity.tags ?? []),
        toJson(entity.metadata ?? {}),
        entity.confidence,
        toJson(entity.provenance),
        topSourcePriority(entity.provenance),
        entity.createdAt,
        entity.updatedAt
      );
  }

  private insertRelationFast(relation: Relation): void {
    this.prepareCached(
      "upsert-relation-fast",
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
      WHERE relations.source_priority <= excluded.source_priority
      `
    )
      .run(
        relation.from,
        relation.to,
        relation.kind,
        relation.reason ?? null,
        relation.weight ?? null,
        relation.confidence,
        toJson(relation.provenance),
        toJson(relation.metadata ?? {}),
        topSourcePriority(relation.provenance)
      );
  }

  clearAstDataForPaths(filePaths: string[]): void {
    const uniquePaths = [...new Set(filePaths)];
    if (uniquePaths.length === 0) {
      return;
    }

    const uids: string[] = [];
    for (const chunk of chunks(uniquePaths)) {
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.db
        .prepare(`SELECT uid FROM entities WHERE path IN (${placeholders}) AND source_priority < 100`)
        .all(...chunk) as { uid: string }[];
      uids.push(...rows.map((row) => row.uid));
    }

    if (uids.length > 0) {
      for (const chunk of chunks([...new Set(uids)])) {
        const placeholders = chunk.map(() => "?").join(", ");
        this.db.prepare(`DELETE FROM relations WHERE from_uid IN (${placeholders}) OR to_uid IN (${placeholders})`).run(
          ...chunk,
          ...chunk
        );
      }
      for (const chunk of chunks([...new Set(uids)])) {
        const placeholders = chunk.map(() => "?").join(", ");
        this.db.prepare(`DELETE FROM entity_fts WHERE uid IN (${placeholders})`).run(...chunk);
        this.db.prepare(`DELETE FROM entities WHERE uid IN (${placeholders})`).run(...chunk);
      }
    }

    for (const chunk of chunks(uniquePaths)) {
      const placeholders = chunk.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM unresolved_references WHERE path IN (${placeholders})`).run(...chunk);
    }
  }

  replaceAstFiles(files: IndexedAstFile[]): void {
    if (files.length === 0) {
      return;
    }
    this.clearAstDataForPaths(files.map((file) => file.relPath));
    const entityUidsToRefresh: string[] = [];
    for (const file of files) {
      for (const entity of file.entities) {
        this.insertEntityFast(entity);
        entityUidsToRefresh.push(entity.uid);
      }
      for (const relation of file.relations) {
        this.insertRelationFast(relation);
      }
      for (const unresolved of file.unresolved) {
        this.upsertUnresolvedReference(unresolved, file.indexedAt);
      }
      this.markFileHash(file.relPath, file.hash, file.indexedAt, {
        mtimeMs: file.mtimeMs,
        sizeBytes: file.sizeBytes
      });
    }
    this.refreshEntityFtsByUid(entityUidsToRefresh);
  }

  clearAstDataForPath(filePath: string): void {
    this.clearAstDataForPaths([filePath]);
  }

  listFilesInHashTable(): string[] {
    const rows = this.readDb.prepare("SELECT path FROM file_hashes ORDER BY path").all() as { path: string }[];
    return rows.map((r) => r.path);
  }

  getSnapshot(): GraphSnapshot {
    return {
      entities: [...this.iterateEntitiesOrdered()],
      relations: [...this.iterateRelationsOrdered()],
      unresolvedReferences: [...this.iterateUnresolvedReferencesOrdered()]
    };
  }

  exportJson(targetPath: string): void {
    const snapshot = this.getSnapshot();
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }

  exportJsonl(targetDir: string): void {
    fs.mkdirSync(targetDir, { recursive: true });
    const writeJsonLines = (fileName: string, rows: Iterable<unknown>): number => {
      const handle = fs.openSync(path.join(targetDir, fileName), "w");
      let count = 0;
      try {
        for (const row of rows) {
          fs.writeSync(handle, `${JSON.stringify(row)}\n`, undefined, "utf8");
          count += 1;
        }
      } finally {
        fs.closeSync(handle);
      }
      return count;
    };

    const entityCount = writeJsonLines("entities.jsonl", this.iterateEntitiesOrdered());
    const relationCount = writeJsonLines("relations.jsonl", this.iterateRelationsOrdered());
    const unresolvedCount = writeJsonLines("unresolved.jsonl", this.iterateUnresolvedReferencesOrdered());
    fs.writeFileSync(
      path.join(targetDir, "manifest.json"),
      `${JSON.stringify(
        {
          format: "dsp-jsonl",
          version: 1,
          generatedAt: new Date().toISOString(),
          files: {
            entities: "entities.jsonl",
            relations: "relations.jsonl",
            unresolvedReferences: "unresolved.jsonl"
          },
          counts: {
            entities: entityCount,
            relations: relationCount,
            unresolvedReferences: unresolvedCount
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
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

  exportProtocol(targetDir: string): void {
    const protocolDir = path.join(targetDir, ".dsp", "protocol");
    fs.rmSync(protocolDir, { recursive: true, force: true });
    fs.mkdirSync(protocolDir, { recursive: true });

    const entityOrder: string[] = [];
    const uidMap: Record<string, string> = {};
    const entityByUid = new Map<string, Entity>();
    const outgoingByUid = new Map<string, Relation[]>();

    for (const entity of this.iterateEntitiesOrdered()) {
      entityOrder.push(entity.uid);
      uidMap[entity.uid] = protocolUidForEntity(entity);
      entityByUid.set(entity.uid, entity);
    }

    for (const relation of this.iterateRelationsOrdered()) {
      const bucket = outgoingByUid.get(relation.from) ?? [];
      bucket.push(relation);
      outgoingByUid.set(relation.from, bucket);
    }

    for (const entityUid of entityOrder) {
      const entity = entityByUid.get(entityUid)!;
      const protocolUid = uidMap[entityUid]!;
      const entityDir = path.join(protocolDir, protocolUid);
      fs.mkdirSync(path.join(entityDir, "exports"), { recursive: true });
      writeProtocolDescription(path.join(entityDir, "description"), entity, protocolUid);

      const outgoing = outgoingByUid.get(entity.uid) ?? [];
      const importLines = outgoing
        .filter((relation) => relation.kind !== "contains" && uidMap[relation.to])
        .map((relation) => `${uidMap[relation.to]} # ${relation.kind}${relation.reason ? `: ${relation.reason}` : ""}`)
        .sort();
      fs.writeFileSync(path.join(entityDir, "imports"), `${importLines.join("\n")}${importLines.length ? "\n" : ""}`, "utf8");

      const sharedLines = outgoing
        .filter((relation) => ["contains", "exports"].includes(relation.kind) && uidMap[relation.to])
        .map((relation) => uidMap[relation.to]!)
        .sort();
      fs.writeFileSync(path.join(entityDir, "shared"), `${[...new Set(sharedLines)].join("\n")}${sharedLines.length ? "\n" : ""}`, "utf8");
    }

    for (const relation of this.iterateRelationsOrdered()) {
      const importedUid = uidMap[relation.to];
      const importerUid = uidMap[relation.from];
      if (!importedUid || !importerUid || relation.kind === "contains") {
        continue;
      }
      const exportPath = path.join(protocolDir, importedUid, "exports", importerUid);
      const importer = entityByUid.get(relation.from);
      const why = relation.reason ?? `${importer?.name ?? relation.from} ${relation.kind} ${entityByUid.get(relation.to)?.name ?? relation.to}`;
      fs.writeFileSync(exportPath, `${why}\nkind: ${relation.kind}\nconfidence: ${relation.confidence.toFixed(2)}\n`, "utf8");
    }

    fs.writeFileSync(path.join(protocolDir, "TOC"), `${entityOrder.map((uid) => uidMap[uid]).join("\n")}\n`, "utf8");
    fs.writeFileSync(path.join(protocolDir, "uid-map.json"), `${JSON.stringify(uidMap, null, 2)}\n`, "utf8");
    fs.writeFileSync(
      path.join(protocolDir, "README.md"),
      `# DSP protocol export\n\nThis directory is a plain-text, agent-readable export generated from the SQLite DSP graph.\n\n- Entity directories use protocol-compatible \`obj-*\` / \`func-*\` IDs.\n- \`uid-map.json\` maps canonical DSP graph UIDs to protocol export IDs.\n- SQLite remains the canonical store for DSP v2.\n`,
      "utf8"
    );
  }

  exportDsp(targetDir: string): void {
    const dspDir = path.join(targetDir, ".dsp", "export");
    fs.mkdirSync(dspDir, { recursive: true });
    const entityHandle = fs.openSync(path.join(dspDir, "entities.txt"), "w");
    const relationHandle = fs.openSync(path.join(dspDir, "relations.txt"), "w");
    const unresolvedHandle = fs.openSync(path.join(dspDir, "unresolved.txt"), "w");
    let entityCount = 0;
    let relationCount = 0;
    let unresolvedCount = 0;
    try {
      for (const entity of this.iterateEntitiesOrdered()) {
        fs.writeSync(
          entityHandle,
          [
            `${entity.uid} [${entity.kind}]`,
            `name=${entity.name}`,
            `path=${entity.path ?? ""}`,
            `language=${entity.language ?? ""}`,
            `confidence=${entity.confidence.toFixed(2)}`
          ].join(" | ") + "\n",
          undefined,
          "utf8"
        );
        entityCount += 1;
      }
      for (const relation of this.iterateRelationsOrdered()) {
        fs.writeSync(
          relationHandle,
          `${relation.from} --${relation.kind}--> ${relation.to} | confidence=${relation.confidence.toFixed(2)} | reason=${relation.reason ?? ""}\n`,
          undefined,
          "utf8"
        );
        relationCount += 1;
      }
      for (const ref of this.iterateUnresolvedReferencesOrdered()) {
        fs.writeSync(
          unresolvedHandle,
          `${ref.path} :: ${ref.kind} :: ${ref.symbol} :: confidence=${ref.confidence.toFixed(2)}\n`,
          undefined,
          "utf8"
        );
        unresolvedCount += 1;
      }
    } finally {
      fs.closeSync(entityHandle);
      fs.closeSync(relationHandle);
      fs.closeSync(unresolvedHandle);
    }
    fs.writeFileSync(
      path.join(dspDir, "summary.json"),
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          entities: entityCount,
          relations: relationCount,
          unresolved: unresolvedCount
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }

  setEmbedding(uid: string, hash: string, vector: number[], provider: string, updatedAt: string): void {
    const bucketKey = embeddingBucketKey(vector);
    this.transaction(() => {
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
      this.prepareCached("clear-embedding-buckets-for-uid", "DELETE FROM embedding_buckets WHERE uid = ?").run(uid);
      this.prepareCached(
        "insert-embedding-bucket",
        "INSERT OR REPLACE INTO embedding_buckets(provider, bucket_key, uid) VALUES (?, ?, ?)"
      ).run(provider, bucketKey, uid);
    });
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

  getEmbeddingsByProvider(provider: string, limit = 200000): StoredEmbedding[] {
    const rows = this.db
      .prepare(
        `
        SELECT uid, content_hash, vector_json, provider
        FROM embeddings
        WHERE provider = ?
        ORDER BY uid
        LIMIT ?
        `
      )
      .all(provider, limit) as {
      uid: string;
      content_hash: string;
      vector_json: string;
      provider: string;
    }[];
    return rows.map((row) => ({
      uid: row.uid,
      hash: row.content_hash,
      vector: fromJson<number[]>(row.vector_json),
      provider: row.provider
    }));
  }

  getEmbeddingsByBucket(provider: string, bucketKeys: string[], limit = 5000): StoredEmbedding[] {
    if (bucketKeys.length === 0) {
      return [];
    }
    const seen = new Set<string>();
    const embeddings: StoredEmbedding[] = [];
    for (const chunk of chunks([...new Set(bucketKeys)])) {
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.readDb
        .prepare(
          `
          SELECT embeddings.uid, embeddings.content_hash, embeddings.vector_json, embeddings.provider
          FROM embedding_buckets
          JOIN embeddings ON embeddings.uid = embedding_buckets.uid
          WHERE embedding_buckets.provider = ?
            AND embedding_buckets.bucket_key IN (${placeholders})
          ORDER BY embedding_buckets.bucket_key, embeddings.uid
          LIMIT ?
          `
        )
        .all(provider, ...chunk, limit) as {
        uid: string;
        content_hash: string;
        vector_json: string;
        provider: string;
      }[];
      for (const row of rows) {
        if (seen.has(row.uid)) {
          continue;
        }
        seen.add(row.uid);
        embeddings.push({
          uid: row.uid,
          hash: row.content_hash,
          vector: fromJson<number[]>(row.vector_json),
          provider: row.provider
        });
        if (embeddings.length >= limit) {
          return embeddings;
        }
      }
    }
    return embeddings;
  }

  nearestEmbeddingsByProvider(
    provider: string,
    queryVector: number[],
    options: { topK?: number; scanLimit?: number } = {}
  ): RankedEmbedding[] {
    const topK = options.topK ?? 100;
    const scanLimit = options.scanLimit ?? Math.max(topK * 20, 2000);
    const bucketCandidates = this.getEmbeddingsByBucket(
      provider,
      embeddingBucketNeighbors(embeddingBucketKey(queryVector)),
      scanLimit
    );
    const scanSource = bucketCandidates.length >= Math.min(topK, 10)
      ? bucketCandidates
      : this.getEmbeddingsByProvider(provider, scanLimit);
    return scanSource
      .map((embedding) => ({
        ...embedding,
        score: Math.max(0, cosineSimilarity(queryVector, embedding.vector))
      }))
      .filter((embedding) => embedding.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, topK);
  }

  cacheStats(): {
    fileHashes: number;
    embeddings: number;
    unresolvedReferences: number;
    parseCache: number;
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
    const parseCache = (this.db.prepare("SELECT COUNT(*) as count FROM parse_cache").get() as { count: number })
      .count;
    return { fileHashes, embeddings, unresolvedReferences, parseCache };
  }

  embeddingStats(): EmbeddingStats {
    const rows = this.db
      .prepare(
        `
        SELECT provider, COUNT(*) AS count
        FROM embeddings
        GROUP BY provider
        ORDER BY provider
        `
      )
      .all() as { provider: string; count: number }[];
    return {
      total: rows.reduce((sum, row) => sum + row.count, 0),
      byProvider: Object.fromEntries(rows.map((row) => [row.provider, row.count]))
    };
  }

  clearCache(): void {
    this.db.exec(`
      DELETE FROM embeddings;
      DELETE FROM embedding_buckets;
      DELETE FROM file_hashes;
      DELETE FROM parse_cache;
    `);
    this.maintainCaches({ maxEntries: 0, maxAgeDays: 0, vacuumFreelistThreshold: 0 });
  }
}
