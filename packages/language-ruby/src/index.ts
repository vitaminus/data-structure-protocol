import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Entity, LanguageAdapter, ParseResult, Relation, UnresolvedReference } from "@dsp/core";
import { buildUid, stableNowIso } from "@dsp/core";

type RubySource = "ast" | "regex";

type RubySymbol = {
  kind: "module" | "class" | "method";
  name: string;
  owner?: string;
  startLine: number;
  endLine: number;
  classMethod?: boolean;
};

type RubyMixin = {
  kind: "include" | "extend" | "prepend";
  owner: string;
  target: string;
  line: number;
};

type RubyRoute = {
  verb: string;
  path: string;
  controllerAction?: string;
  line: number;
};

type RubyConstantReference = {
  name: string;
  owner?: string;
  line: number;
};

type RubyParsed = {
  symbols: RubySymbol[];
  requires: { spec: string; relative: boolean; line: number }[];
  mixins: RubyMixin[];
  routes: RubyRoute[];
  constants: RubyConstantReference[];
  source: RubySource;
};

type RubyToken = {
  line: number;
  type: string;
  value: string;
};

const RIPPER_LEX_SCRIPT = `
require "json"
require "ripper"
source = STDIN.read
tokens = Ripper.lex(source).map do |pos, type, token, _state|
  { line: pos[0], type: type.to_s.sub(/^on_/, ""), value: token }
end
puts JSON.generate(tokens)
`;

function prov(confidence: number, source: RubySource, evidence: string) {
  return [
    {
      source,
      tool: source === "ast" ? "ruby-ripper" : "ruby-regex-fallback",
      timestamp: stableNowIso(),
      confidence,
      evidence
    }
  ];
}

function tokenIsWhitespace(token: RubyToken): boolean {
  return ["sp", "ignored_nl", "nl", "comment"].includes(token.type);
}

function skipWhitespace(tokens: RubyToken[], index: number): number {
  let current = index;
  while (current < tokens.length && tokenIsWhitespace(tokens[current]!)) {
    current += 1;
  }
  return current;
}

function previousSignificant(tokens: RubyToken[], index: number): RubyToken | undefined {
  for (let current = index - 1; current >= 0; current -= 1) {
    if (!tokenIsWhitespace(tokens[current]!)) {
      return tokens[current];
    }
  }
  return undefined;
}

function readConstantPath(tokens: RubyToken[], index: number): { name?: string; next: number } {
  let current = skipWhitespace(tokens, index);
  const parts: string[] = [];
  while (current < tokens.length) {
    const token = tokens[current]!;
    if (token.type === "const" || token.type === "ident") {
      parts.push(token.value);
      current += 1;
      const afterName = skipWhitespace(tokens, current);
      if (tokens[afterName]?.value === "::") {
        current = afterName + 1;
        continue;
      }
      break;
    }
    break;
  }
  return { name: parts.length > 0 ? parts.join("::") : undefined, next: current };
}

function readMethodName(tokens: RubyToken[], index: number): { name?: string; classMethod: boolean; next: number } {
  let current = skipWhitespace(tokens, index);
  if (tokens[current]?.value === "self") {
    const maybeDot = skipWhitespace(tokens, current + 1);
    if ([".", "::"].includes(tokens[maybeDot]?.value ?? "")) {
      const nameIndex = skipWhitespace(tokens, maybeDot + 1);
      const name = tokens[nameIndex]?.value;
      return { name, classMethod: true, next: nameIndex + 1 };
    }
  }
  const name = tokens[current]?.value;
  return { name, classMethod: false, next: current + 1 };
}

