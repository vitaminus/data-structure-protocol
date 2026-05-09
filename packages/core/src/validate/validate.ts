import path from "node:path";
import { statSync } from "node:fs";
import type { DSPDatabase } from "../storage/db.ts";
import type { ValidationIssue, ValidationOptions, ValidationResult, ValidationSeverity } from "../graph/types.ts";
import { contentHash } from "../graph/uid.ts";
import { readUtf8FileSafe } from "../util/text.ts";

function severityForIssue(kind: ValidationIssue["kind"]): ValidationSeverity {
  switch (kind) {
    case "missing_file":
    case "dangling_relation":
      return "error";
    case "stale_hash":
    case "binary_file":
    case "invalid_utf8":
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

export function validateGraph(
  db: DSPDatabase,
  rootDir: string,
  options: ValidationOptions = {}
): ValidationResult {
  const changedOnly = options.changedOnly ?? false;
  const deep = options.deep ?? true;
  const issues: ValidationIssue[] = [];
  const changedPaths = new Set<string>();
  const affectedUids = new Set<string>();

  for (const entity of db.iterateFileEntitiesOrdered()) {
    if (!entity.path) {
      continue;
    }
    const absPath = path.join(rootDir, entity.path);
    const indexedHash = db.getFileHashEntry(entity.path);
    try {
      const stat = statSync(absPath);
      const currentMtimeMs = Math.trunc(stat.mtimeMs);
      const currentSizeBytes = stat.size;
      const matchesCachedState =
        indexedHash?.mtimeMs !== undefined &&
        indexedHash?.sizeBytes !== undefined &&
        indexedHash.mtimeMs === currentMtimeMs &&
        indexedHash.sizeBytes === currentSizeBytes;
      if (matchesCachedState) {
        continue;
      }
      changedPaths.add(entity.path);
      affectedUids.add(entity.uid);
      for (const nested of db.findEntitiesByPath(entity.path)) {
        affectedUids.add(nested.uid);
      }
      const fileContent = readUtf8FileSafe(absPath);
      if (fileContent.kind === "binary") {
        issues.push(
          withSeverity({
            kind: "binary_file",
            uid: entity.uid,
            path: entity.path,
            message: `Indexed file is binary and cannot be validated as UTF-8 text: ${entity.path}`
          })
        );
        continue;
      }
      if (fileContent.kind === "invalidUtf8") {
        issues.push(
          withSeverity({
            kind: "invalid_utf8",
            uid: entity.uid,
            path: entity.path,
            message: `Indexed file is not valid UTF-8 text: ${entity.path}`
          })
        );
        continue;
      }
      const currentHash = contentHash(fileContent.kind === "text" ? fileContent.content : "");
      if (indexedHash?.hash && indexedHash.hash !== currentHash) {
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
      changedPaths.add(entity.path);
      affectedUids.add(entity.uid);
      for (const nested of db.findEntitiesByPath(entity.path)) {
        affectedUids.add(nested.uid);
      }
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

  if (deep) {
    const relationTouchesAffected = (from: string, to: string): boolean =>
      !changedOnly || changedPaths.size === 0 || affectedUids.has(from) || affectedUids.has(to);
    const danglingRelations = db
      .getDanglingRelations(600000)
      .filter((relation) => relationTouchesAffected(relation.from, relation.to));
    const lowConfidenceRelations = db
      .getLowConfidenceCriticalRelations(600000)
      .filter((relation) => relationTouchesAffected(relation.from, relation.to));
    const unresolved = db
      .getUnresolvedReferences()
      .filter((ref) => !changedOnly || changedPaths.size === 0 || changedPaths.has(ref.path));

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
      if (changedOnly && changedPaths.size > 0) {
        const entityPath = entity.path ?? "";
        if (!changedPaths.has(entityPath)) {
          return false;
        }
      }
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
