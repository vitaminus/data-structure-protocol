import { execSync } from "node:child_process";
import path from "node:path";
function splitLines(input) {
    return input
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}
export function changedFileEntriesFromGit(rootDir, baseRef = "HEAD") {
    try {
        const output = execSync(`git diff --name-status ${baseRef}`, {
            cwd: rootDir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
        });
        return splitLines(output).map((line) => {
            const [status, firstPath, secondPath] = line.split("\t");
            if (status?.startsWith("R") || status?.startsWith("C")) {
                return {
                    status,
                    oldPath: path.resolve(rootDir, firstPath),
                    path: path.resolve(rootDir, secondPath)
                };
            }
            return {
                status: status ?? "M",
                path: path.resolve(rootDir, firstPath)
            };
        });
    }
    catch {
        return [];
    }
}
export function changedFilesFromGit(rootDir, baseRef = "HEAD") {
    return changedFileEntriesFromGit(rootDir, baseRef).map((entry) => entry.path);
}
export function changedFilesStaged(rootDir) {
    try {
        const output = execSync("git diff --cached --name-only", {
            cwd: rootDir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
        });
        return splitLines(output).map((p) => path.resolve(rootDir, p));
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=git.js.map