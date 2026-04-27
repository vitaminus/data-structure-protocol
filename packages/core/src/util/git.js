import { execSync } from "node:child_process";
import path from "node:path";
function splitLines(input) {
    return input
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}
export function changedFilesFromGit(rootDir, baseRef = "HEAD") {
    try {
        const output = execSync(`git diff --name-only ${baseRef}`, {
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