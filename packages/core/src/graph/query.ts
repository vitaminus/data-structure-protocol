import type { DSPDatabase } from "../storage/db.js";
import type { Entity, Relation } from "./types.js";
import { buildUid, normalizePath } from "./uid.js";

export function findEntityByUidOrPath(db: DSPDatabase, uidOrPath: string): Entity | undefined {
  if (uidOrPath.includes(":")) {
    return db.getEntity(uidOrPath);
  }
  return db.getEntity(buildUid("file", normalizePath(uidOrPath)));
}

export function getNeighbors(
  db: DSPDatabase,
  uid: string,
  depth = 1
): { entities: Entity[]; relations: Relation[] } {
  const entities = new Map<string, Entity>();
  const relations: Relation[] = [];
  const frontier = new Set<string>([uid]);
  for (let currentDepth = 0; currentDepth < depth; currentDepth += 1) {
    const next = new Set<string>();
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
