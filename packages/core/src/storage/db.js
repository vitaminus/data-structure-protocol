import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { mergeProvenance, topSourcePriority } from "../graph/provenance.js";
import { ensureDir } from "../util/fs.js";
function toJson(value) {
    return JSON.stringify(value ?? null);
}
function fromJson(value) {
    return value ? JSON.parse(value) : null;
}
function protocolUidForEntity(entity) {
    if (/^(?:obj|func)-[0-9a-fA-F]{8}$/.test(entity.uid)) {
        return entity.uid;
    }
    const prefix = ["function", "method", "route", "test"].includes(entity.kind) ? "func" : "obj";
    const hash = createHash("sha1").update(entity.uid).digest("hex").slice(0, 8);
    return `${prefix}-${hash}`;
}
function protocolKind(entity) {
    if (entity.metadata?.external) {
        return "external";
    }
    return ["function", "method", "route", "test"].includes(entity.kind) ? "function" : "object";
}
function writeProtocolDescription(target, entity, protocolUid) {
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
export class DSPDatabase {
    dbPath;
    db;
    constructor(rootDir) {
        this.dbPath = path.join(rootDir, ".dsp", "dsp.sqlite");
        ensureDir(path.dirname(this.dbPath));
        this.db = new Database(this.dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("foreign_keys = ON");
        this.initialize();
    }
    initialize() {
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
    close() {
        this.db.close();
    }
    transaction(fn) {
        return this.db.transaction(fn)();
    }
    beginRun(mode, startedAt) {
        const stmt = this.db.prepare("INSERT INTO index_runs(started_at, mode, status, metadata_json) VALUES (?, ?, 'running', ?)");
        const res = stmt.run(startedAt, mode, "{}");
        return Number(res.lastInsertRowid);
    }
    finishRun(runId, status, endedAt, meta) {
        this.db
            .prepare("UPDATE index_runs SET status = ?, ended_at = ?, metadata_json = ? WHERE id = ?")
            .run(status, endedAt, toJson(meta), runId);
    }
    rowToEntity(row) {
        return {
            uid: String(row.uid),
            kind: row.kind,
            name: String(row.name),
            path: row.path ? String(row.path) : undefined,
            language: row.language ? String(row.language) : undefined,
            signature: row.signature ? String(row.signature) : undefined,
            startLine: row.start_line ? Number(row.start_line) : undefined,
            endLine: row.end_line ? Number(row.end_line) : undefined,
            description: row.description ? String(row.description) : undefined,
            docstring: row.docstring ? String(row.docstring) : undefined,
            tags: fromJson(row.tags_json ? String(row.tags_json) : "[]"),
            metadata: fromJson(row.metadata_json ? String(row.metadata_json) : "{}"),
            provenance: fromJson(String(row.provenance_json)),
            confidence: Number(row.confidence),
            createdAt: String(row.created_at),
            updatedAt: String(row.updated_at)
        };
    }
    rowToRelation(row) {
        return {
            from: String(row.from_uid),
            to: String(row.to_uid),
            kind: row.kind,
            reason: row.reason ? String(row.reason) : undefined,
            weight: row.weight !== null && row.weight !== undefined ? Number(row.weight) : undefined,
            confidence: Number(row.confidence),
            provenance: fromJson(String(row.provenance_json)),
            metadata: fromJson(row.metadata_json ? String(row.metadata_json) : "{}")
        };
    }
    getEntity(uid) {
        const row = this.db.prepare("SELECT * FROM entities WHERE uid = ?").get(uid);
        return row ? this.rowToEntity(row) : undefined;
    }
    getEntities(limit = 10000) {
        const rows = this.db.prepare("SELECT * FROM entities ORDER BY uid LIMIT ?").all(limit);
        return rows.map((row) => this.rowToEntity(row));
    }
    getRelations(limit = 50000) {
        const rows = this.db
            .prepare("SELECT * FROM relations ORDER BY from_uid, to_uid, kind LIMIT ?")
            .all(limit);
        return rows.map((row) => this.rowToRelation(row));
    }
    getRelationsFrom(uid) {
        const rows = this.db
            .prepare("SELECT * FROM relations WHERE from_uid = ? ORDER BY to_uid")
            .all(uid);
        return rows.map((row) => this.rowToRelation(row));
    }
    getRelationsTo(uid) {
        const rows = this.db
            .prepare("SELECT * FROM relations WHERE to_uid = ? ORDER BY from_uid")
            .all(uid);
        return rows.map((row) => this.rowToRelation(row));
    }
    upsertEntity(entity) {
        const existing = this.getEntity(entity.uid);
        const mergedProvenance = mergeProvenance(existing?.provenance ?? [], entity.provenance);
        const newPriority = topSourcePriority(entity.provenance);
        const oldPriority = existing ? topSourcePriority(existing.provenance) : -1;
        const shouldOverwrite = !existing || newPriority >= oldPriority;
        const mergedEntity = shouldOverwrite
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
            .prepare(`
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
      `)
            .run(mergedEntity.uid, mergedEntity.kind, mergedEntity.name, mergedEntity.path ?? null, mergedEntity.language ?? null, mergedEntity.signature ?? null, mergedEntity.startLine ?? null, mergedEntity.endLine ?? null, mergedEntity.description ?? null, mergedEntity.docstring ?? null, toJson(mergedEntity.tags ?? []), toJson(mergedEntity.metadata ?? {}), mergedEntity.confidence, toJson(mergedEntity.provenance), topSourcePriority(mergedEntity.provenance), mergedEntity.createdAt, mergedEntity.updatedAt);
    }
    upsertRelation(relation) {
        const existingRow = this.db
            .prepare("SELECT * FROM relations WHERE from_uid = ? AND to_uid = ? AND kind = ?")
            .get(relation.from, relation.to, relation.kind);
        const existing = existingRow ? this.rowToRelation(existingRow) : undefined;
        const mergedProvenance = mergeProvenance(existing?.provenance ?? [], relation.provenance);
        const newPriority = topSourcePriority(relation.provenance);
        const oldPriority = existing ? topSourcePriority(existing.provenance) : -1;
        const shouldOverwrite = !existing || newPriority >= oldPriority;
        const finalRelation = shouldOverwrite
            ? { ...relation, provenance: mergedProvenance }
            : { ...existing, provenance: mergedProvenance };
        this.db
            .prepare(`
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
      `)
            .run(finalRelation.from, finalRelation.to, finalRelation.kind, finalRelation.reason ?? null, finalRelation.weight ?? null, finalRelation.confidence, toJson(finalRelation.provenance), toJson(finalRelation.metadata ?? {}), topSourcePriority(finalRelation.provenance));
    }
    markFileHash(filePath, hash, indexedAt) {
        this.db
            .prepare(`
      INSERT INTO file_hashes(path, content_hash, indexed_at)
      VALUES (?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET content_hash = excluded.content_hash, indexed_at = excluded.indexed_at
      `)
            .run(filePath, hash, indexedAt);
    }
    getFileHash(filePath) {
        const row = this.db
            .prepare("SELECT content_hash FROM file_hashes WHERE path = ?")
            .get(filePath);
        return row?.content_hash;
    }
    removeFileHash(filePath) {
        this.db.prepare("DELETE FROM file_hashes WHERE path = ?").run(filePath);
    }
    clearUnresolvedForPath(filePath) {
        this.db.prepare("DELETE FROM unresolved_references WHERE path = ?").run(filePath);
    }
    upsertUnresolvedReference(ref, createdAt) {
        this.db
            .prepare(`
      INSERT INTO unresolved_references(path, from_uid, symbol, kind, reason, confidence, created_at, resolved)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `)
            .run(ref.path, ref.fromUid ?? null, ref.symbol, ref.kind, ref.reason ?? null, ref.confidence, createdAt);
    }
    getUnresolvedReferences() {
        const rows = this.db
            .prepare("SELECT path, from_uid, symbol, kind, reason, confidence FROM unresolved_references WHERE resolved = 0")
            .all();
        return rows.map((row) => ({
            path: row.path,
            fromUid: row.from_uid ?? undefined,
            symbol: row.symbol,
            kind: row.kind,
            reason: row.reason ?? undefined,
            confidence: row.confidence
        }));
    }
    clearAstDataForPath(filePath) {
        const fileEntities = this.db
            .prepare("SELECT uid FROM entities WHERE path = ? AND source_priority < 100")
            .all(filePath);
        const uids = fileEntities.map((row) => row.uid);
        if (uids.length === 0) {
            this.clearUnresolvedForPath(filePath);
            return;
        }
        const placeholders = uids.map(() => "?").join(", ");
        this.db.prepare(`DELETE FROM relations WHERE from_uid IN (${placeholders}) OR to_uid IN (${placeholders})`).run(...uids, ...uids);
        this.db.prepare(`DELETE FROM entities WHERE uid IN (${placeholders})`).run(...uids);
        this.clearUnresolvedForPath(filePath);
    }
    listFilesInHashTable() {
        const rows = this.db.prepare("SELECT path FROM file_hashes ORDER BY path").all();
        return rows.map((r) => r.path);
    }
    getSnapshot() {
        return {
            entities: this.getEntities(200000),
            relations: this.getRelations(500000),
            unresolvedReferences: this.getUnresolvedReferences()
        };
    }
    exportJson(targetPath) {
        const snapshot = this.getSnapshot();
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    }
    importJson(sourcePath) {
        const raw = fs.readFileSync(sourcePath, "utf8");
        const snapshot = JSON.parse(raw);
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
    exportProtocol(targetDir) {
        const protocolDir = path.join(targetDir, ".dsp", "protocol");
        fs.rmSync(protocolDir, { recursive: true, force: true });
        fs.mkdirSync(protocolDir, { recursive: true });
        const entities = this.getEntities(200000).sort((a, b) => a.uid.localeCompare(b.uid));
        const relations = this.getRelations(500000);
        const uidMap = Object.fromEntries(entities.map((entity) => [entity.uid, protocolUidForEntity(entity)]));
        const entityByUid = new Map(entities.map((entity) => [entity.uid, entity]));
        for (const entity of entities) {
            const protocolUid = uidMap[entity.uid];
            const entityDir = path.join(protocolDir, protocolUid);
            fs.mkdirSync(path.join(entityDir, "exports"), { recursive: true });
            writeProtocolDescription(path.join(entityDir, "description"), entity, protocolUid);
            const outgoing = relations.filter((relation) => relation.from === entity.uid);
            const importLines = outgoing
                .filter((relation) => relation.kind !== "contains" && uidMap[relation.to])
                .map((relation) => `${uidMap[relation.to]} # ${relation.kind}${relation.reason ? `: ${relation.reason}` : ""}`)
                .sort();
            fs.writeFileSync(path.join(entityDir, "imports"), `${importLines.join("\n")}${importLines.length ? "\n" : ""}`, "utf8");
            const sharedLines = outgoing
                .filter((relation) => ["contains", "exports"].includes(relation.kind) && uidMap[relation.to])
                .map((relation) => uidMap[relation.to])
                .sort();
            fs.writeFileSync(path.join(entityDir, "shared"), `${[...new Set(sharedLines)].join("\n")}${sharedLines.length ? "\n" : ""}`, "utf8");
        }
        for (const relation of relations) {
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
        fs.writeFileSync(path.join(protocolDir, "TOC"), `${entities.map((entity) => uidMap[entity.uid]).join("\n")}\n`, "utf8");
        fs.writeFileSync(path.join(protocolDir, "uid-map.json"), `${JSON.stringify(uidMap, null, 2)}\n`, "utf8");
        fs.writeFileSync(path.join(protocolDir, "README.md"), `# DSP protocol export\n\nThis directory is a plain-text, agent-readable export generated from the SQLite DSP graph.\n\n- Entity directories use protocol-compatible \`obj-*\` / \`func-*\` IDs.\n- \`uid-map.json\` maps canonical DSP graph UIDs to protocol export IDs.\n- SQLite remains the canonical store for DSP v2.\n`, "utf8");
    }
    exportDsp(targetDir) {
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
            .sort((a, b) => `${a.from}:${a.kind}:${a.to}`.localeCompare(`${b.from}:${b.kind}:${b.to}`))
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
        fs.writeFileSync(path.join(dspDir, "summary.json"), `${JSON.stringify({
            generatedAt: new Date().toISOString(),
            entities: entities.length,
            relations: relations.length,
            unresolved: unresolved.length
        }, null, 2)}\n`, "utf8");
    }
    setEmbedding(uid, hash, vector, provider, updatedAt) {
        this.db
            .prepare(`
      INSERT INTO embeddings(uid, content_hash, vector_json, provider, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(uid) DO UPDATE SET
        content_hash = excluded.content_hash,
        vector_json = excluded.vector_json,
        provider = excluded.provider,
        updated_at = excluded.updated_at
      `)
            .run(uid, hash, toJson(vector), provider, updatedAt);
    }
    getEmbedding(uid) {
        const row = this.db
            .prepare("SELECT content_hash, vector_json, provider FROM embeddings WHERE uid = ?")
            .get(uid);
        if (!row) {
            return undefined;
        }
        return { hash: row.content_hash, vector: fromJson(row.vector_json), provider: row.provider };
    }
    cacheStats() {
        const fileHashes = this.db.prepare("SELECT COUNT(*) as count FROM file_hashes").get()
            .count;
        const embeddings = this.db.prepare("SELECT COUNT(*) as count FROM embeddings").get()
            .count;
        const unresolvedReferences = this.db.prepare("SELECT COUNT(*) as count FROM unresolved_references WHERE resolved = 0").get().count;
        return { fileHashes, embeddings, unresolvedReferences };
    }
    clearCache() {
        this.db.exec(`
      DELETE FROM embeddings;
      DELETE FROM file_hashes;
    `);
    }
}
//# sourceMappingURL=db.js.map