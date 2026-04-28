import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { Entity, LanguageAdapter, ParseResult, Relation, UnresolvedReference } from "@dsp/core";
import { buildUid, normalizePath, stableNowIso } from "@dsp/core";

function inferKindFromFile(filePath: string): "typescript" | "javascript" {
  const ext = path.extname(filePath).toLowerCase();
  return [".js", ".jsx", ".mjs", ".cjs"].includes(ext) ? "javascript" : "typescript";
}

function withProv(confidence: number, evidence: string) {
  return [
    {
      source: "ast" as const,
      tool: "typescript-compiler-api",
      timestamp: stableNowIso(),
      confidence,
      evidence
    }
  ];
}

function pathForUid(resolvedFileName: string, fromPath: string): string {
  const normalizedResolved = normalizePath(resolvedFileName);
  if (!path.isAbsolute(resolvedFileName)) {
    return normalizedResolved;
  }
  if (path.isAbsolute(fromPath)) {
    return normalizedResolved;
  }
  const relativeToCwd = normalizePath(path.relative(process.cwd(), resolvedFileName));
  return relativeToCwd.startsWith("..") ? normalizedResolved : relativeToCwd;
}

function compilerOptionsFor(containingFile: string): ts.CompilerOptions {
  const configPath = ts.findConfigFile(path.dirname(containingFile), ts.sys.fileExists);
  if (!configPath) {
    return {
      allowJs: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.Latest,
      jsx: ts.JsxEmit.ReactJSX
    };
  }
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    return {};
  }
  return ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath)).options;
}

function resolveImport(fromPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  const containingFile = path.isAbsolute(fromPath) ? fromPath : path.resolve(fromPath);
  const resolved = ts.resolveModuleName(
    specifier,
    containingFile,
    compilerOptionsFor(containingFile),
    ts.sys
  ).resolvedModule;
  if (resolved && !resolved.isExternalLibraryImport) {
    return pathForUid(resolved.resolvedFileName, fromPath);
  }

  const base = path.dirname(fromPath);
  const candidate = normalizePath(path.join(base, specifier));
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
  for (const ext of extensions) {
    const withExtension = `${candidate}${ext}`;
    if (fs.existsSync(withExtension)) {
      return normalizePath(withExtension);
    }
  }
  for (const ext of extensions) {
    const indexFile = normalizePath(path.join(candidate, `index${ext}`));
    if (fs.existsSync(indexFile)) {
      return indexFile;
    }
  }
  return candidate;
}

export class TypeScriptLanguageAdapter implements LanguageAdapter {
  language = "typescript";

  canHandle(filePath: string): boolean {
    return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(path.extname(filePath).toLowerCase());
  }

