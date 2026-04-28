import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DSPDatabase } from "../storage/db.js";
import { buildUid, stableNowIso } from "../graph/uid.js";
import { semanticSearch } from "./search.js";

describe("semantic search", () => {
  let tempDir: string;
  let db: DSPDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-search-test-"));
    db = new DSPDatabase(tempDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("ranks camelCase exact token matches above weaker substring matches", async () => {
    const now = stableNowIso();
    const createUser = buildUid("function", "src/users.ts", "createUser");
    const session = buildUid("function", "src/session.ts", "createUserSession");

    for (const entity of [
      {
        uid: createUser,
        name: "createUser",
        description: "Creates an account"
      },
      {
        uid: session,
        name: "createUserSession",
        description: "Creates a session for a user account"
      }
    ]) {
      db.upsertEntity({
        ...entity,
        kind: "function",
        path: entity.uid.includes("users") ? "src/users.ts" : "src/session.ts",
        confidence: 1,
        provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
        createdAt: now,
        updatedAt: now
      });
    }

    const results = await semanticSearch(db, "create user", { topK: 2 });

    expect(results[0]?.uid).toBe(createUser);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it("uses neighbor text as a lightweight ranking signal", async () => {
    const now = stableNowIso();
    const login = buildUid("function", "src/auth.ts", "login");
    const token = buildUid("function", "src/token.ts", "createToken");

    for (const [uid, name, filePath] of [
      [login, "login", "src/auth.ts"],
      [token, "createToken", "src/token.ts"]
    ] as const) {
      db.upsertEntity({
        uid,
        kind: "function",
        name,
        path: filePath,
        confidence: 1,
        provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
        createdAt: now,
        updatedAt: now
      });
    }
    db.upsertRelation({
      from: login,
      to: token,
      kind: "calls",
      confidence: 1,
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }]
    });

    const results = await semanticSearch(db, "token", { topK: 5 });

    expect(results.map((result) => result.uid)).toContain(login);
    expect(results.find((result) => result.uid === login)?.explanation).toContain("neighbors=");
  });
});
