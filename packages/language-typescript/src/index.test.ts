import { describe, expect, it } from "vitest";
import { TypeScriptLanguageAdapter } from "./index.js";

describe("typescript adapter", () => {
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
});
