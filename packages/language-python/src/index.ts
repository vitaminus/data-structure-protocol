import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Entity, LanguageAdapter, ParseResult, Relation, UnresolvedReference } from "@dsp/core";
import { buildUid, stableNowIso } from "@dsp/core";

type PythonSymbol = {
  kind: "function" | "class" | "method";
  name: string;
  className?: string;
  startLine: number;
  endLine: number;
  docstring?: string;
};

type PythonAstResult = {
  imports: string[];
  symbols: PythonSymbol[];
};

const PYTHON_EXTRACT_SCRIPT = `
import ast
import json
import sys

source = sys.stdin.read()
tree = ast.parse(source)
imports = []
symbols = []

class Visitor(ast.NodeVisitor):
    def __init__(self):
        self.class_stack = []
    def visit_Import(self, node):
        for alias in node.names:
            imports.append(alias.name)
        self.generic_visit(node)
    def visit_ImportFrom(self, node):
        mod = "." * node.level + (node.module or "")
        imports.append(mod)
        self.generic_visit(node)
    def visit_FunctionDef(self, node):
        if self.class_stack:
            symbols.append({
                "kind": "method",
                "name": node.name,
                "className": self.class_stack[-1],
                "startLine": node.lineno,
                "endLine": getattr(node, "end_lineno", node.lineno),
                "docstring": ast.get_docstring(node)
            })
        else:
            symbols.append({
                "kind": "function",
                "name": node.name,
                "startLine": node.lineno,
                "endLine": getattr(node, "end_lineno", node.lineno),
                "docstring": ast.get_docstring(node)
            })
        self.generic_visit(node)
    def visit_ClassDef(self, node):
        symbols.append({
            "kind": "class",
            "name": node.name,
            "startLine": node.lineno,
            "endLine": getattr(node, "end_lineno", node.lineno),
            "docstring": ast.get_docstring(node)
        })
        self.class_stack.append(node.name)
        self.generic_visit(node)
        self.class_stack.pop()

Visitor().visit(tree)
print(json.dumps({"imports": imports, "symbols": symbols}))
`;

function parseWithPythonAst(content: string): PythonAstResult | undefined {
  const result = spawnSync("python3", ["-c", PYTHON_EXTRACT_SCRIPT], {
    input: content,
    encoding: "utf8"
  });
  if (result.status !== 0 || !result.stdout) {
    return undefined;
  }
  try {
    return JSON.parse(result.stdout) as PythonAstResult;
  } catch {
    return undefined;
  }
}

function fallbackParse(content: string): PythonAstResult {
  const imports: string[] = [];
  const symbols: PythonSymbol[] = [];
  const lines = content.split("\n");
  let currentClass: string | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.startsWith("import ")) {
      imports.push(line.replace(/^import\s+/, "").split(" as ")[0]!.trim());
    }
    if (line.startsWith("from ")) {
      imports.push(line.replace(/^from\s+/, "").split(" import ")[0]!.trim());
    }
    const classMatch = line.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (classMatch) {
      currentClass = classMatch[1];
      symbols.push({
        kind: "class",
        name: currentClass,
        startLine: i + 1,
        endLine: i + 1
      });
    }
    const fnMatch = line.match(/^def\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (fnMatch) {
      const name = fnMatch[1];
      symbols.push({
        kind: currentClass ? "method" : "function",
        name,
        className: currentClass,
        startLine: i + 1,
        endLine: i + 1
      });
    }
    if (line.length === 0) {
      currentClass = undefined;
    }
  }
  return { imports, symbols };
}

function prov(confidence: number, evidence: string) {
  return [
    {
      source: "ast" as const,
      tool: "python-ast",
      timestamp: stableNowIso(),
      confidence,
      evidence
    }
  ];
}

function resolveRelativeModule(filePath: string, moduleName: string): string {
  if (moduleName.startsWith(".")) {
    const suffix = moduleName.replace(/^\.+/, "").replaceAll(".", "/");
    const baseDir = path.posix.dirname(filePath);
    if (suffix.length === 0) {
      return `${baseDir}/__init__.py`;
    }
    return path.posix.normalize(`${baseDir}/${suffix}.py`);
  }
  return `${moduleName.replaceAll(".", "/")}.py`;
}

export class PythonLanguageAdapter implements LanguageAdapter {
  language = "python";

  canHandle(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === ".py";
  }

  async parseFile(filePath: string, content: string): Promise<ParseResult> {
    const parsedFromAst = parseWithPythonAst(content);
    const parsed = parsedFromAst ?? fallbackParse(content);
    const usedFallback = !parsedFromAst;
    const now = stableNowIso();
    const fileUid = buildUid("file", filePath);
    const entities: Entity[] = [];
    const relations: Relation[] = [];
    const unresolvedReferences: UnresolvedReference[] = [];

    for (const symbol of parsed.symbols) {
      const uid =
        symbol.kind === "method"
          ? buildUid("method", filePath, `${symbol.className}.${symbol.name}`)
          : buildUid(symbol.kind, filePath, symbol.name);
      entities.push({
        uid,
        kind: symbol.kind,
        name: symbol.name,
        path: filePath,
        language: "python",
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        docstring: symbol.docstring,
        confidence: usedFallback ? 0.72 : 0.95,
        provenance: prov(usedFallback ? 0.72 : 0.95, symbol.kind),
        metadata: {
          public: !symbol.name.startsWith("_"),
          className: symbol.className
        },
        createdAt: now,
        updatedAt: now
      });
      relations.push({
        from: fileUid,
        to: uid,
        kind: "contains",
        confidence: 1,
        provenance: prov(1, "file contains symbol")
      });
    }

    for (const imp of parsed.imports) {
      const modulePath = resolveRelativeModule(filePath, imp);
      const confidence = imp.startsWith(".") ? (usedFallback ? 0.6 : 0.9) : usedFallback ? 0.5 : 0.65;
      relations.push({
        from: fileUid,
        to: buildUid("file", modulePath),
        kind: "imports",
        reason: imp,
        confidence,
        provenance: prov(confidence, `import ${imp}`)
      });
      if (!imp.startsWith(".")) {
        unresolvedReferences.push({
          path: filePath,
          fromUid: fileUid,
          symbol: imp,
          kind: "import",
          reason: "could be external python package",
          confidence: 0.6
        });
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

export function createPythonLanguageAdapter(): LanguageAdapter {
  return new PythonLanguageAdapter();
}
