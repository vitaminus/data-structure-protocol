import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { DEFAULT_EXCLUDES } from "../config/types.js";
const require = createRequire(import.meta.url);
const ignore = require("ignore");
export function ensureDir(target) {
    fs.mkdirSync(target, { recursive: true });
}
export function findRepoRoot(startDir) {
    let current = path.resolve(startDir);
    while (true) {
        if (fs.existsSync(path.join(current, ".git"))) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return path.resolve(startDir);
        }
        current = parent;
    }
}
function readGitIgnore(rootDir) {
    const target = path.join(rootDir, ".gitignore");
    if (!fs.existsSync(target)) {
        return [];
    }
    return fs
        .readFileSync(target, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
}
function walk(dir) {
    const out = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...walk(full));
            continue;
        }
        out.push(full);
    }
    return out;
}
export function discoverFiles(rootDir, options = {}) {
    const rules = ignore();
    const excludes = options.excludes ?? DEFAULT_EXCLUDES;
    const gitIgnores = readGitIgnore(rootDir);
    rules.add([...excludes, ...gitIgnores]);
    const maxFileSizeKb = options.maxFileSizeKb ?? 512;
    const files = walk(rootDir);
    return files
        .filter((absPath) => {
        const rel = path.relative(rootDir, absPath).split(path.sep).join("/");
        if (rel.startsWith(".git/")) {
            return false;
        }
        if (rules.ignores(rel)) {
            return false;
        }
        const stat = fs.statSync(absPath);
        return stat.size <= maxFileSizeKb * 1024;
    })
        .sort();
}
export function readTextFile(filePath) {
    return fs.readFileSync(filePath, "utf8");
}
export function writeTextFile(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
}
export function fileExists(filePath) {
    return fs.existsSync(filePath);
}
//# sourceMappingURL=fs.js.map