import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RustLanguageAdapter } from "./index.js";

describe("rust adapter", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it("resolves sibling modules and crate uses to existing Rust files", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-rust-adapter-"));
    cleanupDirs.push(tempDir);
    const oldCwd = process.cwd();
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src", "user.rs"), "pub struct User;\n", "utf8");

    try {
      process.chdir(tempDir);
      const adapter = new RustLanguageAdapter();
      const parsed = await adapter.parseFile(
        "src/lib.rs",
        `
pub mod user;
use user::User;
use crate::user::User as CrateUser;
`
      );
      const relations = adapter.extractRelations(parsed, parsed.entities);
      const imports = relations.filter((relation) => relation.kind === "imports").map((relation) => relation.to);
      expect(imports).toContain("file:src/user.rs");
      expect(parsed.unresolvedReferences ?? []).toHaveLength(0);
    } finally {
      process.chdir(oldCwd);
    }
  });
});
