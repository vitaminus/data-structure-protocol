import type { DSPDatabase } from "../storage/db.js";
import type { Entity, Relation } from "./types.js";
export declare function findEntityByUidOrPath(db: DSPDatabase, uidOrPath: string): Entity | undefined;
export declare function getNeighbors(db: DSPDatabase, uid: string, depth?: number): {
    entities: Entity[];
    relations: Relation[];
};
//# sourceMappingURL=query.d.ts.map