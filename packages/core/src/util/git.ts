import { execSync } from "node:child_process";
import path from "node:path";

function splitLines(input: string): string[] {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export type GitChangedFile = {
  status: string;
  path: string;
  oldPath?: string;
};

export function changedFileEntriesFromGit(rootDir: string, baseRef = "HEAD"): GitChangedFile[] {
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
          oldPath: path.resolve(rootDir, firstPath!),
          path: path.resolve(rootDir, secondPath!)
        };
      }
      return {
        status: status ?? "M",
        path: path.resolve(rootDir, firstPath!)
      };
    });
  } catch {
    return [];
  }
}

export function changedFilesFromGit(rootDir: string, baseRef = "HEAD"): string[] {
  return changedFileEntriesFromGit(rootDir, baseRef).map((entry) => entry.path);
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

export function workingTreeFingerprint(rootDir: string): string | undefined {
  try {
    const head = execSync("git rev-parse HEAD", {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const status = execSync("git status --porcelain=v1 --untracked-files=all -z", {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return `${head}\0${status}`;
  } catch {
    return undefined;
  }
}
