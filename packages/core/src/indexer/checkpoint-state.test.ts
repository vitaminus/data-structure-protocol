import { describe, expect, it } from "vitest";
import { normalizeCheckpointState } from "./indexer.ts";

describe("normalizeCheckpointState", () => {
  it("returns undefined for mismatched manifests", () => {
    expect(normalizeCheckpointState({ manifestHash: "other", completedFiles: ["src/a.ts"] }, "expected", ["src/a.ts"])).toBeUndefined();
  });

  it("drops corrupt fields and filters completed files to the current manifest", () => {
    const result = normalizeCheckpointState(
      {
        manifestHash: "expected",
        completedFiles: ["src/a.ts", 7, "src/a.ts", "src/missing.ts"],
        filesIndexed: -10,
        filesSkipped: "3",
        languages: ["typescript", 5, "typescript", "ruby"],
        entities: "9",
        relations: Number.POSITIVE_INFINITY,
        unresolvedReferences: -1,
        lowConfidenceRelations: "2"
      },
      "expected",
      ["src/a.ts", "src/b.ts"]
    );

    expect(result).toEqual({
      manifestHash: "expected",
      completedFiles: ["src/a.ts"],
      filesIndexed: 1,
      filesSkipped: 3,
      languages: ["ruby", "typescript"],
      entities: 9,
      relations: 0,
      unresolvedReferences: 0,
      lowConfidenceRelations: 2
    });
  });

  it("returns undefined when no valid completed files remain", () => {
    expect(
      normalizeCheckpointState(
        {
          manifestHash: "expected",
          completedFiles: ["src/ghost.ts"]
        },
        "expected",
        ["src/a.ts"]
      )
    ).toBeUndefined();
  });
});
