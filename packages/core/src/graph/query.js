import { buildUid, normalizePath } from "./uid.js";
export function findEntityByUidOrPath(db, uidOrPath) {
    if (uidOrPath.includes(":")) {
        return db.getEntity(uidOrPath);
    }
    return db.getEntity(buildUid("file", normalizePath(uidOrPath)));
}
export function getNeighbors(db, uid, depth = 1) {
    const entities = new Map();
    const relations = [];
    const frontier = new Set([uid]);
    for (let currentDepth = 0; currentDepth < depth; currentDepth += 1) {
        const next = new Set();
        for (const node of frontier) {
            const fromRelations = db.getRelationsFrom(node);
            const toRelations = db.getRelationsTo(node);
            for (const relation of [...fromRelations, ...toRelations]) {
                relations.push(relation);
                const left = db.getEntity(relation.from);
                const right = db.getEntity(relation.to);
                if (left) {
                    entities.set(left.uid, left);
                    next.add(left.uid);
                }
                if (right) {
                    entities.set(right.uid, right);
                    next.add(right.uid);
                }
            }
        }
        frontier.clear();
        for (const candidate of next) {
            frontier.add(candidate);
        }
        if (frontier.size === 0) {
            break;
        }
    }
    return {
        entities: [...entities.values()],
        relations
    };
}
//# sourceMappingURL=query.js.map