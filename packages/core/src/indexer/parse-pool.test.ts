import { afterEach, describe, expect, it } from "vitest";
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
});
