import { describe, expect, it } from "vitest";
import { buildUid, normalizePath } from "./uid.js";

describe("uid generation", () => {
  it("is deterministic for file and symbol", () => {
    const a = buildUid("function", "src/auth/service.ts", "createUser");
    const b = buildUid("function", "src/auth/service.ts", "createUser");
    expect(a).toBe(b);
  });

  it("normalizes separators", () => {
    expect(normalizePath("src\\auth\\service.ts")).toBe("src/auth/service.ts");
  });
});
