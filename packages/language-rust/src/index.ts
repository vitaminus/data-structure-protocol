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

function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      parts.push(input.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(input.slice(start).trim());
  return parts.filter(Boolean);
}

function expandUseSpecs(spec: string): string[] {
  const cleaned = spec.replace(/;+$/, "").trim();
  const openIndex = cleaned.indexOf("{");
  if (openIndex === -1) {
    return [cleaned];
  }

  let depth = 0;
  let closeIndex = -1;
  for (let index = openIndex; index < cleaned.length; index += 1) {
    const char = cleaned[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        closeIndex = index;
        break;
      }
    }
  }
  if (closeIndex === -1) {
    return [cleaned];
  }

  const prefix = cleaned.slice(0, openIndex).replace(/::$/, "");
  const suffix = cleaned.slice(closeIndex + 1);
  return splitTopLevel(cleaned.slice(openIndex + 1, closeIndex)).flatMap((part) => {
    const expanded = prefix ? `${prefix}::${part}${suffix}` : `${part}${suffix}`;
    return expandUseSpecs(expanded);
  });
}

function cleanUseSpec(spec: string): string {
  return spec
    .replace(/\s+as\s+.+$/, "")
    .replace(/::\*$/, "")
    .replace(/;+$/, "")
    .trim();
}

function visibilityFromPrefix(prefix: string | undefined): { public: boolean; visibility?: string } {
  if (!prefix) {
    return { public: false };
  }
  const visibility = prefix.trim();
  return { public: visibility === "pub", visibility };
}

function stripGenerics(input: string): string {
  return input.replace(/<[^<>]*>/g, "").trim();
}

const CALL_SKIP_WORDS = new Set(["if", "for", "while", "loop", "match", "return", "Some", "Ok", "Err", "Box", "Vec"]);

