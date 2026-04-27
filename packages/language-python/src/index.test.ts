import { describe, expect, it } from "vitest";
import { PythonLanguageAdapter } from "./index.js";

describe("python adapter", () => {
  it("extracts imports and symbols", async () => {
    const adapter = new PythonLanguageAdapter();
    const parsed = await adapter.parseFile(
      "app/auth.py",
      `
import os
from crypto import hash_password

class AuthService:
    def create_user(self, email, password):
        return hash_password(password)

def login():
    return True
`
    );
    const entities = adapter.extractEntities(parsed);
    const relations = adapter.extractRelations(parsed, entities);
    expect(entities.some((entity) => entity.kind === "class")).toBe(true);
    expect(entities.some((entity) => entity.kind === "method")).toBe(true);
    expect(entities.some((entity) => entity.kind === "function")).toBe(true);
    expect(relations.some((relation) => relation.kind === "imports")).toBe(true);
  });
});
