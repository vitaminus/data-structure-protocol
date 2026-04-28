import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TypeScriptLanguageAdapter } from "./index.js";

describe("typescript adapter", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extracts functions, classes, methods and imports", async () => {
    const adapter = new TypeScriptLanguageAdapter();
    const parsed = await adapter.parseFile(
      "src/auth.ts",
      `
      import { hash } from "./crypto";
      export class AuthService {
        createUser() { return hash("x"); }
      }
      export function login() {}
      `
    );
    const entities = adapter.extractEntities(parsed);
    const relations = adapter.extractRelations(parsed, entities);
    expect(entities.some((entity) => entity.kind === "class")).toBe(true);
    expect(entities.some((entity) => entity.kind === "method")).toBe(true);
    expect(entities.some((entity) => entity.kind === "function")).toBe(true);
    expect(relations.some((relation) => relation.kind === "imports")).toBe(true);
    expect(relations.some((relation) => relation.kind === "exports")).toBe(true);
  });

  it("adds same-file call relations for TypeScript callables", async () => {
    const adapter = new TypeScriptLanguageAdapter();
    const parsed = await adapter.parseFile(
      "src/auth.ts",
      `
function hashPassword() { return "x"; }
export const createUser = () => hashPassword();
class AuthService {
  login() { hashPassword(); }
}
`
    );
    const relations = adapter.extractRelations(parsed, parsed.entities);
    expect(
      relations.some(
        (relation) =>
          relation.kind === "calls" &&
          relation.from === "function:src/auth.ts#createUser" &&
          relation.to === "function:src/auth.ts#hashPassword"
      )
    ).toBe(true);
    expect(
      relations.some(
        (relation) =>
          relation.kind === "calls" &&
          relation.from === "method:src/auth.ts#AuthService.login" &&
          relation.to === "function:src/auth.ts#hashPassword"
      )
    ).toBe(true);
  });

  it("extracts TypeScript extends and implements relations", async () => {
    const adapter = new TypeScriptLanguageAdapter();
    const parsed = await adapter.parseFile(
      "src/auth.ts",
      `
interface BaseRepo {}
interface UserRepo extends BaseRepo {}
class BaseService {}
class AuthService extends BaseService implements UserRepo {}
`
    );
    const relations = adapter.extractRelations(parsed, parsed.entities);
    expect(
      relations.some(
        (relation) =>
          relation.kind === "extends" &&
          relation.from === "class:src/auth.ts#AuthService" &&
          relation.to === "class:src/auth.ts#BaseService"
      )
    ).toBe(true);
    expect(
      relations.some(
        (relation) =>
          relation.kind === "implements" &&
          relation.from === "class:src/auth.ts#AuthService" &&
          relation.to === "interface:src/auth.ts#UserRepo"
      )
    ).toBe(true);
    expect(
      relations.some(
        (relation) =>
          relation.kind === "extends" &&
          relation.from === "interface:src/auth.ts#UserRepo" &&
          relation.to === "interface:src/auth.ts#BaseRepo"
      )
    ).toBe(true);
  });

  it("extracts exported arrow functions, constants and enums", async () => {
    const adapter = new TypeScriptLanguageAdapter();
    const parsed = await adapter.parseFile(
      "src/config.ts",
      `
export const makeUser = () => ({ id: 1 });
export const API_URL = "https://example.com";
export enum Role { Admin, User }
`
    );
    const entities = adapter.extractEntities(parsed);
    const relations = adapter.extractRelations(parsed, entities);
    expect(entities.some((entity) => entity.kind === "function" && entity.name === "makeUser")).toBe(true);
    expect(entities.some((entity) => entity.kind === "constant" && entity.name === "API_URL")).toBe(true);
    expect(entities.some((entity) => entity.kind === "type" && entity.metadata?.tsKind === "enum")).toBe(true);
    expect(relations.filter((relation) => relation.kind === "exports").length).toBeGreaterThanOrEqual(3);
  });

  it("uses TypeScript module resolution for extensionless relative imports", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-ts-adapter-"));
    cleanupDirs.push(tempDir);
    const oldCwd = process.cwd();
    fs.mkdirSync(path.join(tempDir, "src", "auth"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src", "auth", "crypto.ts"), "export const hash = () => '';\n", "utf8");
    fs.writeFileSync(
      path.join(tempDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { moduleResolution: "NodeNext", module: "NodeNext" } }),
      "utf8"
    );

    try {
      process.chdir(tempDir);
      const adapter = new TypeScriptLanguageAdapter();
      const parsed = await adapter.parseFile(
        "src/auth/AuthService.ts",
        `import { hash } from "./crypto";\nexport function login() { return hash(); }\n`
      );
      const relations = adapter.extractRelations(parsed, parsed.entities);
      expect(
        relations.some(
          (relation) => relation.kind === "imports" && relation.to === "file:src/auth/crypto.ts"
        )
      ).toBe(true);
    } finally {
      process.chdir(oldCwd);
    }
  });
});
