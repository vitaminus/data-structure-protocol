import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createTypeScriptLanguageAdapter } from "../../../language-typescript/src/index.ts";
import { ParseWorkerPool } from "./parse-pool.ts";

describe("ParseWorkerPool", () => {
  let pool: ParseWorkerPool | undefined;

  afterEach(async () => {
    await pool?.close();
  });

  it("parses builtin adapters in worker threads", async () => {
    const adapter = createTypeScriptLanguageAdapter();
    pool = new ParseWorkerPool(2, true);

    const result = await pool.run(
      adapter.worker!,
      "src/demo.ts",
      "export function demo() { return helper(); }\nfunction helper() { return 1; }\n"
    );

    expect(result.entities.some((entity) => entity.name === "demo")).toBe(true);
    expect(result.relations.some((relation) => relation.kind === "exports")).toBe(true);
  });

  it("rejects oversized worker inputs before dispatch", async () => {
    const adapter = createTypeScriptLanguageAdapter();
    pool = new ParseWorkerPool(1, true, { maxInputBytes: 16 * 1024 });
    const oversized = `export const demo = "${"x".repeat(20 * 1024)}";\n`;

    await expect(pool.run(adapter.worker!, "src/demo.ts", oversized)).rejects.toThrow("input too large");
  });

  it("times out stuck workers and recovers the pool", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-worker-timeout-"));
    const workerModule = path.join(tempDir, "hanging-worker.mjs");
    fs.writeFileSync(
      workerModule,
      "export async function parseForever() { return await new Promise(() => {}); }\n",
      "utf8"
    );
    pool = new ParseWorkerPool(1, false, { timeoutMs: 50 });

    await expect(
      pool.run(
        {
          moduleUrl: pathToFileURL(workerModule).href,
          exportName: "parseForever"
        },
        "src/hang.ts",
        "export const hang = true;\n"
      )
    ).rejects.toThrow("timed out");

    const adapter = createTypeScriptLanguageAdapter();
    const recovered = await pool.run(adapter.worker!, "src/demo.ts", "export const demo = 1;\n");
    expect(recovered.entities.some((entity) => entity.name === "demo")).toBe(true);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
