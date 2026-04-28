import path from "node:path";
import { createHash } from "node:crypto";
import type { EntityKind, EntityUid, FileUid } from "./types.ts";

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

export function asEntityUid<K extends EntityKind = EntityKind>(uid: string): EntityUid<K> {
  return uid as EntityUid<K>;
}

export function buildEntityUid<K extends EntityKind>(
  kind: K,
  filePath: string,
  symbol?: string
): EntityUid<K> {
  return asEntityUid<K>(buildUid(kind, filePath, symbol));
}

export function buildFileUid(filePath: string): FileUid {
  return buildEntityUid("file", filePath);
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function stableNowIso(date = new Date()): string {
  return date.toISOString();
}
