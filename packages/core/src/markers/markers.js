import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
function markerPrefix(kind) {
    return ["function", "method", "route", "test"].includes(kind) ? "func" : "obj";
}
function stableMarkerUid(entity) {
    if (/^(?:obj|func)-[0-9a-fA-F]{8}$/.test(entity.uid)) {
        return entity.uid;
    }
    return `${markerPrefix(entity.kind)}-${createHash("sha1").update(entity.uid).digest("hex").slice(0, 8)}`;
}
function markerComment(filePath, uid) {
    const ext = path.extname(filePath).toLowerCase();
    const prefix = [".py", ".rb"].includes(ext) ? "#" : "//";
    return `${prefix} @dsp ${uid}`;
}
function shouldMark(entity) {
    return Boolean(entity.path &&
        entity.startLine &&
        !["file", "directory", "repository", "unknown"].includes(entity.kind));
}
export function insertSourceMarkers(db, rootDir, options = {}) {
    const byPath = new Map();
    for (const entity of db.getEntities(300000).filter(shouldMark)) {
        const list = byPath.get(entity.path) ?? [];
        list.push(entity);
        byPath.set(entity.path, list);
    }
    let markersInserted = 0;
    const paths = [];
    for (const [relPath, entities] of byPath) {
        const absPath = path.join(rootDir, relPath);
        if (!fs.existsSync(absPath)) {
            continue;
        }
        const lines = fs.readFileSync(absPath, "utf8").split("\n");
        let changed = false;
        for (const entity of [...entities].sort((a, b) => (b.startLine ?? 0) - (a.startLine ?? 0))) {
            const insertionIndex = Math.max(0, (entity.startLine ?? 1) - 1);
            const lookBehind = lines.slice(Math.max(0, insertionIndex - 3), insertionIndex).join("\n");
            if (/@dsp\s+(?:obj|func)-[0-9a-fA-F]{8}\b/.test(lookBehind)) {
                continue;
            }
            lines.splice(insertionIndex, 0, markerComment(relPath, stableMarkerUid(entity)));
            markersInserted += 1;
            changed = true;
        }
        if (changed) {
            paths.push(relPath);
            if (!options.dryRun) {
                fs.writeFileSync(absPath, lines.join("\n"), "utf8");
            }
        }
    }
    return { filesChanged: paths.length, markersInserted, paths };
}
