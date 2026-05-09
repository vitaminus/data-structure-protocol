import fs from "node:fs";
import path from "node:path";
import type { DSPDatabase } from "../storage/db.ts";
import type { DSPConfig } from "../config/types.ts";
import {
  type LanguageAdapter,
  type RepairAction,
  type RepairActionKind,
  type RepairOptions,
  type RepairResult,
  type ValidationIssue
} from "../graph/types.ts";
import { stableNowIso } from "../graph/uid.ts";
import { indexRepository } from "../indexer/indexer.ts";
import { validateGraph } from "./validate.ts";

function actionForIssue(issue: ValidationIssue, status: RepairAction["status"], message: string): RepairAction {
  return {
    kind: issue.kind,
    status,
    message,
    path: issue.path,
    uid: issue.uid,
    relation: issue.relation
  };
}

function actionForKind(
  kind: RepairActionKind,
  status: RepairAction["status"],
  message: string,
  extra: Partial<RepairAction> = {}
): RepairAction {
  return {
    kind,
    status,
    message,
    ...extra
  };
}

export async function repairGraph(
  db: DSPDatabase,
  rootDir: string,
  adapters: LanguageAdapter[],
  config: DSPConfig,
  options: RepairOptions = {}
): Promise<RepairResult> {
  const dryRun = options.apply ? false : (options.dryRun ?? true);
  const validationBefore = validateGraph(db, rootDir);
  const actions: RepairAction[] = [];
  const reindexPaths = new Set<string>();

  for (const issue of validationBefore.issues) {
    switch (issue.kind) {
      case "missing_file": {
        if (!issue.path) {
          actions.push(actionForIssue(issue, "skipped", "Missing file issue has no path."));
          break;
        }
        actions.push(actionForIssue(issue, dryRun ? "planned" : "applied", `Clear stale graph data for ${issue.path}.`));
        if (!dryRun) {
          db.transaction(() => {
            db.clearAstDataForPath(issue.path!);
            db.removeFileHash(issue.path!);
          });
        }
        break;
      }
      case "stale_hash":
      case "unresolved_reference": {
        if (!issue.path) {
          actions.push(actionForIssue(issue, "skipped", `${issue.kind} issue has no path.`));
          break;
        }
        const absPath = path.resolve(rootDir, issue.path);
        if (!fs.existsSync(absPath)) {
          actions.push(actionForIssue(issue, "skipped", `Cannot reindex missing file ${issue.path}.`));
          break;
        }
        reindexPaths.add(issue.path);
        actions.push(actionForIssue(issue, dryRun ? "planned" : "applied", `Reindex ${issue.path}.`));
        break;
      }
      case "dangling_relation": {
        if (!issue.relation) {
          actions.push(actionForIssue(issue, "skipped", "Dangling relation issue has no relation payload."));
          break;
        }
        actions.push(
          actionForIssue(
            issue,
            dryRun ? "planned" : "applied",
            `Delete dangling relation ${issue.relation.from} -> ${issue.relation.to}.`
          )
        );
        if (!dryRun) {
          db.deleteRelation(issue.relation.from, issue.relation.to, issue.relation.kind);
        }
        break;
      }
      default:
        actions.push(actionForIssue(issue, "skipped", `No automatic repair for ${issue.kind}.`));
        break;
    }
  }

  const operationalLimit = 10000;
  if (options.cleanOrphanedFileHashes) {
    const orphanedFileHashes = db.getOrphanedFileHashes(operationalLimit);
    for (const filePath of orphanedFileHashes) {
      actions.push(
        actionForKind(
          "orphaned_file_hash",
          dryRun ? "planned" : "applied",
          `Remove orphaned file hash for ${filePath}.`,
          { path: filePath }
        )
      );
    }
    if (!dryRun) {
      db.removeFileHashes(orphanedFileHashes);
    }
  }

  if (options.cleanOrphanedEmbeddings) {
    const orphanedEmbeddings = db.getOrphanedEmbeddings(operationalLimit);
    for (const uid of orphanedEmbeddings) {
      actions.push(
        actionForKind(
          "orphaned_embedding",
          dryRun ? "planned" : "applied",
          `Remove orphaned embedding for ${uid}.`,
          { uid }
        )
      );
    }
    if (!dryRun) {
      db.removeEmbeddings(orphanedEmbeddings);
    }
  }

  if (options.cleanStaleParseCache) {
    const staleParseCachePaths = db.getStaleParseCachePaths(operationalLimit);
    const corruptedParseCacheEntries = db.getCorruptedParseCacheRows(operationalLimit);
    for (const filePath of staleParseCachePaths) {
      actions.push(
        actionForKind(
          "stale_parse_cache",
          dryRun ? "planned" : "applied",
          `Remove stale parse-cache rows for ${filePath}.`,
          { path: filePath }
        )
      );
    }
    for (const entry of corruptedParseCacheEntries) {
      actions.push(
        actionForKind(
          "stale_parse_cache",
          dryRun ? "planned" : "applied",
          `Remove corrupted parse-cache row for ${entry.filePath} (${entry.language}).`,
          { path: entry.filePath }
        )
      );
    }
    if (!dryRun) {
      db.removeParseCachePaths(staleParseCachePaths);
      db.removeParseCacheEntries(corruptedParseCacheEntries);
    }
  }

  if (options.clearStaleCheckpoints) {
    const staleCheckpoints = db.getStaleCheckpoints(operationalLimit);
    const corruptedCheckpoints = db.getCorruptedCheckpoints(operationalLimit);
    for (const checkpoint of staleCheckpoints) {
      actions.push(
        actionForKind(
          "stale_checkpoint",
          dryRun ? "planned" : "applied",
          `Clear stale checkpoint ${checkpoint.name}.`,
          { path: checkpoint.name }
        )
      );
    }
    for (const checkpointName of corruptedCheckpoints) {
      actions.push(
        actionForKind(
          "stale_checkpoint",
          dryRun ? "planned" : "applied",
          `Clear corrupted checkpoint ${checkpointName}.`,
          { path: checkpointName }
        )
      );
    }
    if (!dryRun) {
      db.clearCheckpoints([
        ...new Set([...staleCheckpoints.map((checkpoint) => checkpoint.name), ...corruptedCheckpoints])
      ]);
    }
  }

  if (options.failAbandonedRuns) {
    const abandonedRuns = db.getAbandonedIndexRuns(operationalLimit);
    for (const run of abandonedRuns) {
      actions.push(
        actionForKind(
          "abandoned_run",
          dryRun ? "planned" : "applied",
          `Mark abandoned index run ${run.id} (${run.mode}) as failed.`,
          { uid: String(run.id) }
        )
      );
    }
    if (!dryRun) {
      db.markIndexRunsFailed(
        abandonedRuns.map((run) => run.id),
        stableNowIso(),
        "marked failed during repair"
      );
    }
  }

  if (!dryRun && reindexPaths.size > 0) {
    await indexRepository(
      db,
      adapters,
      {
        rootDir,
        files: [...reindexPaths],
        full: true
      },
      config
    );
  }

  const validationAfter = dryRun ? undefined : validateGraph(db, rootDir).summary;
  return {
    dryRun,
    actions,
    validationBefore: validationBefore.summary,
    ...(validationAfter ? { validationAfter } : {})
  };
}
