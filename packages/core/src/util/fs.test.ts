import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverFiles } from "./fs.ts";

describe("discoverFiles", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("reuses the cached discovery manifest when the fingerprint is unchanged", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-fs-test-"));
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src", "a.ts"), "export const a = 1;\n", "utf8");

    const first = discoverFiles(tempDir);
    expect(first.map((filePath) => path.basename(filePath))).toEqual(["a.ts"]);

    const originalReaddirSync = fs.readdirSync.bind(fs);
    vi.spyOn(fs, "readdirSync").mockImplementation(((target: fs.PathLike, options?: any) => {
      if (String(target) !== tempDir) {
        throw new Error("should not scan nested directories on a manifest cache hit");
      }
      return originalReaddirSync(target, options);
    }) as typeof fs.readdirSync);

    vi.spyOn(fs, "readFileSync");

    const second = discoverFiles(tempDir);
    expect(second).toEqual(first);
    expect(fs.readFileSync).toHaveBeenCalledWith(path.join(tempDir, ".dsp", "discovery-manifest.json"), "utf8");
  });
});
