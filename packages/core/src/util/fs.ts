import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { DEFAULT_EXCLUDES } from "../config/types.ts";

const require = createRequire(import.meta.url);
const ignore = require("ignore") as typeof import("ignore").default;

export type DiscoverOptions = {
  excludes?: string[];
  maxFileSizeKb?: number;
};

export function ensureDir(target: string): void {
  fs.mkdirSync(target, { recursive: true });
}

export function findRepoRoot(startDir: string): string {
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

function readGitIgnore(rootDir: string): string[] {
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

function discoverFilesFromGit(
  rootDir: string,
  rules: import("ignore").Ignore,
  maxFileSizeKb: number
): string[] | undefined {
  const repoRoot = findRepoRoot(rootDir);
  if (!fs.existsSync(path.join(repoRoot, ".git"))) {
    return undefined;
  }

  try {
    const output = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }
    );
    const rootPrefix = path.relative(repoRoot, rootDir).split(path.sep).join("/");
    const files = output
      .split("\0")
      .filter(Boolean)
      .flatMap((repoRelPath) => {
        const normalizedRepoRelPath = repoRelPath.split(path.sep).join("/");
        if (
          rootPrefix &&
          normalizedRepoRelPath !== rootPrefix &&
          !normalizedRepoRelPath.startsWith(`${rootPrefix}/`)
        ) {
          return [];
        }
        const rel = rootPrefix
          ? normalizedRepoRelPath.slice(rootPrefix.length).replace(/^\//, "")
          : normalizedRepoRelPath;
        if (!rel || rules.ignores(rel)) {
          return [];
        }
        const absPath = path.join(repoRoot, normalizedRepoRelPath);
        const stat = fs.statSync(absPath);
        return stat.size <= maxFileSizeKb * 1024 ? [path.resolve(absPath)] : [];
      });
    return files.sort();
  } catch {
    return undefined;
  }
}

export function discoverFiles(rootDir: string, options: DiscoverOptions = {}): string[] {
  const rules = ignore();
  const excludes = options.excludes ?? DEFAULT_EXCLUDES;
  const gitIgnores = readGitIgnore(rootDir);
  rules.add([...excludes, ...gitIgnores]);
  const maxFileSizeKb = options.maxFileSizeKb ?? 512;
  const gitFiles = discoverFilesFromGit(rootDir, rules, maxFileSizeKb);
  if (gitFiles) {
    return gitFiles;
  }
  const files: string[] = [];
  const pending = [path.resolve(rootDir)];

  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = path.relative(rootDir, full).split(path.sep).join("/");
      if (rel === ".git" || rel.startsWith(".git/")) {
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (rules.ignores(rel) || rules.ignores(`${rel}/`)) {
          continue;
        }
        pending.push(full);
        continue;
      }
      if (rules.ignores(rel)) {
        continue;
      }
      const stat = fs.statSync(full);
      if (stat.size <= maxFileSizeKb * 1024) {
        files.push(full);
      }
    }
  }

  return files.sort();
}

export function readTextFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

export function writeTextFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}
