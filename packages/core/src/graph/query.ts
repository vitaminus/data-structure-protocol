import type { DSPDatabase } from "../storage/db.ts";
import type { Entity, Relation } from "./types.ts";
import { buildUid, normalizePath } from "./uid.ts";

export type NeighborTraversalOptions = {
  maxEntities?: number;
  maxRelations?: number;
  maxFiles?: number;
  maxEstimatedTokens?: number;
};

export type NeighborTraversalEvent =
  | {
      type: "entity";
      entity: Entity;
      depth: number;
    }
  | {
      type: "relation";
      relation: Relation;
      depth: number;
      priority: number;
    };

const DEFAULT_MAX_ENTITIES = 500;
const DEFAULT_MAX_RELATIONS = 1000;

const RELATION_KIND_PRIORITY: Record<string, number> = {
  calls: 90,
  routes_to: 85,
  tests: 80,
  depends_on: 75,
  imports: 70,
  uses: 60,
  exports: 55,
  implements: 50,
  extends: 50,
  annotates: 35,
  contains: 20,
  similar_to: 10
};

type QueueItem = {
  uid: string;
  depth: number;
  priority: number;
};

class PriorityQueue<T> {
  private readonly items: T[] = [];

  constructor(private readonly compare: (left: T, right: T) => number) {}

  push(item: T): void {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): T | undefined {
    if (this.items.length === 0) {
      return undefined;
    }
    const first = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return first;
  }

  get size(): number {
    return this.items.length;
  }

  private bubbleUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (this.compare(this.items[current], this.items[parent]) <= 0) {
        break;
      }
      [this.items[current], this.items[parent]] = [this.items[parent], this.items[current]];
      current = parent;
    }
  }

  private bubbleDown(index: number): void {
    let current = index;
    while (true) {
      const left = current * 2 + 1;
      const right = left + 1;
      let best = current;
      if (left < this.items.length && this.compare(this.items[left], this.items[best]) > 0) {
        best = left;
      }
      if (right < this.items.length && this.compare(this.items[right], this.items[best]) > 0) {
        best = right;
      }
      if (best === current) {
        break;
      }
      [this.items[current], this.items[best]] = [this.items[best], this.items[current]];
      current = best;
    }
  }
}

export function findEntityByUidOrPath(db: DSPDatabase, uidOrPath: string): Entity | undefined {
  if (uidOrPath.includes(":") || /^(?:obj|func)-[0-9a-fA-F]{8}$/.test(uidOrPath)) {
    return db.getEntity(uidOrPath);
  }
  return db.getEntity(buildUid("file", normalizePath(uidOrPath)));
}

export function relationPriority(relation: Relation): number {
  const weight = relation.weight ?? relation.confidence;
  return weight * 100 + relation.confidence * 10 + (RELATION_KIND_PRIORITY[relation.kind] ?? 0);
}

function relationKey(relation: Relation): string {
  return `${relation.from}\0${relation.kind}\0${relation.to}`;
}

