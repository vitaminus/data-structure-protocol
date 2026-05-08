import path from "node:path";
import { readFileSync } from "node:fs";
import type { DSPDatabase } from "../storage/db.ts";
import type { ValidationIssue, ValidationResult, ValidationSeverity } from "../graph/types.ts";
import { contentHash } from "../graph/uid.ts";

function severityForIssue(kind: ValidationIssue["kind"]): ValidationSeverity {
  switch (kind) {
    case "missing_file":
    case "dangling_relation":
      return "error";
    case "stale_hash":
    case "unresolved_reference":
    case "low_confidence_critical":
    case "annotation_conflict":
      return "warning";
    default:
      return "info";
  }
}

function withSeverity(issue: Omit<ValidationIssue, "severity">): ValidationIssue {
  return {
    severity: severityForIssue(issue.kind),
    ...issue
  };
}

export function validateGraph(db: DSPDatabase, rootDir: string): ValidationResult {
  const issues: ValidationIssue[] = [];
  const danglingRelations = db.getDanglingRelations(600000);
  const lowConfidenceRelations = db.getLowConfidenceCriticalRelations(600000);
  const unresolved = db.getUnresolvedReferences();

  for (const entity of db.iterateFileEntitiesOrdered()) {
    if (!entity.path) {
      continue;
    }
    const absPath = path.join(rootDir, entity.path);
    try {
      const content = readFileSync(absPath, "utf8");
      const currentHash = contentHash(content);
      const indexedHash = db.getFileHash(entity.path);
      if (indexedHash && indexedHash !== currentHash) {
        issues.push(
          withSeverity({
            kind: "stale_hash",
            uid: entity.uid,
            path: entity.path,
            message: `File hash changed since last index: ${entity.path}`
          })
        );
      }
    } catch {
      issues.push(
        withSeverity({
          kind: "missing_file",
          uid: entity.uid,
          path: entity.path,
          message: `Indexed file no longer exists: ${entity.path}`
        })
      );
    }
  }

  for (const relation of danglingRelations) {
    issues.push(
      withSeverity({
        kind: "dangling_relation",
        relation: { from: relation.from, to: relation.to, kind: relation.kind },
        message: `Relation has missing endpoint: ${relation.from} -> ${relation.to}`
      })
    );
  }

  for (const relation of lowConfidenceRelations) {
    issues.push(
      withSeverity({
        kind: "low_confidence_critical",
        relation: { from: relation.from, to: relation.to, kind: relation.kind },
        confidence: relation.confidence,
        message: `Low confidence on critical relation ${relation.kind}: ${relation.from} -> ${relation.to}`
      })
    );
  }

  for (const ref of unresolved) {
    issues.push(
      withSeverity({
        kind: "unresolved_reference",
        path: ref.path,
        uid: ref.fromUid,
        confidence: ref.confidence,
        message: `Unresolved ${ref.kind}: ${ref.symbol} (${ref.path})`
      })
    );
  }

  const annotationConflicts = [...db.iterateEntitiesOrdered()].filter((entity) => {
    const sources = new Set(entity.provenance.map((provenance) => provenance.source));
    return sources.has("human") && sources.has("ast") && entity.confidence < 0.5;
  });
  for (const entity of annotationConflicts) {
    issues.push(
      withSeverity({
        kind: "annotation_conflict",
        uid: entity.uid,
        path: entity.path,
        message: `Potential human/AST conflict on ${entity.uid}`
      })
    );
  }

  const summary = {
    total: issues.length,
    errors: issues.filter((issue) => issue.severity === "error").length,
    warnings: issues.filter((issue) => issue.severity === "warning").length,
    info: issues.filter((issue) => issue.severity === "info").length
  };

  return {
    ok: issues.length === 0,
    issues,
    summary
  };
}
