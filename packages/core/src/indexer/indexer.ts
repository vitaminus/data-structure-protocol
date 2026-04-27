import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type {
  Entity,
  FileIndexRequest,
  IndexSummary,
  LanguageAdapter,
  Relation,
  UnresolvedReference
} from "../graph/types.js";
import { buildUid, contentHash, normalizePath, stableNowIso } from "../graph/uid.js";
import { discoverFiles, findRepoRoot } from "../util/fs.js";
import { changedFileEntriesFromGit, changedFilesFromGit } from "../util/git.js";
import type { DSPDatabase } from "../storage/db.js";
import type { DSPConfig } from "../config/types.js";

function languageFromFile(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    return "typescript";
  }
  if (ext === ".py") {
    return "python";
  }
  if (ext === ".rs") {
    return "rust";
  }
  if (ext === ".rb") {
    return "ruby";
  }
  return undefined;
}

function isTestPath(filePath: string): boolean {
  const normalized = normalizePath(filePath).toLowerCase();
  return (
    normalized.includes("/test/") ||
    normalized.includes("/tests/") ||
    normalized.endsWith(".test.ts") ||
    normalized.endsWith(".spec.ts") ||
    normalized.endsWith("_test.py") ||
    normalized.endsWith("_spec.rb")
  );
}