function normalizedTraversalOptions(options: NeighborTraversalOptions): Required<NeighborTraversalOptions> {
  const entities = Math.floor(options.maxEntities ?? DEFAULT_MAX_ENTITIES);
  const relations = Math.floor(options.maxRelations ?? DEFAULT_MAX_RELATIONS);
  const files = Math.floor(options.maxFiles ?? Number.POSITIVE_INFINITY);
  const tokens = Math.floor(options.maxEstimatedTokens ?? Number.POSITIVE_INFINITY);
  return {
    maxEntities: Number.isFinite(entities) ? Math.max(1, entities) : DEFAULT_MAX_ENTITIES,
    maxRelations: Number.isFinite(relations) ? Math.max(0, relations) : DEFAULT_MAX_RELATIONS,
    maxFiles: Number.isFinite(files) ? Math.max(0, files) : Number.POSITIVE_INFINITY,
    maxEstimatedTokens: Number.isFinite(tokens) ? Math.max(0, tokens) : Number.POSITIVE_INFINITY
  };
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function* traverseNeighbors(
  db: DSPDatabase,
  uid: string,
  depth = 1,
  options: NeighborTraversalOptions = {}
): Generator<NeighborTraversalEvent> {
  const normalizedDepth = Math.floor(depth);
  const maxDepth = Number.isFinite(normalizedDepth) ? Math.max(0, normalizedDepth) : 1;
  const { maxEntities, maxRelations, maxFiles, maxEstimatedTokens } = normalizedTraversalOptions(options);
  const entities = new Map<string, Entity>();
  const relationKeys = new Set<string>();
  const files = new Set<string>();
  let relationCount = 0;
  let estimatedTokens = 0;

  const seed = db.getEntity(uid);
  if (seed) {
    const seedTokens = estimateTokens(seed);
    if (seedTokens > maxEstimatedTokens || (seed.path && maxFiles < 1)) {
      return;
    }
    entities.set(seed.uid, seed);
    estimatedTokens += seedTokens;
    if (seed.path) {
      files.add(seed.path);
    }
    yield { type: "entity", entity: seed, depth: 0 };
  }

  const expandedDepth = new Map<string, number>();
  const queue = new PriorityQueue<QueueItem>((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }
    if (left.depth !== right.depth) {
      return right.depth - left.depth;
    }
    return right.uid.localeCompare(left.uid);
  });
  queue.push({ uid, depth: 0, priority: Number.POSITIVE_INFINITY });

  while (queue.size > 0 && relationCount < maxRelations) {
    const current = queue.pop()!;
    const previousDepth = expandedDepth.get(current.uid);
    if (previousDepth !== undefined && previousDepth <= current.depth) {
      continue;
    }
    expandedDepth.set(current.uid, current.depth);
    if (current.depth >= maxDepth) {
      continue;
    }

    const touchingRelations = [...db.getRelationsFrom(current.uid), ...db.getRelationsTo(current.uid)].sort(
      (left, right) =>
        relationPriority(right) - relationPriority(left) ||
        relationKey(left).localeCompare(relationKey(right))
    );

    for (const relation of touchingRelations) {
      if (relationCount >= maxRelations) {
        break;
      }
      const key = relationKey(relation);
      if (relationKeys.has(key)) {
        continue;
      }

      const left = db.getEntity(relation.from);
      const right = db.getEntity(relation.to);
      const newEntities = [left, right].filter(
        (entity): entity is Entity => entity !== undefined && !entities.has(entity.uid)
      );
      if (entities.size + newEntities.length > maxEntities) {
        continue;
      }
      const newFiles = newEntities
        .map((entity) => entity.path)
        .filter((entityPath): entityPath is string => entityPath !== undefined && !files.has(entityPath));
      if (files.size + newFiles.length > maxFiles) {
        continue;
      }
      const eventTokens =
        estimateTokens(relation) + newEntities.reduce((total, entity) => total + estimateTokens(entity), 0);
      if (estimatedTokens + eventTokens > maxEstimatedTokens) {
        continue;
      }

      relationKeys.add(key);
      relationCount += 1;
      estimatedTokens += eventTokens;
      const nextDepth = current.depth + 1;
      const priority = relationPriority(relation) - nextDepth;
      yield { type: "relation", relation, depth: nextDepth, priority };
      for (const entity of newEntities) {
        entities.set(entity.uid, entity);
        if (entity.path) {
          files.add(entity.path);
        }
        yield { type: "entity", entity, depth: nextDepth };
      }

      for (const nextUid of [relation.from, relation.to]) {
        if (nextUid !== current.uid && nextDepth <= maxDepth) {
          queue.push({ uid: nextUid, depth: nextDepth, priority });
        }
      }
    }
  }
}

export async function* streamNeighbors(
  db: DSPDatabase,
  uid: string,
  depth = 1,
  options: NeighborTraversalOptions = {}
): AsyncGenerator<NeighborTraversalEvent> {
  for (const event of traverseNeighbors(db, uid, depth, options)) {
    yield event;
  }
}

export function getNeighbors(
  db: DSPDatabase,
  uid: string,
  depth = 1,
  options: NeighborTraversalOptions = {}
): { entities: Entity[]; relations: Relation[] } {
  const entities = new Map<string, Entity>();
  const relations: Relation[] = [];
  for (const event of traverseNeighbors(db, uid, depth, options)) {
    if (event.type === "entity") {
      entities.set(event.entity.uid, event.entity);
    } else {
      relations.push(event.relation);
    }
  }
  return {
    entities: [...entities.values()],
    relations
  };
}
