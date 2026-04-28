import type { DSPDatabase } from "../storage/db.ts";
import type { Entity, Relation } from "./types.ts";
import { buildUid, normalizePath } from "./uid.ts";

export function findEntityByUidOrPath(db: DSPDatabase, uidOrPath: string): Entity | undefined {
  if (uidOrPath.includes(":") || /^(?:obj|func)-[0-9a-fA-F]{8}$/.test(uidOrPath)) {
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
  const relationKeys = new Set<string>();
  const relations: Relation[] = [];
  const frontier = new Set<string>([uid]);
  const expanded = new Set<string>();
  for (let currentDepth = 0; currentDepth < depth; currentDepth += 1) {
    const next = new Set<string>();
    for (const node of frontier) {
      if (expanded.has(node)) {
        continue;
      }
      expanded.add(node);
      const fromRelations = db.getRelationsFrom(node);
      const toRelations = db.getRelationsTo(node);
      for (const relation of [...fromRelations, ...toRelations]) {
        const relationKey = `${relation.from}\0${relation.kind}\0${relation.to}`;
        if (!relationKeys.has(relationKey)) {
          relationKeys.add(relationKey);
          relations.push(relation);
        }
        const left = db.getEntity(relation.from);
        const right = db.getEntity(relation.to);
        if (left) {
          entities.set(left.uid, left);
          if (!expanded.has(left.uid)) {
            next.add(left.uid);
          }
        }
        if (right) {
          entities.set(right.uid, right);
          if (!expanded.has(right.uid)) {
            next.add(right.uid);
          }
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
