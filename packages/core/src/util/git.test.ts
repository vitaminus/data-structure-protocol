import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("git utilities", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unmock("node:child_process");
  });

  it("builds a lightweight fingerprint from HEAD, index metadata, and dirty paths", async () => {
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn((command: string, args: string[]) => {
        expect(command).toBe("git");
        const key = args.join(" ");
        if (key === "rev-parse HEAD") {
          return "abc123\n";
        }
        if (key === "rev-parse --git-dir") {
          return ".git\n";
        }
        if (key === "ls-files -m -d -o --exclude-standard --directory -z") {
          return "src/a.ts\0tmp/\0";
        }
        throw new Error(`unexpected args: ${key}`);
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

  it("parses rename and copy diff entries without shell interpolation", async () => {
    const execFileSync = vi.fn((_command: string, args: string[]) => {
      expect(args).toEqual(["diff", "--name-status", "origin/main", "--"]);
      return ["R100\tsrc/old.ts\tsrc/new.ts", "C100\tsrc/copy-source.ts\tsrc/copy-target.ts", "D\tsrc/deleted.ts"].join(
        "\n"
      );
    });
    vi.doMock("node:child_process", () => ({ execFileSync }));

    const { changedFileEntriesFromGit } = await import("./git.ts");
    expect(changedFileEntriesFromGit("/repo", "origin/main")).toEqual([
      {
        status: "R100",
        oldPath: path.resolve("/repo", "src/old.ts"),
        path: path.resolve("/repo", "src/new.ts")
      },
      {
        status: "C100",
        oldPath: path.resolve("/repo", "src/copy-source.ts"),
        path: path.resolve("/repo", "src/copy-target.ts")
      },
      {
        status: "D",
        path: path.resolve("/repo", "src/deleted.ts")
      }
    ]);
  });

  it("resolves merge-base diff mode through git merge-base", async () => {
    const execFileSync = vi.fn((_command: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "merge-base origin/main HEAD") {
        return "abc123\n";
      }
      if (key === "diff --name-status abc123 --") {
        return "M\tsrc/auth.ts\n";
      }
      throw new Error(`unexpected args: ${key}`);
    });
    vi.doMock("node:child_process", () => ({ execFileSync }));

    const { changedFilesFromGit } = await import("./git.ts");
    expect(changedFilesFromGit("/repo", "merge-base:origin/main")).toEqual([path.resolve("/repo", "src/auth.ts")]);
  });

  it("rejects invalid base refs before invoking git", async () => {
    const execFileSync = vi.fn();
    vi.doMock("node:child_process", () => ({ execFileSync }));

    const { changedFilesFromGit } = await import("./git.ts");
    expect(() => changedFilesFromGit("/repo", "origin/main; rm -rf /")).toThrow("Invalid git base ref");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("lists staged files with argument-based git execution", async () => {
    const execFileSync = vi.fn((_command: string, args: string[]) => {
      expect(args).toEqual(["diff", "--cached", "--name-only", "--"]);
      return "src/a.ts\nsrc/b.ts\n";
    });
    vi.doMock("node:child_process", () => ({ execFileSync }));

    const { changedFilesStaged } = await import("./git.ts");
    expect(changedFilesStaged("/repo")).toEqual([path.resolve("/repo", "src/a.ts"), path.resolve("/repo", "src/b.ts")]);
  });
});
