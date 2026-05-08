#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Command } from "commander";
import {
  findEntityByUidOrPath,
  getNeighbors,
  initDSP,
  openDSP,
  runBootstrap,
  runChanged,
  runContextPack,
  runEmbeddingsUpdate,
  runExport,
  runImport,
  runImpact,
  runMarkersApply,
  runIndex,
  runRepair,
  runSearch,
  runValidate,
  watchRepository,
  type DSPServices,
  type Entity,
  type EntityKind,
  type LanguageAdapter,
  type RelationKind,
  type WatchSummary
} from "@dsp/core";
import { createTypeScriptLanguageAdapter } from "@dsp/language-typescript";
import { createPythonLanguageAdapter } from "@dsp/language-python";
import { createRustLanguageAdapter } from "@dsp/language-rust";
import { createRubyLanguageAdapter } from "@dsp/language-ruby";
import { startMcpServer } from "@dsp/mcp-server";

function adapters(): LanguageAdapter[] {
  return [
    createTypeScriptLanguageAdapter(),
    createPythonLanguageAdapter(),
    createRustLanguageAdapter(),
    createRubyLanguageAdapter()
  ];
}

function printOutput(output: unknown, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }
  if (typeof output === "string") {
    process.stdout.write(`${output}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

const TRAVERSAL_KINDS = new Set<RelationKind>([
  "imports",
  "depends_on",
  "calls",
  "uses",
  "tests",
  "routes_to",
  "extends",
  "implements",
  "exports"
]);

function requireEntity(services: DSPServices, uidOrPath: string): Entity {
  const entity = findEntityByUidOrPath(services.db, uidOrPath);
  if (!entity) {
    throw new Error(`Entity not found: ${uidOrPath}`);
  }
  return entity;
}

function relationKey(from: string, kind: string, to: string): string {
  return `${from}\0${kind}\0${to}`;
}

function directedTree(
  services: DSPServices,
  root: Entity,
  depth: number,
  direction: "children" | "parents"
): unknown {
  const visited = new Set<string>();
  const walk = (entity: Entity, remaining: number): unknown => {
    if (remaining <= 0 || visited.has(entity.uid)) {
      return { entity, relations: [], [direction]: [] };
    }
    visited.add(entity.uid);
    const relations = (direction === "children"
      ? services.db.getRelationsFrom(entity.uid)
      : services.db.getRelationsTo(entity.uid)
    ).filter((relation) => TRAVERSAL_KINDS.has(relation.kind));
    const nodes = relations
      .map((relation) => services.db.getEntity(direction === "children" ? relation.to : relation.from))
      .filter(Boolean) as Entity[];
    return {
      entity,
      relations,
      [direction]: nodes.map((node) => walk(node, remaining - 1))
    };
  };
  return walk(root, depth);
}

function graphStats(services: DSPServices): unknown {
  return {
    entities: services.db.entityCount(),
    relations: services.db.relationCount(),
    unresolvedReferences: services.db.unresolvedReferenceCount(),
    byKind: services.db.entityCountsByKind(),
    byLanguage: services.db.entityCountsByLanguage(),
    cache: services.db.cacheStats()
  };
}

function findSourceEntities(services: DSPServices, sourcePath: string): Entity[] {
  return services.db.findEntitiesByPath(sourcePath);
}

function shortestPath(services: DSPServices, fromUid: string, toUid: string): string[] | undefined {
  const queue: string[][] = [[fromUid]];
  const visited = new Set<string>([fromUid]);
  while (queue.length > 0) {
    const pathSoFar = queue.shift()!;
    const current = pathSoFar.at(-1)!;
    if (current === toUid) {
      return pathSoFar;
    }
    for (const relation of services.db.getRelationsFrom(current).filter((rel) => TRAVERSAL_KINDS.has(rel.kind))) {
      if (!visited.has(relation.to)) {
        visited.add(relation.to);
        queue.push([...pathSoFar, relation.to]);
      }
    }
  }
  return undefined;
}

function detectCycles(services: DSPServices): string[][] {
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const entities = services.db.getEntities(300000);
  const seenCycles = new Set<string>();

  const dfs = (uid: string): void => {
    if (visiting.has(uid)) {
      const start = stack.indexOf(uid);
      const cycle = [...stack.slice(start), uid];
      const key = cycle.join("->");
      if (!seenCycles.has(key)) {
        seenCycles.add(key);
        cycles.push(cycle);
      }
      return;
    }
    if (visited.has(uid)) {
      return;
    }
    visiting.add(uid);
    stack.push(uid);
    for (const relation of services.db.getRelationsFrom(uid).filter((rel) => TRAVERSAL_KINDS.has(rel.kind))) {
      dfs(relation.to);
    }
    stack.pop();
    visiting.delete(uid);
    visited.add(uid);
  };

  for (const entity of entities) {
    dfs(entity.uid);
  }
  return cycles;
}

function orphans(services: DSPServices): Entity[] {
  const entities = services.db.getEntities(300000);
  return entities.filter((entity) => {
    if (["repository", "directory", "file"].includes(entity.kind)) {
      return false;
    }
    return services.db
      .getRelationsTo(entity.uid)
      .filter((relation) => relation.kind !== "contains")
      .length === 0;
  });
}

function manualUid(prefix: "obj" | "func", requested?: string): string {
  if (requested) {
    return requested;
  }
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

function manualProvenance(now: string, evidence: string) {
  return [{ source: "human" as const, tool: "dsp-cli", timestamp: now, confidence: 1, evidence }];
}

function parseSource(source: string): { path: string; symbol?: string; name: string } {
  const [sourcePath, symbol] = source.split("#");
  return {
    path: sourcePath!,
    symbol,
    name: symbol ?? path.basename(sourcePath!)
  };
}

function entityKindFromOption(kind: string, fallback: EntityKind): EntityKind {
  const allowed: EntityKind[] = [
    "repository",
    "directory",
    "file",
    "module",
    "function",
    "class",
    "method",
    "type",
    "interface",
    "constant",
    "route",
    "test",
    "unknown"
  ];
  return allowed.includes(kind as EntityKind) ? (kind as EntityKind) : fallback;
}

function relationKindFromOption(kind: string, fallback: RelationKind): RelationKind {
  const allowed: RelationKind[] = [
    "contains",
    "imports",
    "exports",
    "calls",
    "extends",
    "implements",
    "uses",
    "tests",
    "routes_to",
    "depends_on",
    "similar_to",
    "annotates"
  ];
  return allowed.includes(kind as RelationKind) ? (kind as RelationKind) : fallback;
}

const program = new Command();
program.name("dsp").description("DSP v2 context compiler").version("0.1.0");

program
  .command("init")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((rootDir: string, options: { json: boolean }) => {
    const result = initDSP(path.resolve(rootDir));
    printOutput(result, options.json);
  });

program
  .command("index")
  .argument("[rootDir]", "root directory", ".")
  .option("--lazy", "lazy indexing mode", false)
  .option("--full", "full reindex", false)
  .option("--changed-only", "index only changed files", false)
  .option("--from-git-diff", "index files from git diff", false)
  .option("--no-embeddings", "disable embeddings for this run")
  .option("--json", "machine-readable output", false)
  .action(async (rootDir: string, options) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const summary = await runIndex(
        services,
        {
          rootDir: services.rootDir,
          lazy: options.lazy,
          full: options.full,
          changedOnly: options.changedOnly,
          fromGitDiff: options.fromGitDiff,
          noEmbeddings: options.embeddings === false
        }
      );
      printOutput(summary, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("bootstrap")
  .argument("[rootDir]", "root directory", ".")
  .option("--large-repo", "large repository mode", false)
  .option("--lazy", "lazy bootstrap mode", false)
  .option("--no-embeddings", "disable embeddings for this run")
  .option("--dry-run", "simulate without writes", false)
  .option("--reset", "reset existing index before bootstrap", false)
  .option("--merge-existing", "preserve existing data and merge", false)
  .option("--backup-existing", "backup existing .dsp before bootstrap", false)
  .option("--replace-existing", "replace existing .dsp index", false)
  .option("--json", "machine-readable output", false)
  .action(async (rootDir: string, options) => {
    const resolvedRoot = path.resolve(rootDir);
    const dspDir = path.join(resolvedRoot, ".dsp");
    const dbPath = path.join(dspDir, "dsp.sqlite");
    if (options.backupExisting && fs.existsSync(dspDir)) {
      const backupPath = `${dspDir}.backup.${Date.now()}`;
      fs.cpSync(dspDir, backupPath, { recursive: true });
    }
    if ((options.replaceExisting || options.reset) && fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }

    const services = openDSP(resolvedRoot, adapters());
    try {
      const summary = await runBootstrap(services, {
        largeRepo: options.largeRepo,
        lazy: options.lazy,
        noEmbeddings: options.embeddings === false,
        dryRun: options.dryRun
      });
      const validation = runValidate(services);
      printOutput({ summary, validation }, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("update")
  .argument("[rootDir]", "root directory", ".")
  .option("--from-git-diff", "update from git diff", false)
  .option("--changed-only", "only changed files", false)
  .option("--json", "machine-readable output", false)
  .action(async (rootDir: string, options) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const summary = await runIndex(services, {
        rootDir: services.rootDir,
        fromGitDiff: options.fromGitDiff,
        changedOnly: options.changedOnly
      });
      printOutput(summary, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("changed")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const result = runChanged(services);
      printOutput(result, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("watch")
  .argument("[rootDir]", "root directory", ".")
  .option("--interval-ms <number>", "poll interval in milliseconds", "1000")
  .option("--no-initial-index", "skip the initial full index before watching")
  .action(async (rootDir: string, options: { intervalMs: string; initialIndex?: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      await watchRepository(services, {
        intervalMs: Number(options.intervalMs),
        runInitialIndex: options.initialIndex !== false,
        onCycle: (summary: WatchSummary) => {
          process.stdout.write(`${JSON.stringify(summary)}\n`);
        }
      });
    } finally {
      services.db.close();
    }
  });

program
  .command("explain")
  .argument("<uidOrPath>", "entity uid or path")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((uidOrPath: string, rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const entity = findEntityByUidOrPath(services.db, uidOrPath);
      if (!entity) {
        printOutput({ found: false, uidOrPath }, options.json);
        return;
      }
      const neighbors = getNeighbors(services.db, entity.uid, 1);
      printOutput({ found: true, entity, neighbors }, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("graph")
  .argument("<uidOrPath>", "entity uid or path")
  .argument("[rootDir]", "root directory", ".")
  .option("--depth <number>", "graph depth", "2")
  .option("--max-entities <number>", "maximum graph entities to return")
  .option("--max-relations <number>", "maximum graph relations to return")
  .option("--max-files <number>", "maximum graph files to include")
  .option("--max-estimated-tokens <number>", "maximum estimated graph tokens")
  .option("--json", "machine-readable output", false)
  .action(
    (
      uidOrPath: string,
      rootDir: string,
      options: {
        depth: string;
        maxEntities?: string;
        maxRelations?: string;
        maxFiles?: string;
        maxEstimatedTokens?: string;
        json: boolean;
      }
    ) => {
      const services = openDSP(path.resolve(rootDir), adapters());
      try {
        const entity = findEntityByUidOrPath(services.db, uidOrPath);
        if (!entity) {
          printOutput({ found: false, uidOrPath }, options.json);
          return;
        }
        const graph = getNeighbors(services.db, entity.uid, Number(options.depth), {
          maxEntities: options.maxEntities ? Number(options.maxEntities) : undefined,
          maxRelations: options.maxRelations ? Number(options.maxRelations) : undefined,
          maxFiles: options.maxFiles ? Number(options.maxFiles) : undefined,
          maxEstimatedTokens: options.maxEstimatedTokens ? Number(options.maxEstimatedTokens) : undefined
        });
        printOutput({ root: entity.uid, ...graph }, options.json);
      } finally {
        services.db.close();
      }
    }
  );

program
  .command("get-entity")
  .argument("<uidOrPath>", "entity uid or path")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((uidOrPath: string, rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const entity = findEntityByUidOrPath(services.db, uidOrPath);
      printOutput(entity ? { found: true, entity } : { found: false, uidOrPath }, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("find-by-source")
  .argument("<sourcePath>", "repo-relative source path")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((sourcePath: string, rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const entities = findSourceEntities(services, sourcePath);
      printOutput({ sourcePath, entities }, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("get-children")
  .argument("<uidOrPath>", "entity uid or path")
  .argument("[rootDir]", "root directory", ".")
  .option("--depth <number>", "traversal depth", "1")
  .option("--json", "machine-readable output", false)
  .action((uidOrPath: string, rootDir: string, options: { depth: string; json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const root = requireEntity(services, uidOrPath);
      printOutput(directedTree(services, root, Number(options.depth), "children"), options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("get-parents")
  .argument("<uidOrPath>", "entity uid or path")
  .argument("[rootDir]", "root directory", ".")
  .option("--depth <number>", "traversal depth", "1")
  .option("--json", "machine-readable output", false)
  .action((uidOrPath: string, rootDir: string, options: { depth: string; json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const root = requireEntity(services, uidOrPath);
      printOutput(directedTree(services, root, Number(options.depth), "parents"), options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("get-path")
  .argument("<fromUidOrPath>", "source entity uid or path")
  .argument("<toUidOrPath>", "target entity uid or path")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((fromUidOrPath: string, toUidOrPath: string, rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const from = requireEntity(services, fromUidOrPath);
      const to = requireEntity(services, toUidOrPath);
      const pathResult = shortestPath(services, from.uid, to.uid);
      printOutput({ found: Boolean(pathResult), from: from.uid, to: to.uid, path: pathResult ?? [] }, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("read-toc")
  .argument("[rootDir]", "root directory", ".")
  .option("--protocol", "read .dsp/protocol/TOC if present", false)
  .option("--json", "machine-readable output", false)
  .action((rootDir: string, options: { protocol: boolean; json: boolean }) => {
    const resolvedRoot = path.resolve(rootDir);
    if (options.protocol) {
      const tocPath = path.join(resolvedRoot, ".dsp", "protocol", "TOC");
      const toc = fs.existsSync(tocPath)
        ? fs.readFileSync(tocPath, "utf8").split("\n").map((line) => line.trim()).filter(Boolean)
        : [];
      printOutput({ protocol: true, toc }, options.json);
      return;
    }
    const services = openDSP(resolvedRoot, adapters());
    try {
      const toc = services.db.listEntityUids();
      printOutput({ protocol: false, toc }, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("get-stats")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      printOutput(graphStats(services), options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("detect-cycles")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const cycles = detectCycles(services);
      printOutput({ cycles, count: cycles.length }, options.json);
      process.exitCode = cycles.length > 0 ? 1 : 0;
    } finally {
      services.db.close();
    }
  });

program
  .command("get-orphans")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const result = orphans(services);
      printOutput({ orphans: result, count: result.length }, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("create-object")
  .argument("<source>", "source path or external name")
  .argument("<purpose>", "entity purpose")
  .argument("[rootDir]", "root directory", ".")
  .option("--uid <uid>", "explicit stable UID")
  .option("--kind <kind>", "entity kind", "module")
  .option("--language <language>", "entity language")
  .option("--external", "mark as external dependency", false)
  .option("--json", "machine-readable output", false)
  .action((source: string, purpose: string, rootDir: string, options: { uid?: string; kind: string; language?: string; external: boolean; json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const now = new Date().toISOString();
      const parsed = parseSource(source);
      const entity: Entity = {
        uid: manualUid("obj", options.uid),
        kind: options.external ? "unknown" : entityKindFromOption(options.kind, "module"),
        name: parsed.name,
        path: options.external ? undefined : parsed.path,
        language: options.language,
        description: purpose,
        confidence: 1,
        provenance: manualProvenance(now, "manual create-object"),
        metadata: { external: options.external || undefined, manual: true },
        createdAt: now,
        updatedAt: now
      };
      services.db.upsertEntity(entity);
      printOutput({ created: true, entity }, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("create-function")
  .argument("<source>", "source path#symbol")
  .argument("<purpose>", "function purpose")
  .argument("[rootDir]", "root directory", ".")
  .option("--uid <uid>", "explicit stable UID")
  .option("--owner <uid>", "owning entity UID")
  .option("--kind <kind>", "entity kind", "function")
  .option("--language <language>", "entity language")
  .option("--json", "machine-readable output", false)
  .action((source: string, purpose: string, rootDir: string, options: { uid?: string; owner?: string; kind: string; language?: string; json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const now = new Date().toISOString();
      const parsed = parseSource(source);
      const entity: Entity = {
        uid: manualUid("func", options.uid),
        kind: entityKindFromOption(options.kind, "function"),
        name: parsed.name,
        path: parsed.path,
        language: options.language,
        description: purpose,
        confidence: 1,
        provenance: manualProvenance(now, "manual create-function"),
        metadata: { manual: true, owner: options.owner },
        createdAt: now,
        updatedAt: now
      };
      services.db.upsertEntity(entity);
      if (options.owner) {
        services.db.upsertRelation({
          from: options.owner,
          to: entity.uid,
          kind: "contains",
          confidence: 1,
          provenance: manualProvenance(now, "manual owner contains function")
        });
      }
      printOutput({ created: true, entity }, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("create-shared")
  .argument("<exporterUid>", "exporting entity UID")
  .argument("<sharedUids...>", "shared/exported entity UIDs")
  .option("--root <rootDir>", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((exporterUid: string, sharedUids: string[], options: { root: string; json: boolean }) => {
    const services = openDSP(path.resolve(options.root), adapters());
    try {
      const now = new Date().toISOString();
      for (const sharedUid of sharedUids) {
        services.db.upsertRelation({
          from: exporterUid,
          to: sharedUid,
          kind: "exports",
          confidence: 1,
          provenance: manualProvenance(now, "manual create-shared")
        });
      }
      printOutput({ exporterUid, sharedUids, created: sharedUids.length }, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("add-import")
  .argument("<importerUid>", "importing entity UID")
  .argument("<importedUid>", "imported entity UID")
  .argument("<why>", "reason for import")
  .argument("[rootDir]", "root directory", ".")
  .option("--kind <kind>", "relation kind", "imports")
  .option("--exporter <uid>", "exporter/provider UID metadata")
  .option("--json", "machine-readable output", false)
  .action((importerUid: string, importedUid: string, why: string, rootDir: string, options: { kind: string; exporter?: string; json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const now = new Date().toISOString();
      const relation = {
        from: importerUid,
        to: importedUid,
        kind: relationKindFromOption(options.kind, "imports"),
        reason: why,
        confidence: 1,
        provenance: manualProvenance(now, "manual add-import"),
        metadata: { exporter: options.exporter }
      };
      services.db.upsertRelation(relation);
      printOutput({ added: true, relation }, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("update-description")
  .argument("<uid>", "entity UID")
  .argument("[rootDir]", "root directory", ".")
  .option("--purpose <purpose>", "new purpose/description")
  .option("--source <source>", "new source path or path#symbol")
  .option("--kind <kind>", "new entity kind")
  .option("--json", "machine-readable output", false)
  .action((uid: string, rootDir: string, options: { purpose?: string; source?: string; kind?: string; json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const existing = services.db.getEntity(uid);
      if (!existing) {
        printOutput({ updated: false, reason: "not_found", uid }, options.json);
        return;
      }
      const parsed = options.source ? parseSource(options.source) : undefined;
      const updated: Entity = {
        ...existing,
        kind: options.kind ? entityKindFromOption(options.kind, existing.kind) : existing.kind,
        name: parsed?.name ?? existing.name,
        path: parsed?.path ?? existing.path,
        description: options.purpose ?? existing.description,
        provenance: [...existing.provenance, ...manualProvenance(new Date().toISOString(), "manual update-description")],
        updatedAt: new Date().toISOString()
      };
      services.db.upsertEntity(updated);
      printOutput({ updated: true, entity: updated }, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("update-import-why")
  .argument("<importerUid>", "importing entity UID")
  .argument("<importedUid>", "imported entity UID")
  .argument("<why>", "new reason")
  .argument("[rootDir]", "root directory", ".")
  .option("--kind <kind>", "relation kind", "imports")
  .option("--json", "machine-readable output", false)
  .action((importerUid: string, importedUid: string, why: string, rootDir: string, options: { kind: string; json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const now = new Date().toISOString();
      const relation = {
        from: importerUid,
        to: importedUid,
        kind: relationKindFromOption(options.kind, "imports"),
        reason: why,
        confidence: 1,
        provenance: manualProvenance(now, "manual update-import-why")
      };
      services.db.upsertRelation(relation);
      printOutput({ updated: true, relation }, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("move-entity")
  .argument("<uid>", "entity UID")
  .argument("<newSource>", "new source path or path#symbol")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((uid: string, newSource: string, rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const existing = services.db.getEntity(uid);
      if (!existing) {
        printOutput({ moved: false, reason: "not_found", uid }, options.json);
        return;
      }
      const parsed = parseSource(newSource);
      const updated = { ...existing, path: parsed.path, name: parsed.name, updatedAt: new Date().toISOString() };
      services.db.upsertEntity(updated);
      printOutput({ moved: true, entity: updated }, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("remove-import")
  .argument("<importerUid>", "importing entity UID")
  .argument("<importedUid>", "imported entity UID")
  .argument("[rootDir]", "root directory", ".")
  .option("--kind <kind>", "relation kind", "imports")
  .option("--json", "machine-readable output", false)
  .action((importerUid: string, importedUid: string, rootDir: string, options: { kind: string; json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const removed = services.db.deleteRelation(importerUid, importedUid, relationKindFromOption(options.kind, "imports"));
      printOutput({ removed }, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("remove-shared")
  .argument("<exporterUid>", "exporting entity UID")
  .argument("<sharedUid>", "shared/exported entity UID")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((exporterUid: string, sharedUid: string, rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const removed = services.db.deleteRelation(exporterUid, sharedUid, "exports");
      printOutput({ removed }, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("remove-entity")
  .argument("<uid>", "entity UID")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((uid: string, rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const removed = services.db.deleteEntity(uid);
      printOutput({ removed, uid }, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("search")
  .argument("<query>", "search query")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .option("--top-k <number>", "number of results", "20")
  .action(async (query: string, rootDir: string, options: { json: boolean; topK: string }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const result = await runSearch(services, query, { topK: Number(options.topK) });
      printOutput(result, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("impact")
  .argument("<uidOrPath>", "target uid or path")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((uidOrPath: string, rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const result = runImpact(services, uidOrPath);
      printOutput(result, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("validate")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const result = runValidate(services);
      printOutput(result, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("doctor")
  .argument("[rootDir]", "root directory", ".")
  .option("--deep", "include graph validation in the report", false)
  .option("--json", "machine-readable output", false)
  .action((rootDir: string, options: { deep: boolean; json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const report = {
        db: services.db.doctor(),
        ...(options.deep ? { validation: runValidate(services) } : {})
      };
      printOutput(report, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("repair")
  .argument("[rootDir]", "root directory", ".")
  .option("--dry-run", "show planned repairs without writing", false)
  .option("--json", "machine-readable output", false)
  .action(async (rootDir: string, options: { dryRun: boolean; json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const result = await runRepair(services, { dryRun: options.dryRun });
      printOutput(result, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("export")
  .argument("[rootDir]", "root directory", ".")
  .option("--format <format>", "json, jsonl, dsp, or protocol", "json")
  .option("--output <path>", "output path")
  .option("--json", "machine-readable output", false)
  .action((rootDir: string, options: { format: "json" | "jsonl" | "dsp" | "protocol"; output?: string; json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const result = runExport(services, options.format, options.output);
      printOutput(result, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("import")
  .argument("<jsonPath>", "graph json path")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((jsonPath: string, rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const result = runImport(services, path.resolve(jsonPath));
      printOutput(result, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("mcp")
  .argument("[rootDir]", "root directory", ".")
  .action(async (rootDir: string) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    await startMcpServer(services);
  });

program
  .command("precommit-check")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action(async (rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const changed = runChanged(services);
      const impacts = changed.map((target) => runImpact(services, target));
      const validation = runValidate(services);
      printOutput({ changed, impacts, validation }, options.json);
    } finally {
      services.db.close();
    }
  });

const ci = program.command("ci").description("CI helpers");
const cache = program.command("cache").description("Cache utilities");
const embeddings = program.command("embeddings").description("Embeddings utilities");
const markers = program.command("markers").description("Stable UID source marker utilities");

markers
  .command("apply")
  .argument("[rootDir]", "root directory", ".")
  .option("--dry-run", "show what would be changed without writing", false)
  .option("--json", "machine-readable output", false)
  .action((rootDir: string, options: { dryRun: boolean; json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const result = runMarkersApply(services, { dryRun: options.dryRun });
      printOutput(result, options.json);
    } finally {
      services.db.close();
    }
  });

cache
  .command("stats")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      printOutput(services.db.cacheStats(), options.json);
    } finally {
      services.db.close();
    }
  });

embeddings
  .command("update")
  .argument("[rootDir]", "root directory", ".")
  .option("--changed-only", "embed only changed entities", false)
  .option("--json", "machine-readable output", false)
  .action(async (rootDir: string, options: { changedOnly: boolean; json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const result = await runEmbeddingsUpdate(services, {
        changedOnly: options.changedOnly
      });
      printOutput(result, options.json);
    } finally {
      services.db.close();
    }
  });

embeddings
  .command("stats")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      printOutput(services.db.embeddingStats(), options.json);
    } finally {
      services.db.close();
    }
  });

cache
  .command("clear")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      services.db.clearCache();
      printOutput({ cleared: true }, options.json);
    } finally {
      services.db.close();
    }
  });

ci
  .command("check")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", true)
  .action((rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const validation = runValidate(services);
      printOutput(validation, options.json);
      process.exitCode = validation.ok ? 0 : 1;
    } finally {
      services.db.close();
    }
  });

ci
  .command("impact")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", true)
  .action((rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const changed = runChanged(services);
      const impacts = changed.map((target) => runImpact(services, target));
      printOutput({ changed, impacts }, options.json);
    } finally {
      services.db.close();
    }
  });

ci
  .command("context-summary")
  .argument("[rootDir]", "root directory", ".")
  .option("--task <task>", "task description", "Review changes")
  .option("--json", "machine-readable output", true)
  .action(async (rootDir: string, options: { task: string; json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const pack = await runContextPack(services, {
        task: options.task,
        strategy: "minimal",
        maxTokens: 4000,
        includeCode: "snippets-only",
        includeTests: true
      });
      printOutput(pack, options.json);
    } finally {
      services.db.close();
    }
  });

export { program };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  program.parseAsync(process.argv);
}
