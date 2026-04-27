import fs from "node:fs";
import path from "node:path";
import type { Entity, LanguageAdapter, ParseResult, Relation, UnresolvedReference } from "@dsp/core";
import { buildUid, normalizePath, stableNowIso } from "@dsp/core";

function prov(confidence: number, evidence: string) {
  return [
    {
      source: "ast" as const,
      tool: "rust-syntax-lite",
      timestamp: stableNowIso(),
      confidence,
      evidence
    }
  ];
}

function rustModuleFiles(baseDir: string, modulePath: string): string[] {
  const normalized = normalizePath(path.posix.join(baseDir, modulePath));
  return [`${normalized}.rs`, normalizePath(path.posix.join(normalized, "mod.rs"))];
}

function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function resolveModDeclaration(filePath: string, name: string): { path: string; confidence: number } {
  const baseDir = normalizePath(path.posix.dirname(filePath));
  const candidates = rustModuleFiles(baseDir, name);
  return { path: firstExisting(candidates) ?? candidates[0]!, confidence: firstExisting(candidates) ? 0.92 : 0.76 };
}

function cleanUseSpec(spec: string): string {
  return spec
    .replace(/\s+as\s+.+$/, "")
    .replace(/\{.*$/, "")
    .replace(/::\*$/, "")
    .replace(/;+$/, "")
    .trim();
}

function resolveUsePath(filePath: string, spec: string): { path: string; confidence: number } | undefined {
  const clean = cleanUseSpec(spec);
  if (!clean) {
    return undefined;
  }
  const rawSegments = clean.split("::").filter(Boolean);
  const first = rawSegments[0];
  let baseDir = normalizePath(path.posix.dirname(filePath));
  let segments = rawSegments;

  if (first === "crate") {
    baseDir = "src";
    segments = rawSegments.slice(1);
  } else if (first === "self") {
    segments = rawSegments.slice(1);
  } else if (first === "super") {
    baseDir = normalizePath(path.posix.dirname(baseDir));
    segments = rawSegments.slice(1);
  }

  if (segments.length === 0) {
    return undefined;
  }

  for (let length = segments.length; length >= 1; length -= 1) {
    const modulePath = segments.slice(0, length).join("/");
    const existing = firstExisting(rustModuleFiles(baseDir, modulePath));
    if (existing) {
      return { path: existing, confidence: 0.88 };
    }
  }

  if (first === "crate" || first === "self" || first === "super") {
    const fallbackPath = rustModuleFiles(baseDir, segments.join("/"))[0]!;
    return { path: fallbackPath, confidence: 0.72 };
  }

  return undefined;
}

export class RustLanguageAdapter implements LanguageAdapter {
  language = "rust";

  canHandle(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === ".rs";
  }

  async parseFile(filePath: string, content: string): Promise<ParseResult> {
    const now = stableNowIso();
    const entities: Entity[] = [];
    const relations: Relation[] = [];
    const unresolvedReferences: UnresolvedReference[] = [];
    const fileUid = buildUid("file", filePath);

    const lines = content.split("\n");
    const implStack: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index];
      const line = raw.trim();

      const modMatch = line.match(/^(pub\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;?$/);
      if (modMatch) {
        const name = modMatch[2];
        const resolvedMod = resolveModDeclaration(filePath, name);
        const uid = buildUid("module", filePath, name);
        entities.push({
          uid,
          kind: "module",
          name,
          path: filePath,
          language: "rust",
          startLine: index + 1,
          endLine: index + 1,
          metadata: { rustKind: "module", modulePath: resolvedMod.path, public: Boolean(modMatch[1]) },
          confidence: 0.93,
          provenance: prov(0.93, "mod declaration"),
          createdAt: now,
          updatedAt: now
        });
        relations.push({
          from: fileUid,
          to: uid,
          kind: "contains",
          confidence: 1,
          provenance: prov(1, "file contains module")
        });
        relations.push({
          from: fileUid,
          to: buildUid("file", resolvedMod.path),
          kind: "imports",
          reason: `mod ${name}`,
          confidence: resolvedMod.confidence,
          provenance: prov(resolvedMod.confidence, "mod file resolution")
        });
      }

      const useMatch = line.match(/^use\s+(.+);$/);
      if (useMatch) {
        const spec = useMatch[1].trim();
        const resolvedUse = resolveUsePath(filePath, spec);
        if (resolvedUse) {
          relations.push({
            from: fileUid,
            to: buildUid("file", resolvedUse.path),
            kind: "imports",
            reason: spec,
            confidence: resolvedUse.confidence,
            provenance: prov(resolvedUse.confidence, "use import resolution")
          });
        } else {
          unresolvedReferences.push({
            path: filePath,
            fromUid: fileUid,
            symbol: spec,
            kind: "use",
            reason: "external crate or unresolved path",
            confidence: 0.68
          });
        }
      }

      const structMatch = line.match(/^(pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (structMatch) {
        const name = structMatch[2];
        entities.push({
          uid: buildUid("type", filePath, name),
          kind: "type",
          name,
          path: filePath,
          language: "rust",
          startLine: index + 1,
          endLine: index + 1,
          metadata: { rustKind: "struct", public: Boolean(structMatch[1]) },
          confidence: 0.94,
          provenance: prov(0.94, "struct declaration"),
          createdAt: now,
          updatedAt: now
        });
      }

      const enumMatch = line.match(/^(pub\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (enumMatch) {
        const name = enumMatch[2];
        entities.push({
          uid: buildUid("type", filePath, name),
          kind: "type",
          name,
          path: filePath,
          language: "rust",
          startLine: index + 1,
          endLine: index + 1,
          metadata: { rustKind: "enum", public: Boolean(enumMatch[1]) },
          confidence: 0.94,
          provenance: prov(0.94, "enum declaration"),
          createdAt: now,
          updatedAt: now
        });
      }

      const traitMatch = line.match(/^(pub\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (traitMatch) {
        const name = traitMatch[2];
        entities.push({
          uid: buildUid("interface", filePath, name),
          kind: "interface",
          name,
          path: filePath,
          language: "rust",
          startLine: index + 1,
          endLine: index + 1,
          metadata: { rustKind: "trait", public: Boolean(traitMatch[1]) },
          confidence: 0.94,
          provenance: prov(0.94, "trait declaration"),
          createdAt: now,
          updatedAt: now
        });
      }

      const implMatch = line.match(/^impl(?:\s+([A-Za-z_][A-Za-z0-9_]*))?\s*(?:for\s+)?([A-Za-z_][A-Za-z0-9_]*)/);
      if (implMatch) {
        const maybeTrait = implMatch[1];
        const target = implMatch[2];
        implStack.push(target);
        const implName = maybeTrait ? `impl ${maybeTrait} for ${target}` : `impl ${target}`;
        const implUid = buildUid("unknown", filePath, implName);
        entities.push({
          uid: implUid,
          kind: "unknown",
          name: implName,
          path: filePath,
          language: "rust",
          startLine: index + 1,
          endLine: index + 1,
          metadata: { rustKind: "impl", target, trait: maybeTrait, public: false },
          confidence: 0.88,
          provenance: prov(0.88, "impl block"),
          createdAt: now,
          updatedAt: now
        });
        if (maybeTrait) {
          relations.push({
            from: buildUid("type", filePath, target),
            to: buildUid("interface", filePath, maybeTrait),
            kind: "implements",
            confidence: 0.85,
            provenance: prov(0.85, "impl Trait for Struct")
          });
        }
      }

      const fnMatch = line.match(/^(pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (fnMatch) {
        const name = fnMatch[2];
        const owner = implStack.at(-1);
        const isMethod = Boolean(owner);
        const uid = isMethod
          ? buildUid("method", filePath, `${owner}.${name}`)
          : buildUid("function", filePath, name);
        entities.push({
          uid,
          kind: isMethod ? "method" : "function",
          name,
          path: filePath,
          language: "rust",
          startLine: index + 1,
          endLine: index + 1,
          metadata: { public: Boolean(fnMatch[1]), owner },
          confidence: 0.93,
          provenance: prov(0.93, isMethod ? "impl method" : "function declaration"),
          createdAt: now,
          updatedAt: now
        });
      }

      if (line.startsWith("}")) {
        implStack.pop();
      }
    }

    for (const entity of entities) {
      relations.push({
        from: fileUid,
        to: entity.uid,
        kind: "contains",
        confidence: 1,
        provenance: prov(1, "file contains symbol")
      });
    }

    return { entities, relations, unresolvedReferences };
  }

  extractEntities(parseResult: ParseResult): Entity[] {
    return parseResult.entities;
  }

  extractRelations(parseResult: ParseResult): Relation[] {
    return parseResult.relations;
  }

  extractPublicAPI(entities: Entity[]): Entity[] {
    return entities.filter((entity) => Boolean(entity.metadata?.public));
  }
}

export function createRustLanguageAdapter(): LanguageAdapter {
  return new RustLanguageAdapter();
}