function parseWithRipper(content: string): RubyParsed | undefined {
  const result = spawnSync("ruby", ["-e", RIPPER_LEX_SCRIPT], {
    input: content,
    encoding: "utf8"
  });
  if (result.status !== 0 || !result.stdout) {
    return undefined;
  }

  let tokens: RubyToken[];
  try {
    tokens = JSON.parse(result.stdout) as RubyToken[];
  } catch {
    return undefined;
  }

  const symbols: RubySymbol[] = [];
  const mixins: RubyMixin[] = [];
  const constants: RubyConstantReference[] = [];
  const stack: { kind: "module" | "class" | "method" | "block"; name?: string; symbolIndex?: number }[] = [];

  const currentOwner = () => [...stack].reverse().find((item) => item.kind === "class" || item.kind === "module")?.name;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.type === "kw" && token.value === "class") {
      const read = readConstantPath(tokens, i + 1);
      if (read.name) {
        const symbolIndex = symbols.push({ kind: "class", name: read.name, startLine: token.line, endLine: token.line }) - 1;
        stack.push({ kind: "class", name: read.name, symbolIndex });
      }
      i = read.next;
      continue;
    }

    if (token.type === "kw" && token.value === "module") {
      const read = readConstantPath(tokens, i + 1);
      if (read.name) {
        const symbolIndex = symbols.push({ kind: "module", name: read.name, startLine: token.line, endLine: token.line }) - 1;
        stack.push({ kind: "module", name: read.name, symbolIndex });
      }
      i = read.next;
      continue;
    }

    if (token.type === "kw" && token.value === "def") {
      const read = readMethodName(tokens, i + 1);
      if (read.name) {
        const owner = currentOwner();
        const symbolIndex =
          symbols.push({
            kind: "method",
            name: read.name,
            owner,
            startLine: token.line,
            endLine: token.line,
            classMethod: read.classMethod
          }) - 1;
        stack.push({ kind: "method", name: read.name, symbolIndex });
      }
      i = read.next;
      continue;
    }

    if (token.type === "ident" && ["include", "extend", "prepend"].includes(token.value)) {
      const read = readConstantPath(tokens, i + 1);
      const owner = currentOwner();
      if (owner && read.name) {
        mixins.push({ kind: token.value as RubyMixin["kind"], owner, target: read.name, line: token.line });
      }
      i = read.next;
      continue;
    }

    if (token.type === "kw" && token.value === "do") {
      stack.push({ kind: "block" });
      continue;
    }

    if (token.type === "const") {
      const previous = previousSignificant(tokens, i);
      if (!previous || !(previous.type === "kw" && ["class", "module"].includes(previous.value))) {
        const read = readConstantPath(tokens, i);
        if (read.name) {
          constants.push({ name: read.name, owner: currentOwner(), line: token.line });
          i = read.next;
          continue;
        }
      }
    }

    if (token.type === "kw" && token.value === "end") {
      const closed = stack.pop();
      if (closed?.symbolIndex !== undefined) {
        symbols[closed.symbolIndex]!.endLine = token.line;
      }
    }
  }

  const declared = new Set(symbols.filter((symbol) => symbol.kind !== "method").map((symbol) => symbol.name));
  return {
    symbols,
    mixins,
    requires: parseRequires(content),
    routes: parseRoutes(content),
    constants: constants.filter((constant) => !declared.has(constant.name)),
    source: "ast"
  };
}

function parseRequires(content: string): RubyParsed["requires"] {
  return content.split("\n").flatMap((raw, index) => {
    const line = raw.trim();
    const match = line.match(/^require(_relative)?\s+["']([^"']+)["']/);
    return match ? [{ spec: match[2]!, relative: Boolean(match[1]), line: index + 1 }] : [];
  });
}

function parseRoutes(content: string): RubyRoute[] {
  return content.split("\n").flatMap((raw, index) => {
    const line = raw.trim();
    const routeMatch = line.match(/^(get|post|put|patch|delete)\s+["']([^"']+)["'](?:,\s*to:\s*["']([^"']+)["'])?/);
    if (routeMatch) {
      return [
        {
          verb: routeMatch[1]!,
          path: routeMatch[2]!,
          controllerAction: routeMatch[3],
          line: index + 1
        }
      ];
    }
    const resourcesMatch = line.match(/^resources\s+:([A-Za-z_][A-Za-z0-9_]*)/);
    if (resourcesMatch) {
      const resource = resourcesMatch[1]!;
      return [
        {
          verb: "resources",
          path: `/${resource}`,
          controllerAction: `${resource}#index`,
          line: index + 1
        }
      ];
    }
    return [];
  });
}

