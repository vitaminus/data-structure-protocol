import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageAdapter, ParseResult } from "../graph/types.ts";
import { DEFAULT_CONFIG } from "../config/types.ts";
import { DSPDatabase } from "../storage/db.ts";
import { indexRepository } from "./indexer.ts";
import { buildUid, stableNowIso } from "../graph/uid.ts";

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

  it("uses @dsp source markers as stable canonical entity UIDs", async () => {
    fs.writeFileSync(
      path.join(tempDir, "src", "a.ts"),
      "// @dsp func-1234abcd\nexport function demo() {}\n",
      "utf8"
    );
    class MarkedAdapter extends MockAdapter {
      override async parseFile(filePath: string): Promise<ParseResult> {
        const now = stableNowIso();
        return {
          entities: [
            {
              uid: buildUid("function", filePath, "demo"),
              kind: "function",
              name: "demo",
              path: filePath,
              language: "typescript",
              startLine: 2,
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
    }

    await indexRepository(db, [new MarkedAdapter()], { rootDir: tempDir, full: true }, DEFAULT_CONFIG);
    expect(db.getEntity("func-1234abcd")?.metadata?.structuralUid).toBe(buildUid("function", "src/a.ts", "demo"));
    expect(db.getEntity(buildUid("function", "src/a.ts", "demo"))).toBeUndefined();
    expect(db.getRelationsFrom(buildUid("file", "src/a.ts")).some((relation) => relation.to === "func-1234abcd")).toBe(true);
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

  it("produces the same graph snapshot with serial and parallel parsing", async () => {
    const makeFixture = () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-indexer-parallel-snapshot-"));
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
      fs.writeFileSync(path.join(root, "src", "b.ts"), "export const b = 1;\n", "utf8");
      fs.writeFileSync(path.join(root, "src", "c.ts"), "export const c = 1;\n", "utf8");
      return root;
    };
    const indexFixture = async (parallelism: number) => {
      const root = makeFixture();
      const fixtureDb = new DSPDatabase(root);
      try {
        await indexRepository(
          fixtureDb,
          [new MockAdapter()],
          { rootDir: root, full: true },
          {
            ...DEFAULT_CONFIG,
            performance: { ...DEFAULT_CONFIG.performance, parallelism }
          }
        );
        return fixtureDb.getSnapshot();
      } finally {
        fixtureDb.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    try {
      const serial = await indexFixture(1);
      const parallel = await indexFixture(4);

      expect(JSON.stringify(parallel)).toBe(JSON.stringify(serial));
    } finally {
      vi.useRealTimers();
    }
  });

  it("limits parse concurrency with performance.parallelism", async () => {
    for (const name of ["b", "c", "d", "e", "f"]) {
      fs.writeFileSync(path.join(tempDir, "src", `${name}.ts`), `export const ${name} = 1;\n`, "utf8");
    }
    class SlowAdapter extends MockAdapter {
      inFlight = 0;
      maxInFlight = 0;

      override async parseFile(filePath: string): Promise<ParseResult> {
        this.inFlight += 1;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        this.inFlight -= 1;
        return super.parseFile(filePath);
      }
    }
    const adapter = new SlowAdapter();

    await indexRepository(
      db,
      [adapter],
      { rootDir: tempDir, full: true },
      {
        ...DEFAULT_CONFIG,
        performance: { ...DEFAULT_CONFIG.performance, parallelism: 4 }
      }
    );

    expect(adapter.maxInFlight).toBeGreaterThan(1);
    expect(adapter.maxInFlight).toBeLessThanOrEqual(4);
  });

  it("marks the index run failed when a parallel parse fails without refreshing existing file data", async () => {
    fs.writeFileSync(path.join(tempDir, "src", "b.ts"), "export const b = 1;\n", "utf8");
    await indexRepository(db, [new MockAdapter()], { rootDir: tempDir, full: true }, DEFAULT_CONFIG);
    const oldHashA = db.getFileHash("src/a.ts");
    const oldHashB = db.getFileHash("src/b.ts");

    fs.writeFileSync(path.join(tempDir, "src", "a.ts"), "export const a = 2;\n", "utf8");
    fs.writeFileSync(path.join(tempDir, "src", "b.ts"), "export const b = 2;\n", "utf8");
    class FailingAdapter extends MockAdapter {
      override async parseFile(filePath: string): Promise<ParseResult> {
        if (filePath === "src/b.ts") {
          throw new Error("boom");
        }
        return super.parseFile(filePath);
      }
    }

    await expect(
      indexRepository(
        db,
        [new FailingAdapter()],
        { rootDir: tempDir, full: true },
        {
          ...DEFAULT_CONFIG,
          performance: { ...DEFAULT_CONFIG.performance, parallelism: 4 }
        }
      )
    ).rejects.toThrow("boom");

    const sqlite = new Database(db.dbPath, { readonly: true });
    const latestRun = sqlite
      .prepare("SELECT status FROM index_runs ORDER BY id DESC LIMIT 1")
      .get() as { status: string };
    sqlite.close();

    expect(latestRun.status).toBe("failed");
    expect(db.getFileHash("src/a.ts")).toBe(oldHashA);
    expect(db.getFileHash("src/b.ts")).toBe(oldHashB);
    expect(db.getEntity(buildUid("function", "src/a.ts", "demo"))).toBeDefined();
    expect(db.getEntity(buildUid("function", "src/b.ts", "demo"))).toBeDefined();
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

  it("reconciles unchanged git renames by content hash", async () => {
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

    expect(summary.filesIndexed).toBe(0);
    expect(summary.filesSkipped).toBe(1);
    expect(db.getEntity(buildUid("file", "src/a.ts"))).toBeUndefined();
    expect(db.getFileHash("src/a.ts")).toBeUndefined();
    expect(db.getEntity(buildUid("file", "src/renamed.ts"))).toBeDefined();
    expect(db.getEntity(buildUid("function", "src/a.ts", "demo"))).toBeUndefined();
    expect(db.getEntity(buildUid("function", "src/renamed.ts", "demo"))).toBeDefined();
    expect(db.getRelationsFrom(buildUid("file", "src/renamed.ts")).some((relation) => relation.kind === "contains")).toBe(
      true
    );
  });

  it("reindexes moved files when content changed during rename", async () => {
    execSync("git init", { cwd: tempDir, stdio: "ignore" });
    execSync("git config user.email test@example.com", { cwd: tempDir, stdio: "ignore" });
    execSync("git config user.name Test", { cwd: tempDir, stdio: "ignore" });
    execSync("git add src/a.ts", { cwd: tempDir, stdio: "ignore" });
    execSync("git commit -m initial", { cwd: tempDir, stdio: "ignore" });

    const adapter = new MockAdapter();
    await indexRepository(db, [adapter], { rootDir: tempDir, full: true }, DEFAULT_CONFIG);
    execSync("git mv src/a.ts src/renamed.ts", { cwd: tempDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tempDir, "src", "renamed.ts"), "export const a = 2;\n", "utf8");

    const summary = await indexRepository(
      db,
      [adapter],
      { rootDir: tempDir, changedOnly: true },
      DEFAULT_CONFIG
    );

    expect(summary.filesIndexed).toBe(1);
    expect(db.getEntity(buildUid("file", "src/a.ts"))).toBeUndefined();
    expect(db.getFileHash("src/a.ts")).toBeUndefined();
    expect(db.getEntity(buildUid("function", "src/renamed.ts", "demo"))).toBeDefined();
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

  it("resumes full indexing from the last completed checkpoint batch", async () => {
    for (let index = 0; index < 40; index += 1) {
      fs.writeFileSync(path.join(tempDir, "src", `file-${index}.ts`), `export const value${index} = ${index};\n`, "utf8");
    }

    const adapter = new MockAdapter();
    const config = {
      ...DEFAULT_CONFIG,
      performance: { ...DEFAULT_CONFIG.performance, parallelism: 4 }
    };
    const originalReplaceAstFiles = db.replaceAstFiles.bind(db);
    let replaceCalls = 0;
    db.replaceAstFiles = ((files) => {
      replaceCalls += 1;
      if (replaceCalls === 2) {
        throw new Error("simulated batch write failure");
      }
      originalReplaceAstFiles(files);
    }) as typeof db.replaceAstFiles;

    await expect(indexRepository(db, [adapter], { rootDir: tempDir, full: true }, config)).rejects.toThrow(
      "simulated batch write failure"
    );

    const checkpoint = db.getCheckpoint(`index:${path.resolve(tempDir)}`);
    expect(checkpoint?.metadata.manifestHash).toBeTruthy();
    expect((checkpoint?.metadata.completedFiles as string[] | undefined)?.length).toBe(32);

    db.replaceAstFiles = originalReplaceAstFiles;
    const summary = await indexRepository(db, [adapter], { rootDir: tempDir, full: true }, config);

    expect(summary.filesIndexed).toBe(41);
    expect(db.getCheckpoint(`index:${path.resolve(tempDir)}`)).toBeUndefined();
    expect(db.getEntity(buildUid("file", "src/file-0.ts"))).toBeDefined();
    expect(db.getEntity(buildUid("file", "src/file-39.ts"))).toBeDefined();
  });
});
