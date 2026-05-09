import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { DEFAULT_EXCLUDES } from "../config/types.ts";
import { workingTreeFingerprint } from "./git.ts";

const require = createRequire(import.meta.url);
const ignore = require("ignore") as typeof import("ignore").default;

export type DiscoverOptions = {
  excludes?: string[];
  maxFileSizeKb?: number;
};

export type DiscoverySkip = {
  path: string;
  reason: "tooLarge";
  sizeBytes: number;
};

export type DiscoveryResult = {
  files: string[];
  skipped: DiscoverySkip[];
};

type DiscoveryManifest = {
  rootDir: string;
  excludes: string[];
  maxFileSizeKb: number;
  fingerprint: string;
  files: string[];
  skipped?: DiscoverySkip[];
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

function manifestPath(rootDir: string): string {
  return path.join(rootDir, ".dsp", "discovery-manifest.json");
}

function fallbackFingerprint(rootDir: string, excludes: string[], maxFileSizeKb: number): string {
  const gitIgnorePath = path.join(rootDir, ".gitignore");
  const gitIgnoreMtime = fs.existsSync(gitIgnorePath) ? fs.statSync(gitIgnorePath).mtimeMs : 0;
  const entryFingerprint = fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.name !== ".dsp")
    .map((entry) => {
      const stat = fs.statSync(path.join(rootDir, entry.name));
      return `${entry.name}:${entry.isDirectory() ? "d" : "f"}:${Math.trunc(stat.mtimeMs)}:${stat.size}`;
    })
    .sort();
  return JSON.stringify({
    rootDir: path.resolve(rootDir),
    gitIgnoreMtimeMs: Math.trunc(gitIgnoreMtime),
    entryFingerprint,
    excludes,
    maxFileSizeKb
  });
}

function discoveryFingerprint(rootDir: string, excludes: string[], maxFileSizeKb: number): string {
  return workingTreeFingerprint(rootDir) ?? fallbackFingerprint(rootDir, excludes, maxFileSizeKb);
}

function readDiscoveryManifest(rootDir: string): DiscoveryManifest | undefined {
  const target = manifestPath(rootDir);
  if (!fs.existsSync(target)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(target, "utf8")) as DiscoveryManifest;
  } catch {
    return undefined;
  }
}

function writeDiscoveryManifest(rootDir: string, manifest: DiscoveryManifest): void {
  const target = manifestPath(rootDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function discoverFilesFromGit(
  rootDir: string,
  rules: import("ignore").Ignore,
  maxFileSizeKb: number
): DiscoveryResult | undefined {
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
    const files: string[] = [];
    const skipped: DiscoverySkip[] = [];
    for (const repoRelPath of output.split("\0").filter(Boolean)) {
      const normalizedRepoRelPath = repoRelPath.split(path.sep).join("/");
      if (
        rootPrefix &&
        normalizedRepoRelPath !== rootPrefix &&
        !normalizedRepoRelPath.startsWith(`${rootPrefix}/`)
      ) {
        continue;
      }
      const rel = rootPrefix
        ? normalizedRepoRelPath.slice(rootPrefix.length).replace(/^\//, "")
        : normalizedRepoRelPath;
      if (!rel || rules.ignores(rel)) {
        continue;
      }
      const absPath = path.join(repoRoot, normalizedRepoRelPath);
      const stat = fs.statSync(absPath);
      if (stat.size > maxFileSizeKb * 1024) {
        skipped.push({
          path: path.resolve(absPath),
          reason: "tooLarge",
          sizeBytes: stat.size
        });
        continue;
      }
      files.push(path.resolve(absPath));
    }
    return {
      files: files.sort(),
      skipped: skipped.sort((left, right) => left.path.localeCompare(right.path))
    };
  } catch {
    return undefined;
  }
}

export function discoverFilesDetailed(rootDir: string, options: DiscoverOptions = {}): DiscoveryResult {
  const rules = ignore();
  const excludes = options.excludes ?? DEFAULT_EXCLUDES;
  const gitIgnores = readGitIgnore(rootDir);
  rules.add([...excludes, ...gitIgnores]);
  const maxFileSizeKb = options.maxFileSizeKb ?? 512;
  const fingerprint = discoveryFingerprint(rootDir, excludes, maxFileSizeKb);
  const cachedManifest = readDiscoveryManifest(rootDir);
  if (
    cachedManifest &&
    cachedManifest.rootDir === path.resolve(rootDir) &&
    cachedManifest.maxFileSizeKb === maxFileSizeKb &&
    cachedManifest.fingerprint === fingerprint &&
    JSON.stringify(cachedManifest.excludes) === JSON.stringify(excludes)
  ) {
    return {
      files: cachedManifest.files.map((filePath) => path.resolve(filePath)),
      skipped: (cachedManifest.skipped ?? []).map((entry) => ({
        ...entry,
        path: path.resolve(entry.path)
      }))
    };
  }
  const gitFiles = discoverFilesFromGit(rootDir, rules, maxFileSizeKb);
  if (gitFiles) {
    writeDiscoveryManifest(rootDir, {
      rootDir: path.resolve(rootDir),
      excludes: [...excludes],
      maxFileSizeKb,
      fingerprint,
      files: gitFiles.files,
      skipped: gitFiles.skipped
    });
    return gitFiles;
  }
  const files: string[] = [];
  const skipped: DiscoverySkip[] = [];
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
      if (stat.size > maxFileSizeKb * 1024) {
        skipped.push({
          path: full,
          reason: "tooLarge",
          sizeBytes: stat.size
        });
        continue;
      }
      files.push(full);
    }
  }

  const sorted = files.sort();
  const sortedSkipped = skipped.sort((left, right) => left.path.localeCompare(right.path));
  writeDiscoveryManifest(rootDir, {
    rootDir: path.resolve(rootDir),
    excludes: [...excludes],
    maxFileSizeKb,
    fingerprint,
    files: sorted,
    skipped: sortedSkipped
  });
  return {
    files: sorted,
    skipped: sortedSkipped
  };
}

export function discoverFiles(rootDir: string, options: DiscoverOptions = {}): string[] {
  return discoverFilesDetailed(rootDir, options).files;
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
