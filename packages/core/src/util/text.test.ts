import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyTextBuffer, readUtf8FileSafe, readUtf8PrefixSafe } from "./text.ts";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("classifyTextBuffer", () => {
  it("accepts valid UTF-8 text", () => {
    const result = classifyTextBuffer(Buffer.from("export const ok = true;\n", "utf8"));
    expect(result).toEqual({ kind: "text", content: "export const ok = true;\n" });
  });

  it("marks null-byte payloads as binary", () => {
    const result = classifyTextBuffer(Buffer.from([0x61, 0x00, 0x62]));
    expect(result).toEqual({ kind: "binary" });
  });

  it("marks malformed UTF-8 as invalidUtf8", () => {
    const result = classifyTextBuffer(Buffer.from([0xc3, 0x28]));
    expect(result).toEqual({ kind: "invalidUtf8" });
  });

  it("reads whole files safely", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-text-test-"));
    const filePath = path.join(tempDir, "sample.ts");
    fs.writeFileSync(filePath, "export const ok = true;\n", "utf8");

    expect(readUtf8FileSafe(filePath)).toEqual({ kind: "text", content: "export const ok = true;\n" });
  });

  it("reads UTF-8 prefixes safely", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-text-prefix-test-"));
    const filePath = path.join(tempDir, "sample.ts");
    fs.writeFileSync(filePath, "line1\nline2\nline3\n", "utf8");

    expect(readUtf8PrefixSafe(filePath, 6)).toEqual({ kind: "text", content: "line1\n", truncated: true });
  });
});
