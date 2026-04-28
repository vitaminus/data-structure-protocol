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

function cfgFeaturesFromAttribute(line: string): string[] {
  const features = [...line.matchAll(/feature\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]!);
  return [...new Set(features)];
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

type CargoDependency = {
  name: string;
  requirement?: string;
  section: string;
  line: number;
};

type CargoManifest = {
  packageName?: string;
  workspaceMembers: { path: string; line: number }[];
  dependencies: CargoDependency[];
};

function rustCrateRootForPath(filePath: string): string | undefined {
  const normalized = normalizePath(filePath);
  if (/^tests\/[^/]+\.rs$/.test(normalized)) {
    return "src/lib.rs";
  }
  if (/^benches\/[^/]+\.rs$/.test(normalized) || /^examples\/[^/]+\.rs$/.test(normalized)) {
    return "src/lib.rs";
  }
  if (/^src\/bin\/[^/]+\.rs$/.test(normalized)) {
    return "src/lib.rs";
  }
  return undefined;
}

function rustFileRole(filePath: string): "integration-test" | "bench" | "example" | "bin" | undefined {
  const normalized = normalizePath(filePath);
  if (/^tests\/[^/]+\.rs$/.test(normalized)) {
    return "integration-test";
  }
  if (/^benches\/[^/]+\.rs$/.test(normalized)) {
    return "bench";
  }
  if (/^examples\/[^/]+\.rs$/.test(normalized)) {
    return "example";
  }
  if (/^src\/bin\/[^/]+\.rs$/.test(normalized)) {
    return "bin";
  }
  return undefined;
}

function parseCargoManifest(content: string): CargoManifest {
  let section = "";
  let packageName: string | undefined;
  const dependencies: CargoDependency[] = [];
  const workspaceMembers: { path: string; line: number }[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    const sectionMatch = line.match(/^\[([^\]]+)\]/);
    if (sectionMatch) {
      section = sectionMatch[1]!;
      continue;
    }
    if (section === "package") {
      const nameMatch = line.match(/^name\s*=\s*["']([^"']+)["']/);
      if (nameMatch) {
        packageName = nameMatch[1];
      }
    }
    if (section === "workspace") {
      const membersMatch = line.match(/^members\s*=\s*\[(.*)\]/);
      if (membersMatch) {
        for (const member of membersMatch[1]!.split(",").map((item) => item.trim().replace(/^['\"]|['\"]$/g, "")).filter(Boolean)) {
          workspaceMembers.push({ path: member, line: index + 1 });
        }
      }
    }
    if (["dependencies", "dev-dependencies", "build-dependencies"].includes(section)) {
      const depMatch = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
      if (depMatch) {
        const rawRequirement = depMatch[2]!.trim();
        const quoted = rawRequirement.match(/^["']([^"']+)["']/);
        const version = rawRequirement.match(/version\s*=\s*["']([^"']+)["']/);
        dependencies.push({
          name: depMatch[1]!,
          requirement: quoted?.[1] ?? version?.[1] ?? rawRequirement,
          section,
          line: index + 1
        });
      }
    }
  }
  return { packageName, workspaceMembers, dependencies };
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
    return path.extname(filePath).toLowerCase() === ".rs" || path.basename(filePath) === "Cargo.toml";
  }

  async parseFile(filePath: string, content: string): Promise<ParseResult> {
    const now = stableNowIso();
    const entities: Entity[] = [];
    const relations: Relation[] = [];
    const unresolvedReferences: UnresolvedReference[] = [];
    const fileUid = buildUid("file", filePath);

    if (path.basename(filePath) === "Cargo.toml") {
      const manifest = parseCargoManifest(content);
      if (manifest.packageName) {
        const crateUid = buildUid("module", filePath, manifest.packageName);
        entities.push({
          uid: crateUid,
          kind: "module",
          name: manifest.packageName,
          path: filePath,
          language: "rust",
          confidence: 0.92,
          provenance: prov(0.92, "cargo package"),
          metadata: { rustKind: "crate", cargo: true },
          createdAt: now,
          updatedAt: now
        });
        relations.push({ from: fileUid, to: crateUid, kind: "contains", confidence: 1, provenance: prov(1, "cargo contains package") });
      }
      for (const member of manifest.workspaceMembers) {
        const uid = buildUid("module", member.path);
        entities.push({
          uid,
          kind: "module",
          name: member.path,
          path: member.path,
          language: "rust",
          startLine: member.line,
          endLine: member.line,
          confidence: 0.86,
          provenance: prov(0.86, "cargo workspace member"),
          metadata: { rustKind: "workspace-member" },
          createdAt: now,
          updatedAt: now
        });
        relations.push({ from: fileUid, to: uid, kind: "contains", confidence: 0.86, provenance: prov(0.86, "cargo workspace member") });
      }
      for (const dep of manifest.dependencies) {
        const uid = buildUid("unknown", "external/rust-crates", dep.name);
        entities.push({
          uid,
          kind: "unknown",
          name: dep.name,
          language: "rust",
          startLine: dep.line,
          endLine: dep.line,
          confidence: 0.9,
          provenance: prov(0.9, "cargo dependency"),
          metadata: { rustKind: "crate-dependency", requirement: dep.requirement, section: dep.section, external: true },
          createdAt: now,
          updatedAt: now
        });
        relations.push({
          from: fileUid,
          to: uid,
          kind: "depends_on",
          reason: `${dep.section} ${dep.name}${dep.requirement ? ` ${dep.requirement}` : ""}`,
          confidence: 0.9,
          provenance: prov(0.9, "cargo dependency")
        });
      }
      return { entities, relations, unresolvedReferences };
    }

    const role = rustFileRole(filePath);
    const crateRoot = rustCrateRootForPath(filePath);
    if (role && crateRoot) {
      const uid = buildUid(role === "integration-test" ? "test" : "module", filePath);
      entities.push({
        uid,
        kind: role === "integration-test" ? "test" : "module",
        name: path.basename(filePath),
        path: filePath,
        language: "rust",
        confidence: 0.84,
        provenance: prov(0.84, `cargo ${role} path convention`),
        metadata: { rustKind: role, crateRoot },
        createdAt: now,
        updatedAt: now
      });
      relations.push({ from: fileUid, to: uid, kind: "contains", confidence: 1, provenance: prov(1, `cargo ${role} file`) });
      relations.push({
        from: uid,
        to: buildUid("file", crateRoot),
        kind: role === "integration-test" ? "tests" : "depends_on",
        reason: `cargo ${role} path convention`,
        confidence: 0.82,
        provenance: prov(0.82, `cargo ${role} path convention`)
      });
    }

    const lines = content.split("\n");
    const implStack: { target: string; trait?: string; depth: number }[] = [];
    const callableStack: { uid: string; depth: number }[] = [];
    const callEdges: { from: string; name: string; line: number }[] = [];
    let braceDepth = 0;
    let pendingTestAttribute = false;
    let pendingCfgTestAttribute = false;
    let pendingDerives: string[] = [];
    let pendingCfgFeatures: string[] = [];
    let pendingRouteAttributes: { method: string; routePath: string; line: number }[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index];
      const line = raw.trim();
      const cfgFeatures = cfgFeaturesFromAttribute(line);
      if (cfgFeatures.length > 0) {
        pendingCfgFeatures = [...new Set([...pendingCfgFeatures, ...cfgFeatures])];
        continue;
      }
      const routeAttrMatch = line.match(/^#\[(?:(?:actix_web|rocket)::)?(get|post|put|delete|patch)\(["']([^"']+)["']/);
      if (routeAttrMatch) {
        pendingRouteAttributes.push({ method: routeAttrMatch[1]!.toUpperCase(), routePath: routeAttrMatch[2]!, line: index + 1 });
        continue;
      }
      const deriveMatch = line.match(/^#\[derive\(([^\]]+)\)\]/);
      if (deriveMatch) {
        pendingDerives = deriveMatch[1]!
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        continue;
      }
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
        const cfgFeatures = pendingCfgFeatures;
        pendingCfgTestAttribute = false;
        pendingCfgFeatures = [];
        const uid = buildUid(isCfgTestModule ? "test" : "module", filePath, name);
        entities.push({
          uid,
          kind: isCfgTestModule ? "test" : "module",
          name,
          path: filePath,
          language: "rust",
          startLine: index + 1,
          endLine: index + 1,
          metadata: { rustKind: "module", modulePath: resolvedMod.path, cfgTest: isCfgTestModule, cfgFeatures, ...visibilityFromPrefix(modMatch[1]) },
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

      const axumRouteMatch = line.match(/\.route\(\s*["']([^"']+)["']\s*,\s*(get|post|put|delete|patch)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/);
      if (axumRouteMatch) {
        const routeUid = buildUid("route", filePath, `${axumRouteMatch[2]!.toUpperCase()} ${axumRouteMatch[1]!}`);
        entities.push({
          uid: routeUid,
          kind: "route",
          name: axumRouteMatch[1]!,
          path: filePath,
          language: "rust",
          startLine: index + 1,
          endLine: index + 1,
          confidence: 0.76,
          provenance: prov(0.76, "axum route"),
          metadata: { framework: "axum", method: axumRouteMatch[2]!.toUpperCase(), handler: axumRouteMatch[3] },
          createdAt: now,
          updatedAt: now
        });
        relations.push({ from: fileUid, to: routeUid, kind: "contains", confidence: 1, provenance: prov(1, "file contains route") });
        relations.push({
          from: routeUid,
          to: buildUid("function", filePath, axumRouteMatch[3]!),
          kind: "routes_to",
          reason: axumRouteMatch[3],
          confidence: 0.76,
          provenance: prov(0.76, "axum route handler")
        });
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
        const cfgFeatures = pendingCfgFeatures;
        pendingCfgFeatures = [];
        const typeUid = buildUid("type", filePath, name);
        entities.push({
          uid: typeUid,
          kind: "type",
          name,
          path: filePath,
          language: "rust",
          startLine: index + 1,
          endLine: index + 1,
          metadata: { rustKind: "struct", cfgFeatures, ...visibilityFromPrefix(structMatch[1]) },
          confidence: 0.94,
          provenance: prov(0.94, "struct declaration"),
          createdAt: now,
          updatedAt: now
        });
        for (const derive of pendingDerives) {
          const traitUid = buildUid("interface", "external/rust", derive);
          entities.push({
            uid: traitUid,
            kind: "interface",
            name: derive,
            language: "rust",
            confidence: 0.68,
            provenance: prov(0.68, "derive trait reference"),
            metadata: { rustKind: "derive", external: true },
            createdAt: now,
            updatedAt: now
          });
          relations.push({
            from: typeUid,
            to: traitUid,
            kind: "implements",
            reason: `derive ${derive}`,
            confidence: 0.74,
            provenance: prov(0.74, "derive macro")
          });
        }
        pendingDerives = [];
      }

      const enumMatch = line.match(/^(pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (enumMatch) {
        const name = enumMatch[2];
        const cfgFeatures = pendingCfgFeatures;
        pendingCfgFeatures = [];
        const typeUid = buildUid("type", filePath, name);
        entities.push({
          uid: typeUid,
          kind: "type",
          name,
          path: filePath,
          language: "rust",
          startLine: index + 1,
          endLine: index + 1,
          metadata: { rustKind: "enum", cfgFeatures, ...visibilityFromPrefix(enumMatch[1]) },
          confidence: 0.94,
          provenance: prov(0.94, "enum declaration"),
          createdAt: now,
          updatedAt: now
        });
        for (const derive of pendingDerives) {
          const traitUid = buildUid("interface", "external/rust", derive);
          entities.push({
            uid: traitUid,
            kind: "interface",
            name: derive,
            language: "rust",
            confidence: 0.68,
            provenance: prov(0.68, "derive trait reference"),
            metadata: { rustKind: "derive", external: true },
            createdAt: now,
            updatedAt: now
          });
          relations.push({
            from: typeUid,
            to: traitUid,
            kind: "implements",
            reason: `derive ${derive}`,
            confidence: 0.74,
            provenance: prov(0.74, "derive macro")
          });
        }
        pendingDerives = [];
      }

      const traitMatch = line.match(/^(pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (traitMatch) {
        const name = traitMatch[2];
        const cfgFeatures = pendingCfgFeatures;
        pendingCfgFeatures = [];
        entities.push({
          uid: buildUid("interface", filePath, name),
          kind: "interface",
          name,
          path: filePath,
          language: "rust",
          startLine: index + 1,
          endLine: index + 1,
          metadata: { rustKind: "trait", cfgFeatures, ...visibilityFromPrefix(traitMatch[1]) },
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
        const cfgFeatures = pendingCfgFeatures;
        pendingTestAttribute = false;
        pendingCfgFeatures = [];
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
          metadata: { ...visibilityFromPrefix(fnMatch[1]), owner, rustTest: isTestFunction, cfgFeatures },
          confidence: 0.93,
          provenance: prov(0.93, isMethod ? "impl method" : "function declaration"),
          createdAt: now,
          updatedAt: now
        });
        for (const route of pendingRouteAttributes) {
          const routeUid = buildUid("route", filePath, `${route.method} ${route.routePath}`);
          entities.push({
            uid: routeUid,
            kind: "route",
            name: route.routePath,
            path: filePath,
            language: "rust",
            startLine: route.line,
            endLine: route.line,
            confidence: 0.78,
            provenance: prov(0.78, "rust route attribute"),
            metadata: { framework: "attribute", method: route.method, handler: name },
            createdAt: now,
            updatedAt: now
          });
          relations.push({ from: fileUid, to: routeUid, kind: "contains", confidence: 1, provenance: prov(1, "file contains route") });
          relations.push({
            from: routeUid,
            to: uid,
            kind: "routes_to",
            reason: name,
            confidence: 0.78,
            provenance: prov(0.78, "rust route attribute handler")
          });
        }
        pendingRouteAttributes = [];
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