function parseWithRegex(content: string): RubyParsed {
  const symbols: RubySymbol[] = [];
  const mixins: RubyMixin[] = [];
  const moduleStack: string[] = [];
  const classStack: string[] = [];
  let singletonClassActive = false;

  const owner = () => classStack.at(-1) ?? moduleStack.at(-1);

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    const moduleMatch = line.match(/^module\s+([A-Za-z_][A-Za-z0-9_:]*)/);
    if (moduleMatch) {
      const name = moduleMatch[1]!;
      moduleStack.push(name);
      symbols.push({ kind: "module", name, startLine: i + 1, endLine: i + 1 });
    }

    const classMatch = line.match(/^class\s+([A-Za-z_][A-Za-z0-9_:]*)/);
    if (classMatch) {
      const name = classMatch[1]!;
      classStack.push(name);
      symbols.push({ kind: "class", name, startLine: i + 1, endLine: i + 1 });
    }

    if (line.startsWith("class << self")) {
      singletonClassActive = true;
    }

    const methodMatch = line.match(/^def\s+(self\.)?([A-Za-z_][A-Za-z0-9_!?=]*)/);
    if (methodMatch) {
      symbols.push({
        kind: "method",
        name: methodMatch[2]!,
        owner: owner() ?? "Object",
        startLine: i + 1,
        endLine: i + 1,
        classMethod: Boolean(methodMatch[1]) || singletonClassActive
      });
    }

    const includeMatch = line.match(/^(include|extend|prepend)\s+([A-Za-z_][A-Za-z0-9_:]*)/);
    if (includeMatch && owner()) {
      mixins.push({
        kind: includeMatch[1] as RubyMixin["kind"],
        owner: owner()!,
        target: includeMatch[2]!,
        line: i + 1
      });
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

  const declared = new Set(symbols.filter((symbol) => symbol.kind !== "method").map((symbol) => symbol.name));
  const constants = [...content.matchAll(/\b([A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*)\b/g)]
    .map((match) => ({ name: match[1]!, line: content.slice(0, match.index).split("\n").length }))
    .filter((constant) => !declared.has(constant.name));

  return {
    symbols,
    mixins,
    requires: parseRequires(content),
    routes: parseRoutes(content),
    constants,
    source: "regex"
  };
}

function isRailsPath(filePath: string): boolean {
  return filePath.includes("/app/") || filePath.startsWith("app/") || filePath.endsWith("config/routes.rb");
}

function underscore(input: string): string {
  return input
    .replace(/::/g, "/")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

function railsPathForConstant(constant: string): string | undefined {
  if (!constant || ["String", "Integer", "Array", "Hash", "Time", "Date", "JSON", "Object", "Class", "Module"].includes(constant)) {
    return undefined;
  }
  const underscored = underscore(constant);
  if (constant.endsWith("Controller")) {
    return `app/controllers/${underscored}.rb`;
  }
  if (constant.endsWith("Job")) {
    return `app/jobs/${underscored}.rb`;
  }
  if (constant.endsWith("Mailer")) {
    return `app/mailers/${underscored}.rb`;
  }
  return `app/models/${underscored}.rb`;
}

function controllerActionTarget(controllerAction: string): { filePath: string; className: string; methodName: string } | undefined {
  const [controller, action] = controllerAction.split("#");
  if (!controller || !action) {
    return undefined;
  }
  const filePath = `app/controllers/${controller}_controller.rb`;
  const className = `${controller
    .split("/")
    .map((part) =>
      part
        .split("_")
        .filter(Boolean)
        .map((piece) => `${piece[0]!.toUpperCase()}${piece.slice(1)}`)
        .join("")
    )
    .join("::")}Controller`;
  return { filePath, className, methodName: action };
}

function railsConstantForPath(filePath: string): string | undefined {
  const match = filePath.match(/(?:^|\/)app\/(models|controllers|services|jobs|mailers)\/(.+)\.rb$/);
  if (!match) {
    return undefined;
  }
  return match[2]!
    .split("/")
    .map((part) =>
      part
        .split("_")
        .filter(Boolean)
        .map((piece) => `${piece[0]!.toUpperCase()}${piece.slice(1)}`)
        .join("")
    )
    .join("::");
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
    const parsed = parseWithRipper(content) ?? parseWithRegex(content);
    const confidence = parsed.source === "ast" ? 0.9 : 0.72;

    const addEntity = (entity: Entity) => {
      entities.push(entity);
      relations.push({
        from: fileUid,
        to: entity.uid,
        kind: "contains",
        confidence: 1,
        provenance: prov(1, parsed.source, "file contains symbol")
      });
    };

    for (const symbol of parsed.symbols) {
      if (symbol.kind === "module") {
        addEntity({
          uid: buildUid("module", filePath, symbol.name),
          kind: "module",
          name: symbol.name,
          path: filePath,
          language: "ruby",
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          confidence,
          provenance: prov(confidence, parsed.source, "module declaration"),
          metadata: { rails: isRailsPath(filePath), zeitwerkConstant: railsConstantForPath(filePath) },
          createdAt: now,
          updatedAt: now
        });
      } else if (symbol.kind === "class") {
        addEntity({
          uid: buildUid("class", filePath, symbol.name),
          kind: "class",
          name: symbol.name,
          path: filePath,
          language: "ruby",
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          confidence,
          provenance: prov(confidence, parsed.source, "class declaration"),
          metadata: {
            railsModel: filePath.includes("/app/models/") || filePath.startsWith("app/models/"),
            railsController: filePath.includes("/app/controllers/") || filePath.startsWith("app/controllers/"),
            zeitwerkConstant: railsConstantForPath(filePath)
          },
          createdAt: now,
          updatedAt: now
        });
      } else {
        const owner = symbol.owner ?? path.basename(filePath).replace(".rb", "");
        addEntity({
          uid: buildUid("method", filePath, `${owner}.${symbol.name}`),
          kind: "method",
          name: symbol.name,
          path: filePath,
          language: "ruby",
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          confidence: parsed.source === "ast" ? 0.86 : 0.72,
          provenance: prov(parsed.source === "ast" ? 0.86 : 0.72, parsed.source, symbol.classMethod ? "class method" : "instance method"),
          metadata: { classMethod: Boolean(symbol.classMethod), owner, public: !symbol.name.startsWith("_") },
          createdAt: now,
          updatedAt: now
        });
      }
    }

    for (const mixin of parsed.mixins) {
      relations.push({
        from: buildUid("class", filePath, mixin.owner),
        to: buildUid("module", filePath, mixin.target),
        kind: mixin.kind === "include" || mixin.kind === "prepend" ? "implements" : "uses",
        reason: `${mixin.kind} ${mixin.target}`,
        confidence: parsed.source === "ast" ? 0.78 : 0.7,
        provenance: prov(parsed.source === "ast" ? 0.78 : 0.7, parsed.source, `${mixin.kind} mixin`)
      });
    }

    for (const constant of parsed.constants) {
      const targetPath = railsPathForConstant(constant.name);
      if (targetPath && targetPath !== filePath) {
        relations.push({
          from: fileUid,
          to: buildUid("file", targetPath),
          kind: "uses",
          reason: `constant ${constant.name}`,
          confidence: 0.58,
          provenance: prov(0.58, parsed.source, "rails zeitwerk constant heuristic"),
          metadata: { constant: constant.name, owner: constant.owner, line: constant.line }
        });
      }
    }

    for (const req of parsed.requires) {
      unresolvedReferences.push({
        path: filePath,
        fromUid: fileUid,
        symbol: req.spec,
        kind: "require",
        reason: req.relative ? "ruby relative require dependency" : "ruby require dependency",
        confidence: req.relative ? 0.8 : 0.7
      });
    }

    if (filePath.endsWith("config/routes.rb")) {
      for (const route of parsed.routes) {
        const routeUid = buildUid("route", filePath, `${route.verb} ${route.path}`);
        addEntity({
          uid: routeUid,
          kind: "route",
          name: route.path,
          path: filePath,
          language: "ruby",
          startLine: route.line,
          endLine: route.line,
          confidence: 0.78,
          provenance: prov(0.78, parsed.source, "rails route"),
          metadata: { verb: route.verb, controllerAction: route.controllerAction },
          createdAt: now,
          updatedAt: now
        });
        const target = route.controllerAction ? controllerActionTarget(route.controllerAction) : undefined;
        if (target) {
          relations.push({
            from: routeUid,
            to: buildUid("method", target.filePath, `${target.className}.${target.methodName}`),
            kind: "routes_to",
            reason: route.controllerAction,
            confidence: 0.78,
            provenance: prov(0.78, parsed.source, "rails route controller action")
          });
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
