import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

  it("skips unchanged files on second run", async () => {
    const adapter = new MockAdapter();
    const first = await indexRepository(db, [adapter], { rootDir: tempDir }, DEFAULT_CONFIG);
    const second = await indexRepository(db, [adapter], { rootDir: tempDir }, DEFAULT_CONFIG);
    expect(first.filesIndexed).toBeGreaterThan(0);
    expect(second.filesIndexed).toBe(0);
    expect(second.filesSkipped).toBeGreaterThan(0);
  });
});
