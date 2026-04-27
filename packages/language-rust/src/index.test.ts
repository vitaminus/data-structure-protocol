import { describe, expect, it } from "vitest";
import { RustLanguageAdapter } from "./index.js";

describe("rust adapter", () => {
  it("extracts rust entities and use imports", async () => {
    const adapter = new RustLanguageAdapter();
    const parsed = await adapter.parseFile(
      "src/user.rs",
      `
pub struct User {}
pub trait Repository {}

impl Repository for User {}

impl User {
    pub fn create() -> User { User {} }
}

use crate::db::repo;
`
    );
    const entities = adapter.extractEntities(parsed);
    const relations = adapter.extractRelations(parsed, entities);
    expect(entities.some((entity) => entity.name === "User")).toBe(true);
    expect(entities.some((entity) => entity.metadata?.rustKind === "trait")).toBe(true);
    expect(entities.some((entity) => entity.kind === "method")).toBe(true);
    expect(relations.some((relation) => relation.kind === "imports")).toBe(true);
    expect(relations.some((relation) => relation.kind === "implements")).toBe(true);
  });
});
