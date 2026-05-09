import { execFileSync } from "node:child_process";
import fs from "node:fs";
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

function validateGitRef(baseRef: string): string {
  if (!baseRef || /[\0\r\n\t ]/.test(baseRef) || baseRef.startsWith("-") || !/^[A-Za-z0-9._/:~^-]+$/.test(baseRef)) {
    throw new Error(`Invalid git base ref: ${baseRef}`);
  }
  return baseRef;
}

function runGit(rootDir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
}

function resolveGitDiffBase(rootDir: string, baseRef: string): string {
  if (baseRef.startsWith("merge-base:")) {
    const mergeBaseRef = validateGitRef(baseRef.slice("merge-base:".length));
    return runGit(rootDir, ["merge-base", mergeBaseRef, "HEAD"]).trim();
  }
  return validateGitRef(baseRef);
}

export function changedFileEntriesFromGit(rootDir: string, baseRef = "HEAD"): GitChangedFile[] {
  const resolvedBaseRef = resolveGitDiffBase(rootDir, baseRef);
  try {
    const output = runGit(rootDir, ["diff", "--name-status", resolvedBaseRef, "--"]);
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
    const output = runGit(rootDir, ["diff", "--cached", "--name-only", "--"]);
    return splitLines(output).map((p) => path.resolve(rootDir, p));
  } catch {
    return [];
  }
}

export function workingTreeFingerprint(rootDir: string): string | undefined {
  try {
    const head = runGit(rootDir, ["rev-parse", "HEAD"]).trim();
    const gitDir = runGit(rootDir, ["rev-parse", "--git-dir"]).trim();
    const indexPath = path.resolve(rootDir, gitDir, "index");
    const indexStat = fs.existsSync(indexPath) ? fs.statSync(indexPath) : undefined;
    const dirtyPaths = runGit(rootDir, ["ls-files", "-m", "-d", "-o", "--exclude-standard", "--directory", "-z"]);
    return [
      head,
      `${Math.trunc(indexStat?.mtimeMs ?? 0)}:${indexStat?.size ?? 0}`,
      dirtyPaths
    ].join("\0");
  } catch {
    return undefined;
  }
}
