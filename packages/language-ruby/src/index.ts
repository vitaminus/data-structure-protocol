import path from "node:path";
import type { Entity, LanguageAdapter, ParseResult, Relation, UnresolvedReference } from "@dsp/core";
import { buildUid, stableNowIso } from "@dsp/core";

function prov(confidence: number, source: "ast" | "regex", evidence: string) {
  return [
    {
      source,
      tool: source === "ast" ? "ruby-syntax-lite" : "ruby-regex-fallback",
      timestamp: stableNowIso(),
      confidence,
      evidence
    }
  ];
}

export class RubyLanguageAdapter implements LanguageAdapter {
  language = "ruby";

  canHandle(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === ".rb";
  }

  async parseFile(filePath: string, content: string): Promise<ParseResult> {
    const now = stableNowIso();
    const fileUid = buildUid("file", filePath);
    const entities: Entity[] = [];
    const relations: Relation[] = [];
    const unresolvedReferences: UnresolvedReference[] = [];
    const lines = content.split("\n");
    const moduleStack: string[] = [];
    const classStack: string[] = [];
    let singletonClassActive = false;

    const addEntity = (entity: Entity) => {
      entities.push(entity);
      relations.push({
        from: fileUid,
        to: entity.uid,
        kind: "contains",
        confidence: 1,
        provenance: prov(1, "ast", "file contains symbol")
      });
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (line.startsWith("require ")) {
        const spec = line.replace(/^require\s+["']/, "").replace(/["']$/, "");
        unresolvedReferences.push({
          path: filePath,
          fromUid: fileUid,
          symbol: spec,
          kind: "require",
          reason: "ruby require dependency",
          confidence: 0.7
        });
      }

      const moduleMatch = line.match(/^module\s+([A-Za-z_][A-Za-z0-9_:]*)/);
      if (moduleMatch) {
        const name = moduleMatch[1];
        moduleStack.push(name);
        addEntity({
          uid: buildUid("module", filePath, name),
          kind: "module",
          name,
          path: filePath,
          language: "ruby",
          startLine: i + 1,
          endLine: i + 1,
          confidence: 0.9,
          provenance: prov(0.9, "ast", "module declaration"),
          metadata: {
            rails:
              filePath.includes("/app/models/") || filePath.includes("/app/controllers/")
                ? true
                : false
          },
          createdAt: now,
          updatedAt: now
        });
      }

      const classMatch = line.match(/^class\s+([A-Za-z_][A-Za-z0-9_:]*)/);
      if (classMatch) {
        const className = classMatch[1];
        classStack.push(className);
        addEntity({
          uid: buildUid("class", filePath, className),
          kind: "class",
          name: className,
          path: filePath,
          language: "ruby",
          startLine: i + 1,
          endLine: i + 1,
          confidence: 0.9,
          provenance: prov(0.9, "ast", "class declaration"),
          metadata: {
            railsModel: filePath.includes("/app/models/"),
            railsController: filePath.includes("/app/controllers/")
          },
          createdAt: now,
          updatedAt: now
        });
      }

      if (line.startsWith("class << self")) {
        singletonClassActive = true;
      }

      const methodMatch = line.match(/^def\s+(self\.)?([A-Za-z_][A-Za-z0-9_!?=]*)/);
      if (methodMatch) {
        const isClassMethod = Boolean(methodMatch[1]) || singletonClassActive;
        const name = methodMatch[2];
        const owner =
          classStack.at(-1) ?? moduleStack.at(-1) ?? path.basename(filePath).replace(".rb", "");
        const uid = buildUid("method", filePath, `${owner}.${name}`);
        addEntity({
          uid,
          kind: "method",
          name,
          path: filePath,
          language: "ruby",
          startLine: i + 1,
          endLine: i + 1,
          confidence: 0.82,
          provenance: prov(0.82, "ast", isClassMethod ? "class method" : "instance method"),
          metadata: { classMethod: isClassMethod, owner, public: !name.startsWith("_") },
          createdAt: now,
          updatedAt: now
        });
      }

      const includeMatch = line.match(/^(include|extend)\s+([A-Za-z_][A-Za-z0-9_:]*)/);
      if (includeMatch) {
        const kind = includeMatch[1];
        const target = includeMatch[2];
        const owner = classStack.at(-1) ?? moduleStack.at(-1);
        if (owner) {
          relations.push({
            from: buildUid("class", filePath, owner),
            to: buildUid("module", filePath, target),
            kind: kind === "include" ? "implements" : "uses",
            reason: `${kind} ${target}`,
            confidence: 0.7,
            provenance: prov(0.7, "regex", `${kind} mixin`)
          });
        }
      }

      if (filePath.endsWith("config/routes.rb")) {
        const routeMatch = line.match(/(get|post|put|patch|delete)\s+["']([^"']+)["']/);
        if (routeMatch) {
          const routePath = routeMatch[2];
          addEntity({
            uid: buildUid("route", filePath, routePath),
            kind: "route",
            name: routePath,
            path: filePath,
            language: "ruby",
            startLine: i + 1,
            endLine: i + 1,
            confidence: 0.75,
            provenance: prov(0.75, "regex", "rails route"),
            createdAt: now,
            updatedAt: now
          });
        }
      }

      if (line === "end") {
        if (singletonClassActive) {
          singletonClassActive = false;
        } else if (classStack.length > 0) {
          classStack.pop();
        } else if (moduleStack.length > 0) {
          moduleStack.pop();
        }
      }
    }

    return {
      entities,
      relations,
      unresolvedReferences
    };
  }

  extractEntities(parseResult: ParseResult): Entity[] {
    return parseResult.entities;
  }

  extractRelations(parseResult: ParseResult): Relation[] {
    return parseResult.relations;
  }

  extractPublicAPI(entities: Entity[]): Entity[] {
    return entities.filter((entity) => !entity.name.startsWith("_"));
  }
}

export function createRubyLanguageAdapter(): LanguageAdapter {
  return new RubyLanguageAdapter();
}