  async parseFile(filePath: string, content: string): Promise<ParseResult> {
    const now = stableNowIso();
    const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    const entities: Entity[] = [];
    const relations: Relation[] = [];
    const unresolvedReferences: UnresolvedReference[] = [];
    const fileUid = buildUid("file", filePath);
    const lang = inferKindFromFile(filePath);

    const addEntity = (entity: Entity) => {
      entities.push(entity);
      relations.push({
        from: fileUid,
        to: entity.uid,
        kind: "contains",
        confidence: 1,
        provenance: withProv(1, "file contains symbol")
      });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        const targetPath = resolveImport(filePath, specifier);
        if (targetPath) {
          relations.push({
            from: fileUid,
            to: buildUid("file", targetPath),
            kind: "imports",
            reason: specifier,
            confidence: 0.92,
            provenance: withProv(0.92, `import ${specifier}`)
          });
        } else {
          unresolvedReferences.push({
            path: filePath,
            fromUid: fileUid,
            symbol: specifier,
            kind: "import",
            reason: "external import",
            confidence: 0.7
          });
        }
      }

      if (ts.isFunctionDeclaration(node) && node.name) {
        const name = node.name.text;
        const uid = buildUid("function", filePath, name);
        addEntity({
          uid,
          kind: "function",
          name,
          path: filePath,
          language: lang,
          signature: node.getText(source).split("{")[0]?.trim(),
          startLine: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          endLine: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
          metadata: {
            public: node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
          },
          confidence: 0.98,
          provenance: withProv(0.98, "function declaration"),
          createdAt: now,
          updatedAt: now
        });
      }

      if (ts.isVariableStatement(node)) {
        const isPublic = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
        for (const declaration of node.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) {
            continue;
          }
          const name = declaration.name.text;
          const initializer = declaration.initializer;
          const isCallable = Boolean(initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)));
          addEntity({
            uid: buildUid(isCallable ? "function" : "constant", filePath, name),
            kind: isCallable ? "function" : "constant",
            name,
            path: filePath,
            language: lang,
            signature: node.getText(source).split("=")[0]?.trim(),
            startLine: source.getLineAndCharacterOfPosition(declaration.getStart()).line + 1,
            endLine: source.getLineAndCharacterOfPosition(declaration.getEnd()).line + 1,
            metadata: {
              public: isPublic,
              declarationKind: ts.tokenToString(node.declarationList.flags & ts.NodeFlags.Const ? ts.SyntaxKind.ConstKeyword : ts.SyntaxKind.LetKeyword)
            },
            confidence: isCallable ? 0.92 : 0.9,
            provenance: withProv(isCallable ? 0.92 : 0.9, isCallable ? "function variable declaration" : "constant declaration"),
            createdAt: now,
            updatedAt: now
          });
        }
      }

      if (ts.isEnumDeclaration(node)) {
        const name = node.name.text;
        addEntity({
          uid: buildUid("type", filePath, name),
          kind: "type",
          name,
          path: filePath,
          language: lang,
          signature: node.name.getText(source),
          startLine: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          endLine: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
          metadata: { public: node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false, tsKind: "enum" },
          confidence: 0.94,
          provenance: withProv(0.94, "enum declaration"),
          createdAt: now,
          updatedAt: now
        });
      }

      if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.text;
        const classUid = buildUid("class", filePath, className);
        addEntity({
          uid: classUid,
          kind: "class",
          name: className,
          path: filePath,
          language: lang,
          signature: node.name.getText(source),
          startLine: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          endLine: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
          metadata: {
            public: node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
          },
          confidence: 0.98,
          provenance: withProv(0.98, "class declaration"),
          createdAt: now,
          updatedAt: now
        });
        for (const clause of node.heritageClauses ?? []) {
          for (const type of clause.types) {
            const targetName = type.expression.getText(source);
            relations.push({
              from: classUid,
              to: buildUid(clause.token === ts.SyntaxKind.ExtendsKeyword ? "class" : "interface", filePath, targetName),
              kind: clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements",
              reason: targetName,
              confidence: 0.86,
              provenance: withProv(0.86, clause.token === ts.SyntaxKind.ExtendsKeyword ? "class extends" : "class implements")
            });
          }
        }
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
            const methodName = member.name.text;
            const methodUid = buildUid("method", filePath, `${className}.${methodName}`);
            addEntity({
              uid: methodUid,
              kind: "method",
              name: methodName,
              path: filePath,
              language: lang,
              signature: member.getText(source).split("{")[0]?.trim(),
              startLine: source.getLineAndCharacterOfPosition(member.getStart()).line + 1,
              endLine: source.getLineAndCharacterOfPosition(member.getEnd()).line + 1,
              confidence: 0.95,
              provenance: withProv(0.95, "class method"),
              createdAt: now,
              updatedAt: now
            });
            relations.push({
              from: classUid,
              to: methodUid,
              kind: "contains",
              confidence: 1,
              provenance: withProv(1, "class contains method")
            });
          }
        }
      }

      if (ts.isInterfaceDeclaration(node)) {
        const name = node.name.text;
        const interfaceUid = buildUid("interface", filePath, name);
        addEntity({
          uid: interfaceUid,
          kind: "interface",
          name,
          path: filePath,
          language: lang,
          signature: node.name.getText(source),
          startLine: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          endLine: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
          confidence: 0.95,
          provenance: withProv(0.95, "interface declaration"),
          createdAt: now,
          updatedAt: now
        });
        for (const clause of node.heritageClauses ?? []) {
          for (const type of clause.types) {
            const targetName = type.expression.getText(source);
            relations.push({
              from: interfaceUid,
              to: buildUid("interface", filePath, targetName),
              kind: "extends",
              reason: targetName,
              confidence: 0.86,
              provenance: withProv(0.86, "interface extends")
            });
          }
        }
      }

      if (ts.isTypeAliasDeclaration(node)) {
        const name = node.name.text;
        addEntity({
          uid: buildUid("type", filePath, name),
          kind: "type",
          name,
          path: filePath,
          language: lang,
          signature: node.name.getText(source),
          startLine: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          endLine: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
          confidence: 0.95,
          provenance: withProv(0.95, "type alias declaration"),
          createdAt: now,
          updatedAt: now
        });
      }

      ts.forEachChild(node, visit);
    };

    visit(source);

    const exportNames = new Set<string>();
    source.forEachChild((node) => {
      if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          exportNames.add(element.name.text);
        }
      }
      if (
        (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) &&
        node.name &&
        node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        exportNames.add(node.name.text);
      }
      if (ts.isVariableStatement(node) && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            exportNames.add(declaration.name.text);
          }
        }
      }
    });
    for (const entity of entities) {
      if (exportNames.has(entity.name)) {
        relations.push({
          from: fileUid,
          to: entity.uid,
          kind: "exports",
          reason: `export ${entity.name}`,
          confidence: 0.98,
          provenance: withProv(0.98, "export declaration")
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
    return entities.filter((entity) => Boolean(entity.metadata?.public));
  }
}

export function createTypeScriptLanguageAdapter(): LanguageAdapter {
  return new TypeScriptLanguageAdapter();
}
