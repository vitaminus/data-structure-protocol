import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("workingTreeFingerprint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unmock("node:child_process");
  });

  it("builds a lightweight fingerprint from HEAD, index metadata, and dirty paths", async () => {
    vi.mock("node:child_process", () => ({
      execSync: vi.fn((command: string) => {
        if (command === "git rev-parse HEAD") {
          return "abc123\n";
        }
        if (command === "git rev-parse --git-dir") {
          return ".git\n";
        }
        if (command === "git ls-files -m -d -o --exclude-standard --directory -z") {
          return "src/a.ts\0tmp/\0";
        }
        throw new Error(`unexpected command: ${command}`);
      })
    }));
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "statSync").mockReturnValue({
      mtimeMs: 1234.9,
      size: 4096
    } as fs.Stats);

    const { workingTreeFingerprint } = await import("./git.ts");

    expect(workingTreeFingerprint("/repo")).toBe(["abc123", "1234:4096", "src/a.ts\0tmp/\0"].join("\0"));
  });
});
