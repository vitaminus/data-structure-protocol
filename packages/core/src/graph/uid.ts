import path from "node:path";
import { createHash } from "node:crypto";
import type { EntityKind } from "./types.ts";

export function normalizePath(inputPath: string): string {
  return inputPath
    .replaceAll("\\", "/")
    .split(path.sep)
    .join("/")
    .replace(/^\.\//, "");
}

export function buildUid(kind: EntityKind, filePath: string, symbol?: string): string {
  const normalized = normalizePath(filePath);
  if (!symbol) {
    return `${kind}:${normalized}`;
  }
  return `${kind}:${normalized}#${symbol}`;
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function stableNowIso(date = new Date()): string {
  return date.toISOString();
}