function fileEntity(relPath: string, language: string, nowIso: string): Entity {
  return {
    uid: buildUid("file", relPath),
    kind: "file",
    name: path.basename(relPath),
    path: relPath,
    language,
    confidence: 1,
    provenance: [
      {
        source: "ast",
        tool: "dsp-indexer",
        confidence: 1,
        timestamp: nowIso,
        evidence: "discovered file"
      }
    ],
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

function testEntityForFile(relPath: string, nowIso: string): Entity | undefined {
  if (!isTestPath(relPath)) {
    return undefined;
  }
  return {
    uid: buildUid("test", relPath),
    kind: "test",
    name: path.basename(relPath),
    path: relPath,
    confidence: 0.85,
    provenance: [
      {
        source: "test",
        tool: "dsp-indexer",
        confidence: 0.85,
        timestamp: nowIso,
        evidence: "test naming heuristic"
      }
    ],
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

function dirEntitiesForFile(relPath: string, nowIso: string): Entity[] {
  const normalized = normalizePath(relPath);
  const parts = normalized.split("/");
  const entities: Entity[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    const dir = parts.slice(0, i).join("/");
    entities.push({
      uid: buildUid("directory", dir),
      kind: "directory",
      name: parts[i - 1],
      path: dir,
      confidence: 1,
      provenance: [
        {
          source: "ast",
          tool: "dsp-indexer",
          timestamp: nowIso,
          confidence: 1,
          evidence: "derived from path"
        }
      ],
      createdAt: nowIso,
      updatedAt: nowIso
    });
  }
  return entities;
}

function containsRelations(fileUid: string, entities: Entity[], nowIso: string): Relation[] {
  return entities
    .filter((entity) => entity.uid !== fileUid)
    .map((entity) => ({
      from: fileUid,
      to: entity.uid,
      kind: "contains" as const,
      confidence: 1,
      provenance: [
        {
          source: "ast",
          tool: "dsp-indexer",
          timestamp: nowIso,
          confidence: 1
        }
      ]
    }));
}

function filePathFromFileUid(uid: string): string | undefined {
  if (!uid.startsWith("file:") || uid.includes("#")) {
    return undefined;
  }
  return uid.slice("file:".length);
}

function pathCandidates(targetRelPath: string, fromRelPath?: string): string[] {
  const normalizedTarget = normalizePath(targetRelPath);
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".rs"];
  const candidates: string[] = [];
  const addVariants = (candidate: string) => {
    const normalized = normalizePath(path.posix.normalize(candidate));
    candidates.push(normalized);
    if (!path.posix.extname(normalized)) {
      for (const ext of extensions) {
        candidates.push(`${normalized}${ext}`);
      }
      for (const ext of extensions) {
        candidates.push(`${normalized}/index${ext}`);
      }
      candidates.push(`${normalized}/mod.rs`);
    }
  };

  addVariants(normalizedTarget);
  if (fromRelPath && !normalizedTarget.includes("/")) {
    addVariants(path.posix.join(path.posix.dirname(fromRelPath), normalizedTarget));
  }

  return [...new Set(candidates)];
}

function canonicalFilePath(
  targetRelPath: string,
  fromRelPath: string | undefined,
  availableFiles: Set<string>
): string | undefined {
  return pathCandidates(targetRelPath, fromRelPath).find((candidate) => availableFiles.has(candidate));
}

function canonicalizeFileRelations(relations: Relation[], availableFiles: Set<string>): Relation[] {
  return relations.map((relation) => {
    const targetRelPath = filePathFromFileUid(relation.to);
    if (!targetRelPath) {
      return relation;
    }
    const fromRelPath = filePathFromFileUid(relation.from);
    const resolvedPath = canonicalFilePath(targetRelPath, fromRelPath, availableFiles);
    if (!resolvedPath || resolvedPath === targetRelPath) {
      return relation;
    }
    return {
      ...relation,
      to: buildUid("file", resolvedPath),
      metadata: {
        ...(relation.metadata ?? {}),
        resolvedPath
      }
    };
  });
}

export async function indexRepository(
  db: DSPDatabase,
  adapters: LanguageAdapter[],
  request: FileIndexRequest,
  config: DSPConfig
): Promise<IndexSummary> {
  const scanRoot = path.resolve(request.rootDir);
  const repoRoot = findRepoRoot(scanRoot);
  const now = stableNowIso();
  const runId = db.beginRun(request.fromGitDiff ? "update-git-diff" : "index", now);
  let filesIndexed = 0;
  let filesSkipped = 0;
  const languageSet = new Set<string>();
  let entityCount = 0;
  let relationCount = 0;
  let unresolvedCount = 0;
  let lowConfidenceCount = 0;

  try {
    const discovered = discoverFiles(scanRoot, {
      excludes: config.performance.exclude,
      maxFileSizeKb: config.performance.maxFileSizeKb
    });
    const availableRelPaths = new Set(
      discovered.map((absPath) => normalizePath(path.relative(scanRoot, absPath)))
    );
    const requestedFiles = request.files?.map((file) => path.resolve(scanRoot, file));
    const changedEntries =
      request.fromGitDiff || request.changedOnly
        ? changedFileEntriesFromGit(repoRoot).filter((entry) => {
            const paths = [entry.path, entry.oldPath].filter(Boolean) as string[];
            return paths.some((file) => file === scanRoot || file.startsWith(`${scanRoot}${path.sep}`));
          })
        : undefined;
    const changedFromGit = changedEntries?.map((entry) => entry.path);

    if (changedEntries) {
      db.transaction(() => {
        for (const entry of changedEntries) {
          const stalePaths = [
            ...(entry.oldPath && entry.oldPath !== entry.path ? [entry.oldPath] : []),
            ...(!existsSync(entry.path) || entry.status.startsWith("D") ? [entry.path] : [])
          ];
          for (const stalePath of stalePaths) {
            if (stalePath === scanRoot || !stalePath.startsWith(`${scanRoot}${path.sep}`)) {
              continue;
            }
            const relPath = normalizePath(path.relative(scanRoot, stalePath));
            db.clearAstDataForPath(relPath);
            db.removeFileHash(relPath);
          }
        }
      });
    }

    let selectedFiles = discovered.filter((absPath) => {
      if (requestedFiles && requestedFiles.length > 0) {
        return requestedFiles.includes(absPath);
      }
      if (changedFromGit) {
        return changedFromGit.includes(absPath);
      }
      return true;
    });

    if (changedFromGit && changedFromGit.length > 0) {
      const changedUids = changedFromGit.map((absPath) =>
        buildUid("file", normalizePath(path.relative(scanRoot, absPath)))
      );
      const neighborRelPaths = new Set<string>();
      for (const uid of changedUids) {
        for (const incoming of db.getRelationsTo(uid)) {
          const fromEntity = db.getEntity(incoming.from);
          if (fromEntity?.path) {
            neighborRelPaths.add(fromEntity.path);
          }
        }
      }
      for (const relPath of neighborRelPaths) {
        selectedFiles.push(path.resolve(scanRoot, relPath));
      }
      selectedFiles = [...new Set(selectedFiles)];
    }

    for (const absPath of selectedFiles) {
      const relPath = normalizePath(path.relative(scanRoot, absPath));
      const language = languageFromFile(relPath);
      if (!language) {
        filesSkipped += 1;
        continue;
      }
      const adapter = adapters.find((candidate) => candidate.canHandle(relPath));
      if (!adapter) {
        filesSkipped += 1;
        continue;
      }
      languageSet.add(adapter.language);
      const content = readFileSync(absPath, "utf8");
      const hash = contentHash(content);
      const oldHash = db.getFileHash(relPath);
      if (!request.full && oldHash === hash) {
        filesSkipped += 1;
        continue;
      }

      const parsed = await adapter.parseFile(relPath, content);
      const extractedEntities = adapter.extractEntities(parsed);
      const extractedRelations = canonicalizeFileRelations(
        adapter.extractRelations(parsed, extractedEntities),
        availableRelPaths
      );
      const unresolved = parsed.unresolvedReferences ?? [];
      const nowIso = stableNowIso();

      const fileNode = fileEntity(relPath, adapter.language, nowIso);
      const testNode = testEntityForFile(relPath, nowIso);
      const directories = dirEntitiesForFile(relPath, nowIso);
      const allEntities = [fileNode, ...directories, ...(testNode ? [testNode] : []), ...extractedEntities];
      const allRelations = [
        ...containsRelations(fileNode.uid, allEntities, nowIso),
        ...extractedRelations,
        ...(testNode
          ? [
              {
                from: testNode.uid,
                to: fileNode.uid,
                kind: "tests" as const,
                confidence: 0.85,
                provenance: [
                  {
                    source: "test" as const,
                    tool: "dsp-indexer",
                    confidence: 0.85,
                    timestamp: nowIso,
                    evidence: "test file relation"
                  }
                ]
              }
            ]
          : [])
      ];

      db.transaction(() => {
        db.clearAstDataForPath(relPath);
        for (const entity of allEntities) {
          db.upsertEntity(entity);
        }
        for (const relation of allRelations) {
          db.upsertRelation(relation);
        }
        for (const ref of unresolved) {
          db.upsertUnresolvedReference(ref, nowIso);
        }
        db.markFileHash(relPath, hash, nowIso);
      });

      for (const relation of allRelations) {
        if (relation.confidence < 0.4) {
          lowConfidenceCount += 1;
        }
      }

      filesIndexed += 1;
      entityCount += allEntities.length;
      relationCount += allRelations.length;
      unresolvedCount += unresolved.length;
    }

    const allFiles = filesIndexed + filesSkipped;
    const estimatedCoverage = allFiles === 0 ? 0 : filesIndexed / allFiles;
    const summary: IndexSummary = {
      mode: request.fromGitDiff ? "update" : "index",
      filesScanned: allFiles,
      filesIndexed,
      filesSkipped,
      languages: [...languageSet].sort(),
      entities: entityCount,
      relations: relationCount,
      unresolvedReferences: unresolvedCount,
      lowConfidenceRelations: lowConfidenceCount,
      estimatedCoverage
    };
    db.finishRun(runId, "ok", stableNowIso(), summary);
    return summary;
  } catch (error) {
    db.finishRun(runId, "failed", stableNowIso(), {
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

export async function bootstrapRepository(
  db: DSPDatabase,
  adapters: LanguageAdapter[],
  rootDir: string,
  config: DSPConfig,
  options: {
    lazy?: boolean;
    noEmbeddings?: boolean;
    dryRun?: boolean;
    largeRepo?: boolean;
  } = {}
): Promise<IndexSummary> {
  if (options.largeRepo) {
    config.performance.mode = "large-repo";
    config.performance.lazyIndexing = true;
  }
  if (options.dryRun) {
    const discovered = discoverFiles(rootDir, {
      excludes: config.performance.exclude,
      maxFileSizeKb: config.performance.maxFileSizeKb
    });
    return {
      mode: "bootstrap",
      filesScanned: discovered.length,
      filesIndexed: 0,
      filesSkipped: discovered.length,
      languages: [],
      entities: 0,
      relations: 0,
      unresolvedReferences: 0,
      lowConfidenceRelations: 0,
      estimatedCoverage: 0
    };
  }
  const summary = await indexRepository(
    db,
    adapters,
    {
      rootDir,
      lazy: options.lazy ?? config.performance.lazyIndexing,
      full: true
    },
    config
  );
  return {
    ...summary,
    mode: "bootstrap"
  };
}

export function changedFiles(db: DSPDatabase, rootDir: string): string[] {
  const scanRoot = path.resolve(rootDir);
  const repoRoot = findRepoRoot(scanRoot);
  const gitChanged = changedFilesFromGit(repoRoot).filter((file) => {
    if (file === scanRoot) {
      return true;
    }
    return file.startsWith(`${scanRoot}${path.sep}`);
  });
  const indexed = new Set(db.listFilesInHashTable());
  return gitChanged
    .map((file) => normalizePath(path.relative(scanRoot, file)))
    .filter((rel) => indexed.has(rel));
}
