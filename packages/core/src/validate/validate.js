import path from "node:path";
import { readFileSync } from "node:fs";
import { contentHash } from "../graph/uid.js";
export function validateGraph(db, rootDir) {
    const issues = [];
    const entities = db.getEntities(300000);
    const entitySet = new Set(entities.map((entity) => entity.uid));
    const relations = db.getRelations(600000);
    const unresolved = db.getUnresolvedReferences();
    for (const entity of entities) {
        if (entity.kind === "file" && entity.path) {
            const absPath = path.join(rootDir, entity.path);
            try {
                const content = readFileSync(absPath, "utf8");
                const currentHash = contentHash(content);
                const indexedHash = db.getFileHash(entity.path);
                if (indexedHash && indexedHash !== currentHash) {
                    issues.push({
                        kind: "stale_hash",
                        uid: entity.uid,
                        path: entity.path,
                        message: `File hash changed since last index: ${entity.path}`
                    });
                }
            }
            catch {
                issues.push({
                    kind: "missing_file",
                    uid: entity.uid,
                    path: entity.path,
                    message: `Indexed file no longer exists: ${entity.path}`
                });
            }
        }
    }
    for (const relation of relations) {
        if (!entitySet.has(relation.from) || !entitySet.has(relation.to)) {
            issues.push({
                kind: "dangling_relation",
                relation: { from: relation.from, to: relation.to, kind: relation.kind },
                message: `Relation has missing endpoint: ${relation.from} -> ${relation.to}`
            });
        }
        if (["imports", "depends_on", "calls"].includes(relation.kind) && relation.confidence < 0.35) {
            issues.push({
                kind: "low_confidence_critical",
                relation: { from: relation.from, to: relation.to, kind: relation.kind },
                confidence: relation.confidence,
                message: `Low confidence on critical relation ${relation.kind}: ${relation.from} -> ${relation.to}`
            });
        }
    }
    for (const ref of unresolved) {
        issues.push({
            kind: "unresolved_reference",
            path: ref.path,
            uid: ref.fromUid,
            confidence: ref.confidence,
            message: `Unresolved ${ref.kind}: ${ref.symbol} (${ref.path})`
        });
    }
    const annotationConflicts = entities.filter((entity) => {
        const sources = new Set(entity.provenance.map((provenance) => provenance.source));
        return sources.has("human") && sources.has("ast") && entity.confidence < 0.5;
    });
    for (const entity of annotationConflicts) {
        issues.push({
            kind: "annotation_conflict",
            uid: entity.uid,
            path: entity.path,
            message: `Potential human/AST conflict on ${entity.uid}`
        });
    }
    return {
        ok: issues.length === 0,
        issues
    };
}
//# sourceMappingURL=validate.js.map