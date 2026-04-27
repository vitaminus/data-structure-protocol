import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDSP } from "@dsp/core";
import { buildUid, stableNowIso } from "@dsp/core";
import { dispatchToolCall } from "./index.js";

describe("mcp tool dispatcher", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-mcp-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns entity and context pack payloads", async () => {
    const services = openDSP(tempDir, []);
    const now = stableNowIso();
    const uid = buildUid("function", "src/auth.ts", "login");
    services.db.upsertEntity({
      uid,
      kind: "function",
      name: "login",
      path: "src/auth.ts",
      confidence: 1,
      description: "auth function",
      provenance: [{ source: "ast", timestamp: now, confidence: 1 }],
      createdAt: now,
      updatedAt: now
    });

    const entityResponse = await dispatchToolCall(services, "dsp.get_entity", { uid });
    expect(entityResponse.content[0]?.text.includes("login")).toBe(true);

    const searchResponse = await dispatchToolCall(services, "dsp.search", {
      query: "auth"
    });
    expect(searchResponse.content[0]?.text.includes(uid)).toBe(true);

    const contextResponse = await dispatchToolCall(services, "dsp.get_context_pack", {
      task: "update auth"
    });
    expect(contextResponse.content[0]?.text.includes("estimatedTokens")).toBe(true);
    services.db.close();
  });
});
