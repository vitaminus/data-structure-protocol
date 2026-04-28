import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LanguageAdapter, ParseResult } from "../graph/types.js";
import { DEFAULT_CONFIG } from "../config/types.js";
import { DSPDatabase } from "../storage/db.js";
import { indexRepository } from "./indexer.js";
import { buildUid, stableNowIso } from "../graph/uid.js";

class MockAdapter implements LanguageAdapter {
  language = "typescript";
  canHandle(filePath: string): boolean {
    return filePath.endsWith(".ts");
  }
  async parseFile(filePath: string): Promise<ParseResult> {
    const now = stableNowIso();
    return {
      entities: [
        {
          uid: buildUid("function", filePath, "demo"),
          kind: "function",
          name: "demo",
          path: filePath,
          language: "typescript",
          confidence: 1,
          provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
          createdAt: now,
          updatedAt: now
        }
      ],
      relations: [],
      unresolvedReferences: []
    };
  }
  extractEntities(parseResult: ParseResult) {
    return parseResult.entities;
  }
  extractRelations(parseResult: ParseResult) {
    return parseResult.relations;
  }
  extractPublicAPI() {
    return [];
  }
}

describe("indexer", () => {
  let tempDir: string;
  let db: DSPDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-indexer-test-"));
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src", "a.ts"), "export const a = 1;\n", "utf8");
    db = new DSPDatabase(tempDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("includes Rust Cargo manifests in repository indexing", async () => {
    fs.writeFileSync(path.join(tempDir, "Cargo.toml"), "[package]\nname = 'demo'\n", "utf8");
    class CargoAdapter extends MockAdapter {
      override language = "rust";
      override canHandle(filePath: string): boolean {
        return filePath === "Cargo.toml";
      }
    }

    const summary = await indexRepository(db, [new CargoAdapter()], { rootDir: tempDir }, DEFAULT_CONFIG);
    expect(summary.languages).toContain("rust");
    expect(db.getEntity(buildUid("file", "Cargo.toml"))).toBeDefined();
  });

  it("includes Ruby Bundler files in repository indexing", async () => {
    fs.writeFileSync(path.join(tempDir, "Gemfile"), "gem 'rails'\n", "utf8");
    class GemfileAdapter extends MockAdapter {
      override language = "ruby";
      override canHandle(filePath: string): boolean {
        return filePath === "Gemfile";
      }
      override async parseFile(filePath: string): Promise<ParseResult> {
        const now = stableNowIso();
        return {
          entities: [
            {
              uid: buildUid("unknown", "external/ruby-gems", "rails"),
              kind: "unknown",
              name: "rails",
              language: "ruby",
              confidence: 1,
              provenance: [{ source: "regex", timestamp: now, confidence: 1 }],
              createdAt: now,
              updatedAt: now
            }
          ],
          relations: [],
          unresolvedReferences: []
        };
      }
    }

    const summary = await indexRepository(db, [new GemfileAdapter()], { rootDir: tempDir }, DEFAULT_CONFIG);
    expect(summary.languages).toContain("ruby");
    expect(db.getEntity(buildUid("file", "Gemfile"))).toBeDefined();
  });

  it("skips unchanged files on second run", async () => {
    const adapter = new MockAdapter();
    const first = await indexRepository(db, [adapter], { rootDir: tempDir }, DEFAULT_CONFIG);
    const second = await indexRepository(db, [adapter], { rootDir: tempDir }, DEFAULT_CONFIG);
    expect(first.filesIndexed).toBeGreaterThan(0);
    expect(second.filesIndexed).toBe(0);
    expect(second.filesSkipped).toBeGreaterThan(0);
  });

  it("does not fall back to a full scan when changedOnly has an empty git diff", async () => {
    execSync("git init", { cwd: tempDir, stdio: "ignore" });
    execSync("git config user.email test@example.com", { cwd: tempDir, stdio: "ignore" });
    execSync("git config user.name Test", { cwd: tempDir, stdio: "ignore" });
    execSync("git add src/a.ts", { cwd: tempDir, stdio: "ignore" });
    execSync("git commit -m initial", { cwd: tempDir, stdio: "ignore" });

    const adapter = new MockAdapter();
    const summary = await indexRepository(
      db,
      [adapter],
      { rootDir: tempDir, changedOnly: true },
      DEFAULT_CONFIG
    );

    expect(summary.filesScanned).toBe(0);
    expect(summary.filesIndexed).toBe(0);
    expect(summary.filesSkipped).toBe(0);
  });

  it("removes stale graph data for deleted git-diff files", async () => {
    execSync("git init", { cwd: tempDir, stdio: "ignore" });
    execSync("git config user.email test@example.com", { cwd: tempDir, stdio: "ignore" });
    execSync("git config user.name Test", { cwd: tempDir, stdio: "ignore" });
    execSync("git add src/a.ts", { cwd: tempDir, stdio: "ignore" });
    execSync("git commit -m initial", { cwd: tempDir, stdio: "ignore" });

    const adapter = new MockAdapter();
    await indexRepository(db, [adapter], { rootDir: tempDir, full: true }, DEFAULT_CONFIG);
    expect(db.getEntity(buildUid("file", "src/a.ts"))).toBeDefined();
    expect(db.getFileHash("src/a.ts")).toBeDefined();

    fs.rmSync(path.join(tempDir, "src", "a.ts"));
    const summary = await indexRepository(
      db,
      [adapter],
      { rootDir: tempDir, changedOnly: true },
      DEFAULT_CONFIG
    );

    expect(summary.filesIndexed).toBe(0);
    expect(db.getEntity(buildUid("file", "src/a.ts"))).toBeUndefined();
    expect(db.getFileHash("src/a.ts")).toBeUndefined();
  });

  it("removes old graph data when git reports a rename", async () => {
    execSync("git init", { cwd: tempDir, stdio: "ignore" });
    execSync("git config user.email test@example.com", { cwd: tempDir, stdio: "ignore" });
    execSync("git config user.name Test", { cwd: tempDir, stdio: "ignore" });
    execSync("git add src/a.ts", { cwd: tempDir, stdio: "ignore" });
    execSync("git commit -m initial", { cwd: tempDir, stdio: "ignore" });

    const adapter = new MockAdapter();
    await indexRepository(db, [adapter], { rootDir: tempDir, full: true }, DEFAULT_CONFIG);
    execSync("git mv src/a.ts src/renamed.ts", { cwd: tempDir, stdio: "ignore" });

    const summary = await indexRepository(
      db,
      [adapter],
      { rootDir: tempDir, changedOnly: true },
      DEFAULT_CONFIG
    );

    expect(summary.filesIndexed).toBe(1);
    expect(db.getEntity(buildUid("file", "src/a.ts"))).toBeUndefined();
    expect(db.getFileHash("src/a.ts")).toBeUndefined();
    expect(db.getEntity(buildUid("file", "src/renamed.ts"))).toBeDefined();
  });

  it("canonicalizes extensionless file import relations to discovered files", async () => {
    fs.writeFileSync(path.join(tempDir, "src", "b.ts"), "export const b = 1;\n", "utf8");
    class ImportAdapter extends MockAdapter {
      override async parseFile(filePath: string): Promise<ParseResult> {
        const parsed = await super.parseFile(filePath);
        if (filePath === "src/a.ts") {
          parsed.relations.push({
            from: buildUid("file", "src/a.ts"),
            to: buildUid("file", "src/b"),
            kind: "imports",
            confidence: 0.9,
            provenance: [{ source: "ast", timestamp: stableNowIso(), confidence: 0.9 }]
          });
        }
        return parsed;
      }
    }

    await indexRepository(db, [new ImportAdapter()], { rootDir: tempDir, full: true }, DEFAULT_CONFIG);

    expect(
      db
        .getRelationsFrom(buildUid("file", "src/a.ts"))
        .some((relation) => relation.kind === "imports" && relation.to === buildUid("file", "src/b.ts"))
    ).toBe(true);
  });

  it("rolls back per-file graph writes when indexing a file fails", async () => {
    const adapter = new MockAdapter();
    await indexRepository(db, [adapter], { rootDir: tempDir, full: true }, DEFAULT_CONFIG);
    const oldHash = db.getFileHash("src/a.ts");

    fs.writeFileSync(path.join(tempDir, "src", "a.ts"), "export const a = 2;\n", "utf8");
    class BadRelationAdapter extends MockAdapter {
      override async parseFile(filePath: string): Promise<ParseResult> {
        const parsed = await super.parseFile(filePath);
        parsed.relations.push({
          from: undefined,
          to: buildUid("function", filePath, "demo"),
          kind: "calls",
          confidence: 1,
          provenance: [{ source: "ast", timestamp: stableNowIso(), confidence: 1 }]
        } as any);
        return parsed;
      }
    }

    await expect(
      indexRepository(db, [new BadRelationAdapter()], { rootDir: tempDir, full: true }, DEFAULT_CONFIG)
    ).rejects.toThrow();

    expect(db.getEntity(buildUid("file", "src/a.ts"))).toBeDefined();
    expect(db.getEntity(buildUid("function", "src/a.ts", "demo"))).toBeDefined();
    expect(db.getFileHash("src/a.ts")).toBe(oldHash);
  });
});
