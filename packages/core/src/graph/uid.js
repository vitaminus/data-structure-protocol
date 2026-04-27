import path from "node:path";
import { createHash } from "node:crypto";
export function normalizePath(inputPath) {
    return inputPath
        .replaceAll("\\", "/")
        .split(path.sep)
        .join("/")
        .replace(/^\.\//, "");
}
export function buildUid(kind, filePath, symbol) {
    const normalized = normalizePath(filePath);
    if (!symbol) {
        return `${kind}:${normalized}`;
    }
    return `${kind}:${normalized}#${symbol}`;
}
export function contentHash(content) {
    return createHash("sha256").update(content).digest("hex");
}
export function stableNowIso(date = new Date()) {
    return date.toISOString();
}
//# sourceMappingURL=uid.js.map