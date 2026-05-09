import { performance } from "node:perf_hooks";
import type { DSPDatabase } from "../storage/db.ts";
import type { ImpactResult, RelationKind, TraversalLimits, TraversalTruncationReason } from "../graph/types.ts";
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

function normalizedImpactLimits(options: TraversalLimits): Required<TraversalLimits> {
  const maxDepth = Math.floor(options.maxDepth ?? Number.POSITIVE_INFINITY);
  const maxNodes = Math.floor(options.maxNodes ?? Number.POSITIVE_INFINITY);
  const maxRelations = Math.floor(options.maxRelations ?? Number.POSITIVE_INFINITY);
  const timeoutMs = Math.floor(options.timeoutMs ?? Number.POSITIVE_INFINITY);
  return {
    maxDepth: Number.isFinite(maxDepth) ? Math.max(0, maxDepth) : Number.POSITIVE_INFINITY,
    maxNodes: Number.isFinite(maxNodes) ? Math.max(1, maxNodes) : Number.POSITIVE_INFINITY,
    maxRelations: Number.isFinite(maxRelations) ? Math.max(0, maxRelations) : Number.POSITIVE_INFINITY,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : Number.POSITIVE_INFINITY
  };
}

export function analyzeImpact(db: DSPDatabase, target: string, options: TraversalLimits = {}): ImpactResult {
  const targetUid = resolveTargetUid(target);
  const limits = normalizedImpactLimits(options);
  const startedAt = performance.now();
  const cache = db.createGraphReadCache();
  let truncationReason: TraversalTruncationReason | undefined;
  let traversedRelations = 0;

  const markTruncated = (reason: TraversalTruncationReason): void => {
    if (!truncationReason) {
      truncationReason = reason;
    }
  };

  const timedOut = (): boolean => performance.now() - startedAt >= limits.timeoutMs;
  const directRelations = db
    .getRelationsToCached(targetUid, cache)
    .filter((relation) => IMPACT_KINDS.has(relation.kind));
  const direct: string[] = [];
  const directSeen = new Set<string>();
  const visited = new Set<string>([targetUid]);

  for (const relation of directRelations) {
    if (timedOut()) {
      markTruncated("timeout");
      break;
    }
    if (traversedRelations >= limits.maxRelations) {
      markTruncated("maxRelations");
      break;
    }
    if (limits.maxDepth < 1) {
      markTruncated("maxDepth");
      break;
    }
    if (directSeen.has(relation.from)) {
      traversedRelations += 1;
      continue;
    }
    if (visited.size + 1 > limits.maxNodes) {
      markTruncated("maxNodes");
      break;
    }
    traversedRelations += 1;
    directSeen.add(relation.from);
    direct.push(relation.from);
    visited.add(relation.from);
  }

  const queue = direct.map((uid) => ({ uid, depth: 1 }));
  const transitive: string[] = [];
  while (queue.length > 0) {
    if (timedOut()) {
      markTruncated("timeout");
      break;
    }
    const current = queue.shift()!;
    if (current.depth >= limits.maxDepth) {
      const parentsAtDepthLimit = db
        .getRelationsToCached(current.uid, cache)
        .filter((relation) => IMPACT_KINDS.has(relation.kind) && !visited.has(relation.from));
      if (parentsAtDepthLimit.length > 0) {
        markTruncated("maxDepth");
        break;
      }
      continue;
    }
    const parents = db
      .getRelationsToCached(current.uid, cache)
      .filter((relation) => IMPACT_KINDS.has(relation.kind))
      .map((relation) => relation.from);
    for (const parent of parents) {
      if (timedOut()) {
        markTruncated("timeout");
        break;
      }
      if (traversedRelations >= limits.maxRelations) {
        markTruncated("maxRelations");
        break;
      }
      traversedRelations += 1;
      if (!visited.has(parent)) {
        if (visited.size + 1 > limits.maxNodes) {
          markTruncated("maxNodes");
          break;
        }
        visited.add(parent);
        transitive.push(parent);
        queue.push({ uid: parent, depth: current.depth + 1 });
      }
    }
    if (truncationReason) {
      break;
    }
  }

  const allDependents = [...direct, ...transitive];
  const entitiesByUid = new Map(db.getEntitiesByUidCached([targetUid, ...allDependents], cache).map((entity) => [entity.uid, entity]));
  const tests = allDependents.filter((uid) => entitiesByUid.get(uid)?.kind === "test");
  const targetEntity = entitiesByUid.get(targetUid);
  const exportRelations = db.getRelationsToCached(targetUid, cache).filter((relation) => relation.kind === "exports");
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
  if (allDependents.some((uid) => entitiesByUid.get(uid)?.kind === "route")) {
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

  const suggestedFiles = [...new Set(allDependents.map((uid) => entitiesByUid.get(uid)?.path).filter(Boolean))] as string[];

  return {
    target: targetUid,
    directDependents: direct,
    transitiveDependents: transitive,
    testsAffected: tests,
    publicApiAffected,
    riskScore,
    suggestedFiles,
    confidence,
    reasons,
    truncated: Boolean(truncationReason),
    ...(truncationReason ? { truncationReason } : {})
  };
}
