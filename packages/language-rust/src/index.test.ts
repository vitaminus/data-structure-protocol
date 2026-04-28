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

  it("expands grouped use trees before resolving module files", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-rust-use-tree-"));
    cleanupDirs.push(tempDir);
    const oldCwd = process.cwd();
    fs.mkdirSync(path.join(tempDir, "src", "db"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src", "db", "mod.rs"), "pub struct Repo;\n", "utf8");
    fs.writeFileSync(path.join(tempDir, "src", "user.rs"), "pub struct User;\n", "utf8");

    try {
      process.chdir(tempDir);
      const adapter = new RustLanguageAdapter();
      const parsed = await adapter.parseFile(
        "src/lib.rs",
        `
use crate::{db::Repo, user::User};
`
      );
      const imports = adapter
        .extractRelations(parsed, parsed.entities)
        .filter((relation) => relation.kind === "imports")
        .map((relation) => relation.to);
      expect(imports).toContain("file:src/db/mod.rs");
      expect(imports).toContain("file:src/user.rs");
    } finally {
      process.chdir(oldCwd);
    }
  });

  it("maps derive attributes to implemented external traits", async () => {
    const adapter = new RustLanguageAdapter();
    const parsed = await adapter.parseFile(
      "src/user.rs",
      `
#[derive(Debug, Clone)]
pub struct User {}
`
    );
    const entities = adapter.extractEntities(parsed);
    const relations = adapter.extractRelations(parsed, entities);
    expect(entities.some((entity) => entity.kind === "interface" && entity.uid === "interface:external/rust#Debug")).toBe(true);
    expect(
      relations.some(
        (relation) =>
          relation.kind === "implements" &&
          relation.from === "type:src/user.rs#User" &&
          relation.to === "interface:external/rust#Clone"
      )
    ).toBe(true);
  });

  it("adds same-file call relations for Rust functions", async () => {
    const adapter = new RustLanguageAdapter();
    const parsed = await adapter.parseFile(
      "src/lib.rs",
      `
fn hash_password() -> String {
    String::new()
}

pub fn create_user() {
    hash_password();
}
`
    );
    const relations = adapter.extractRelations(parsed, parsed.entities);
    expect(
      relations.some(
        (relation) =>
          relation.kind === "calls" &&
          relation.from === "function:src/lib.rs#create_user" &&
          relation.to === "function:src/lib.rs#hash_password"
      )
    ).toBe(true);
  });

  it("extracts Rust unit tests and cfg test modules", async () => {
    const adapter = new RustLanguageAdapter();
    const parsed = await adapter.parseFile(
      "src/lib.rs",
      `
#[cfg(test)]
mod tests {
    #[test]
    fn creates_user() {}

    #[tokio::test]
    async fn async_case() {}
}
`
    );
    const entities = adapter.extractEntities(parsed);
    const relations = adapter.extractRelations(parsed, entities);
    expect(entities.some((entity) => entity.kind === "test" && entity.uid === "test:src/lib.rs#tests")).toBe(true);
    expect(entities.some((entity) => entity.kind === "test" && entity.uid === "test:src/lib.rs#creates_user")).toBe(true);
    expect(entities.some((entity) => entity.kind === "test" && entity.uid === "test:src/lib.rs#async_case")).toBe(true);
    expect(relations.filter((relation) => relation.kind === "tests").length).toBeGreaterThanOrEqual(3);
  });

  it("tracks impl scope with braces and Rust visibility modifiers", async () => {
    const adapter = new RustLanguageAdapter();
    const parsed = await adapter.parseFile(
      "src/user.rs",
      `
pub(crate) struct User {}

impl<T> User where T: Clone {
    pub(crate) async fn create() -> User {
        if true { User {} } else { User {} }
    }

    fn private_name(&self) -> String {
        String::new()
    }
}

pub fn top_level() {}
`
    );
    const entities = adapter.extractEntities(parsed);
    const relations = adapter.extractRelations(parsed, entities);
    expect(entities.find((entity) => entity.name === "User")?.metadata?.visibility).toBe("pub(crate)");
    expect(entities.some((entity) => entity.kind === "method" && entity.uid === "method:src/user.rs#User.create")).toBe(true);
    expect(entities.some((entity) => entity.kind === "method" && entity.uid === "method:src/user.rs#User.private_name")).toBe(true);
    expect(entities.some((entity) => entity.kind === "function" && entity.uid === "function:src/user.rs#top_level")).toBe(true);
    expect(
      relations.some(
        (relation) => relation.kind === "contains" && relation.from === "type:src/user.rs#User" && relation.to === "method:src/user.rs#User.create"
      )
    ).toBe(true);
  });
});
