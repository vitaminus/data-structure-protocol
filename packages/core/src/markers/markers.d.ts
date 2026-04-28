import type { DSPDatabase } from "../storage/db.js";
export declare function insertSourceMarkers(db: DSPDatabase, rootDir: string, options?: {
    dryRun?: boolean;
}): {
    filesChanged: number;
    markersInserted: number;
    paths: string[];
};
//# sourceMappingURL=markers.d.ts.map
