import fs from "node:fs";
import path from "node:path";
import type { DSPDatabase } from "../storage/db.ts";
import type { DSPConfig } from "../config/types.ts";
import type { LanguageAdapter, RepairAction, RepairResult, ValidationIssue } from "../graph/types.ts";
import { indexRepository } from "../indexer/indexer.ts";
import { validateGraph } from "./validate.ts";

type RepairOptions = {
  dryRun?: boolean;
};

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

export async function repairGraph(
  db: DSPDatabase,
  rootDir: string,
  adapters: LanguageAdapter[],
  config: DSPConfig,
  options: RepairOptions = {}
): Promise<RepairResult> {
  const dryRun = options.dryRun ?? false;
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
