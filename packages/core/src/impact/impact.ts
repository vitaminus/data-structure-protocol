import type { DSPDatabase } from "../storage/db.ts";
import type { ImpactResult, RelationKind } from "../graph/types.ts";
import { buildUid, normalizePath } from "../graph/uid.ts";

const IMPACT_KINDS: Set<RelationKind> = new Set([
  "imports",
  "depends_on",
  "calls",
  "uses",
  "tests",
  "routes_to",
  "exports"
]);

export function resolveTargetUid(target: string): string {
  if (target.includes(":") || /^(?:obj|func)-[0-9a-fA-F]{8}$/.test(target)) {
    return target;
  }
  return buildUid("file", normalizePath(target));
}

export function analyzeImpact(db: DSPDatabase, target: string): ImpactResult {
  const targetUid = resolveTargetUid(target);
  const directRelations = db
    .getRelationsTo(targetUid)
    .filter((relation) => IMPACT_KINDS.has(relation.kind));
  const direct = [...new Set(directRelations.map((relation) => relation.from))];

  const visited = new Set<string>([targetUid, ...direct]);
  const queue = [...direct];
  const transitive: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const parents = db
      .getRelationsTo(current)
      .filter((relation) => IMPACT_KINDS.has(relation.kind))
      .map((relation) => relation.from);
    for (const parent of parents) {
      if (!visited.has(parent)) {
        visited.add(parent);
        transitive.push(parent);
        queue.push(parent);
      }
    }
  }

  const allDependents = [...direct, ...transitive];
  const tests = allDependents.filter((uid) => db.getEntity(uid)?.kind === "test");
  const targetEntity = db.getEntity(targetUid);
  const exportRelations = db.getRelationsTo(targetUid).filter((relation) => relation.kind === "exports");
  const publicApiAffected = Boolean(targetEntity?.metadata?.public) || exportRelations.length > 0;

  let riskScore: ImpactResult["riskScore"] = "LOW";
  const reasons: string[] = [];
  if (publicApiAffected) {
    reasons.push("public export");
  }
  if (tests.length > 0) {
    reasons.push("has test coverage");
  }
  if (allDependents.length > 6) {
    reasons.push("wide dependency surface");
  }
  if (allDependents.some((uid) => db.getEntity(uid)?.kind === "route")) {
    reasons.push("used by route");
  }
  if (reasons.length >= 3) {
    riskScore = "HIGH";
  } else if (reasons.length >= 1 || allDependents.length > 0) {
    riskScore = "MEDIUM";
  }

  const confidenceValues = directRelations.map((relation) => relation.confidence);
  const confidence =
    confidenceValues.length === 0
      ? 0.4
      : Math.max(0.1, confidenceValues.reduce((acc, value) => acc + value, 0) / confidenceValues.length);

  const suggestedFiles = [...new Set(allDependents.map((uid) => db.getEntity(uid)?.path).filter(Boolean))] as string[];

  return {
    target: targetUid,
    directDependents: direct,
    transitiveDependents: transitive,
    testsAffected: tests,
    publicApiAffected,
    riskScore,
    suggestedFiles,
    confidence,
    reasons
  };
}
