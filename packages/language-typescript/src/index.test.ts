import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetTypeScriptProjectResolutionCache, TypeScriptLanguageAdapter } from "./index.ts";

describe("typescript adapter", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    resetTypeScriptProjectResolutionCache();
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

  it("links TypeScript test files to implementation files", async () => {
    const adapter = new TypeScriptLanguageAdapter();
    const parsed = await adapter.parseFile(
      "src/auth/__tests__/AuthService.test.ts",
      `import { AuthService } from "../AuthService";`
    );
    expect(parsed.entities.some((entity) => entity.kind === "test" && entity.uid === "test:src/auth/__tests__/AuthService.test.ts")).toBe(true);
    expect(
      parsed.relations.some(
        (relation) => relation.kind === "tests" && relation.to === "file:src/auth/AuthService.ts"
      )
    ).toBe(true);
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

  it("resolves tsconfig paths aliases to local files", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-ts-alias-"));
    cleanupDirs.push(tempDir);
    const oldCwd = process.cwd();
    fs.mkdirSync(path.join(tempDir, "src", "auth"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src", "auth", "crypto.ts"), "export const hash = () => '';\n", "utf8");
    fs.writeFileSync(
      path.join(tempDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@/*": ["src/*"]
          },
          moduleResolution: "NodeNext",
          module: "NodeNext"
        }
      }),
      "utf8"
    );

    try {
      process.chdir(tempDir);
      const adapter = new TypeScriptLanguageAdapter();
      const parsed = await adapter.parseFile(
        "src/auth/AuthService.ts",
        `import { hash } from "@/auth/crypto";\nexport function login() { return hash(); }\n`
      );
      const relations = adapter.extractRelations(parsed, parsed.entities);
      expect(
        relations.some(
          (relation) => relation.kind === "imports" && relation.to === "file:src/auth/crypto.ts"
        )
      ).toBe(true);
      expect(parsed.telemetry?.moduleResolutionMs).toBeGreaterThanOrEqual(0);
      expect(parsed.telemetry?.moduleResolutionCacheMisses).toBe(1);
    } finally {
      process.chdir(oldCwd);
    }
  });

  it("invalidates cached tsconfig state when path mappings change", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-ts-config-refresh-"));
    cleanupDirs.push(tempDir);
    const oldCwd = process.cwd();
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "lib"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src", "crypto.ts"), "export const source = 'src';\n", "utf8");
    fs.writeFileSync(path.join(tempDir, "lib", "crypto.ts"), "export const source = 'lib';\n", "utf8");

    try {
      process.chdir(tempDir);
      fs.writeFileSync(
        path.join(tempDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@app/*": ["src/*"]
            },
            moduleResolution: "NodeNext",
            module: "NodeNext"
          }
        }),
        "utf8"
      );

      const adapter = new TypeScriptLanguageAdapter();
      const first = await adapter.parseFile(
        "consumer.ts",
        `import { source } from "@app/crypto";\nexport const value = source;\n`
      );
      expect(
        first.relations.some(
          (relation) => relation.kind === "imports" && relation.to === "file:src/crypto.ts"
        )
      ).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 15));
      fs.writeFileSync(
        path.join(tempDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@app/*": ["lib/*"]
            },
            moduleResolution: "NodeNext",
            module: "NodeNext"
          }
        }),
        "utf8"
      );

      const second = await adapter.parseFile(
        "consumer.ts",
        `import { source } from "@app/crypto";\nexport const value = source;\n`
      );
      expect(
        second.relations.some(
          (relation) => relation.kind === "imports" && relation.to === "file:lib/crypto.ts"
        )
      ).toBe(true);
      expect(second.telemetry?.moduleResolutionCacheMisses).toBe(1);
    } finally {
      process.chdir(oldCwd);
    }
  });

  it("reuses cached resolution results on repeated parses in the same project", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-ts-cache-hit-"));
    cleanupDirs.push(tempDir);
    const oldCwd = process.cwd();
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src", "crypto.ts"), "export const hash = () => '';\n", "utf8");
    fs.writeFileSync(
      path.join(tempDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@app/*": ["src/*"]
          },
          moduleResolution: "NodeNext",
          module: "NodeNext"
        }
      }),
      "utf8"
    );

    try {
      process.chdir(tempDir);
      const adapter = new TypeScriptLanguageAdapter();
      const source = `import { hash } from "@app/crypto";\nexport function login() { return hash(); }\n`;
      const first = await adapter.parseFile("consumer.ts", source);
      const second = await adapter.parseFile("consumer.ts", source);

      expect(first.telemetry?.moduleResolutionCacheMisses).toBe(1);
      expect(second.telemetry?.moduleResolutionCacheHits).toBe(1);
      expect(second.telemetry?.moduleResolutionCacheMisses).toBe(0);
      expect(
        second.relations.some(
          (relation) => relation.kind === "imports" && relation.to === "file:src/crypto.ts"
        )
      ).toBe(true);
    } finally {
      process.chdir(oldCwd);
    }
  });
});