function countBraces(line: string): { open: number; close: number } {
  const withoutStrings = line.replace(/"(?:\\.|[^"])*"/g, "");
  return {
    open: [...withoutStrings].filter((char) => char === "{").length,
    close: [...withoutStrings].filter((char) => char === "}").length
  };
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
    const implStack: { target: string; trait?: string; depth: number }[] = [];
    const callableStack: { uid: string; depth: number }[] = [];
    const callEdges: { from: string; name: string; line: number }[] = [];
    let braceDepth = 0;
    let pendingTestAttribute = false;
    let pendingCfgTestAttribute = false;
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index];
      const line = raw.trim();
      if (line.startsWith("#[test]") || line.startsWith("#[tokio::test]") || line.startsWith("#[async_std::test]")) {
        pendingTestAttribute = true;
        continue;
      }
      if (line.startsWith("#[cfg(test)]")) {
        pendingCfgTestAttribute = true;
        continue;
      }
      while (implStack.length > 0 && braceDepth < implStack.at(-1)!.depth) {
        implStack.pop();
      }
      while (callableStack.length > 0 && braceDepth < callableStack.at(-1)!.depth) {
        callableStack.pop();
      }

      const modMatch = line.match(/^(pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*;|\s*\{)?$/);
      if (modMatch) {
        const name = modMatch[2];
        const resolvedMod = resolveModDeclaration(filePath, name);
        const isCfgTestModule = pendingCfgTestAttribute;
        pendingCfgTestAttribute = false;
        const uid = buildUid(isCfgTestModule ? "test" : "module", filePath, name);
        entities.push({
          uid,
          kind: isCfgTestModule ? "test" : "module",
          name,
          path: filePath,
          language: "rust",
          startLine: index + 1,
          endLine: index + 1,
          metadata: { rustKind: "module", modulePath: resolvedMod.path, cfgTest: isCfgTestModule, ...visibilityFromPrefix(modMatch[1]) },
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
        if (isCfgTestModule) {
          relations.push({
            from: uid,
            to: fileUid,
            kind: "tests",
            confidence: 0.82,
            provenance: prov(0.82, "cfg(test) module")
          });
        }
        if (line.endsWith(";")) {
          relations.push({
            from: fileUid,
            to: buildUid("file", resolvedMod.path),
            kind: "imports",
            reason: `mod ${name}`,
            confidence: resolvedMod.confidence,
            provenance: prov(resolvedMod.confidence, "mod file resolution")
          });
        }
      }

      const useMatch = line.match(/^use\s+(.+);$/);
      if (useMatch) {
        for (const spec of expandUseSpecs(useMatch[1]!.trim())) {
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
      }

      const structMatch = line.match(/^(pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/);
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
          metadata: { rustKind: "struct", ...visibilityFromPrefix(structMatch[1]) },
          confidence: 0.94,
          provenance: prov(0.94, "struct declaration"),
          createdAt: now,
          updatedAt: now
        });
      }

      const enumMatch = line.match(/^(pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/);
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
          metadata: { rustKind: "enum", ...visibilityFromPrefix(enumMatch[1]) },
          confidence: 0.94,
          provenance: prov(0.94, "enum declaration"),
          createdAt: now,
          updatedAt: now
        });
      }

      const traitMatch = line.match(/^(pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/);
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
          metadata: { rustKind: "trait", ...visibilityFromPrefix(traitMatch[1]) },
          confidence: 0.94,
          provenance: prov(0.94, "trait declaration"),
          createdAt: now,
          updatedAt: now
        });
      }

      const implMatch = line.match(/^impl(?:\s*<[^>]+>)?\s+(.+?)\s*\{/);
      if (implMatch) {
        const implHead = stripGenerics(implMatch[1]!.replace(/\s+where\s+.*$/, ""));
        const forMatch = implHead.match(/^(.+?)\s+for\s+(.+)$/);
        const maybeTrait = forMatch ? stripGenerics(forMatch[1]!).split(/\s+/).pop() : undefined;
        const target = stripGenerics(forMatch ? forMatch[2]! : implHead).split(/\s+/).pop()!;
        implStack.push({ target, trait: maybeTrait, depth: braceDepth + 1 });
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

      const fnMatch = line.match(/^(pub(?:\([^)]*\))?\s+)?(?:(?:async|const|unsafe)\s+)*(?:extern\s+"[^"]+"\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (fnMatch) {
        const name = fnMatch[2];
        const owner = implStack.at(-1)?.target;
        const isMethod = Boolean(owner);
        const isTestFunction = pendingTestAttribute;
        pendingTestAttribute = false;
        const entityKind = isTestFunction ? "test" : isMethod ? "method" : "function";
        const uid = isTestFunction
          ? buildUid("test", filePath, name)
          : isMethod
            ? buildUid("method", filePath, `${owner}.${name}`)
            : buildUid("function", filePath, name);
        entities.push({
          uid,
          kind: entityKind,
          name,
          path: filePath,
          language: "rust",
          startLine: index + 1,
          endLine: index + 1,
          metadata: { ...visibilityFromPrefix(fnMatch[1]), owner, rustTest: isTestFunction },
          confidence: 0.93,
          provenance: prov(0.93, isMethod ? "impl method" : "function declaration"),
          createdAt: now,
          updatedAt: now
        });
        if (isTestFunction) {
          relations.push({
            from: uid,
            to: fileUid,
            kind: "tests",
            confidence: 0.86,
            provenance: prov(0.86, "rust test attribute")
          });
        }
        if (line.includes("{")) {
          callableStack.push({ uid, depth: braceDepth + 1 });
        }
        if (owner && !isTestFunction) {
          relations.push({
            from: buildUid("type", filePath, owner),
            to: uid,
            kind: "contains",
            confidence: 0.95,
            provenance: prov(0.95, "impl contains method")
          });
        }
      }

      if (!fnMatch && callableStack.length > 0) {
        const currentCallable = callableStack.at(-1)!;
        for (const callMatch of line.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*!?\s*\(/g)) {
          const name = callMatch[1]!;
          if (!CALL_SKIP_WORDS.has(name)) {
            callEdges.push({ from: currentCallable.uid, name, line: index + 1 });
          }
        }
      }

      const braces = countBraces(line);
      braceDepth += braces.open - braces.close;
    }

    const callableTargets = new Map<string, Entity[]>();
    for (const entity of entities.filter((candidate) => candidate.kind === "function" || candidate.kind === "method")) {
      const bucket = callableTargets.get(entity.name) ?? [];
      bucket.push(entity);
      callableTargets.set(entity.name, bucket);
    }
    for (const edge of callEdges) {
      for (const target of callableTargets.get(edge.name) ?? []) {
        if (target.uid !== edge.from) {
          relations.push({
            from: edge.from,
            to: target.uid,
            kind: "calls",
            reason: `${edge.name}()`,
            confidence: 0.62,
            provenance: prov(0.62, "same-file call heuristic"),
            metadata: { line: edge.line }
          });
        }
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
