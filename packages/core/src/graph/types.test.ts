import { describe, expect, it } from "vitest";
import type { EntityUid, FileUid } from "./types.ts";
import { asEntityUid, buildEntityUid, buildFileUid } from "./uid.ts";

describe("graph branded uid helpers", () => {
  it("brands entity UIDs without changing runtime strings", () => {
    const fileUid: FileUid = buildFileUid("src/auth.ts");
    const functionUid: EntityUid<"function"> = buildEntityUid("function", "src/auth.ts", "login");
    const existing: EntityUid = asEntityUid("function:src/auth.ts#login");

    expect(fileUid).toBe("file:src/auth.ts");
    expect(functionUid).toBe("function:src/auth.ts#login");
    expect(existing).toBe("function:src/auth.ts#login");
  });
});
