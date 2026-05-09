import { describe, expect, it } from "vitest";
import { safeJsonParse } from "./json.ts";

describe("safeJsonParse", () => {
  it("parses valid JSON", () => {
    expect(safeJsonParse('{"ok":true}', {})).toEqual({ ok: true, value: { ok: true } });
  });

  it("returns the fallback for invalid JSON", () => {
    expect(safeJsonParse("{broken", { ok: false })).toEqual({ ok: false, value: { ok: false } });
  });

  it("treats null as an empty successful fallback", () => {
    expect(safeJsonParse(null, { ok: false })).toEqual({ ok: true, value: { ok: false } });
  });
});
