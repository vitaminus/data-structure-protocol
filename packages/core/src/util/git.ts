import { execSync } from "node:child_process";
import path from "node:path";

function splitLines(input: string): string[] {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function changedFilesFromGit(rootDir: string, baseRef = "HEAD"): string[] {
  try {
    const output = execSync(`git diff --name-only ${baseRef}`, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return splitLines(output).map((p) => path.resolve(rootDir, p));
  } catch {
    return [];
  }
}

export function changedFilesStaged(rootDir: string): string[] {
  try {
    const output = execSync("git diff --cached --name-only", {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return splitLines(output).map((p) => path.resolve(rootDir, p));
  } catch {
    return [];
  }
}
