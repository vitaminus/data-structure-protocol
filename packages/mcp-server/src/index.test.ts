import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDSP } from "@dsp/core";
import { buildUid, stableNowIso } from "@dsp/core";
import { dispatchToolCall, TOOLS } from "./index.ts";

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

  it("keeps tool schemas stable", () => {
    expect(TOOLS.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema }))).toMatchInlineSnapshot(`
      [
        {
          "inputSchema": {
            "properties": {
              "query": {
                "type": "string",
              },
              "topK": {
                "type": "number",
              },
            },
            "required": [
              "query",
            ],
            "type": "object",
          },
          "name": "dsp.search",
        },
        {
          "inputSchema": {
            "properties": {
              "query": {
                "type": "string",
              },
              "topK": {
                "type": "number",
              },
            },
            "required": [
              "query",
            ],
            "type": "object",
          },
          "name": "dsp.semantic_search",
        },
        {
          "inputSchema": {
            "properties": {
              "uid": {
                "type": "string",
              },
            },
            "required": [
              "uid",
            ],
            "type": "object",
          },
          "name": "dsp.get_entity",
        },
        {
          "inputSchema": {
            "properties": {
              "depth": {
                "type": "number",
              },
              "maxEntities": {
                "type": "number",
              },
              "maxRelations": {
                "type": "number",
              },
              "uid": {
                "type": "string",
              },
            },
            "required": [
              "uid",
            ],
            "type": "object",
          },
          "name": "dsp.get_neighbors",
        },
        {
          "inputSchema": {
            "properties": {
              "target": {
                "type": "string",
              },
            },
            "required": [
              "target",
            ],
            "type": "object",
          },
          "name": "dsp.impact",
        },
        {
          "inputSchema": {
            "properties": {},
            "type": "object",
          },
          "name": "dsp.validate",
        },
        {
          "inputSchema": {
            "properties": {
              "from": {
                "type": "string",
              },
              "to": {
                "type": "string",
              },
            },
            "required": [
              "from",
              "to",
            ],
            "type": "object",
          },
          "name": "dsp.explain_path",
        },
        {
          "inputSchema": {
            "properties": {},
            "type": "object",
          },
          "name": "dsp.list_changed",
        },
        {
          "inputSchema": {
            "properties": {
              "includeCode": {
                "type": "string",
              },
              "includeTests": {
                "type": "boolean",
              },
              "maxDepth": {
                "type": "number",
              },
              "maxFiles": {
                "type": "number",
              },
              "maxTokens": {
                "type": "number",
              },
              "strategy": {
                "type": "string",
              },
              "task": {
                "type": "string",
              },
            },
            "required": [
              "task",
            ],
            "type": "object",
          },
          "name": "dsp.get_context_pack",
        },
      ]
    `);
  });
});
