import { describe, expect, it } from "vitest";
import { program } from "./index.ts";

describe("CLI surface", () => {
  it("keeps top-level help stable", () => {
    expect(program.helpInformation()).toMatchInlineSnapshot(`
      "Usage: dsp [options] [command]

      DSP v2 context compiler

      Options:
        -V, --version                                                            output the version number
        -h, --help                                                               display help for command

      Commands:
        init [options] [rootDir]
        index [options] [rootDir]
        bootstrap [options] [rootDir]
        update [options] [rootDir]
        changed [options] [rootDir]
        explain [options] <uidOrPath> [rootDir]
        graph [options] <uidOrPath> [rootDir]
        get-entity [options] <uidOrPath> [rootDir]
        find-by-source [options] <sourcePath> [rootDir]
        get-children [options] <uidOrPath> [rootDir]
        get-parents [options] <uidOrPath> [rootDir]
        get-path [options] <fromUidOrPath> <toUidOrPath> [rootDir]
        read-toc [options] [rootDir]
        get-stats [options] [rootDir]
        detect-cycles [options] [rootDir]
        get-orphans [options] [rootDir]
        create-object [options] <source> <purpose> [rootDir]
        create-function [options] <source> <purpose> [rootDir]
        create-shared [options] <exporterUid> <sharedUids...>
        add-import [options] <importerUid> <importedUid> <why> [rootDir]
        update-description [options] <uid> [rootDir]
        update-import-why [options] <importerUid> <importedUid> <why> [rootDir]
        move-entity [options] <uid> <newSource> [rootDir]
        remove-import [options] <importerUid> <importedUid> [rootDir]
        remove-shared [options] <exporterUid> <sharedUid> [rootDir]
        remove-entity [options] <uid> [rootDir]
        search [options] <query> [rootDir]
        impact [options] <uidOrPath> [rootDir]
        validate [options] [rootDir]
        repair [options] [rootDir]
        export [options] [rootDir]
        import [options] <jsonPath> [rootDir]
        mcp [rootDir]
        precommit-check [options] [rootDir]
        ci                                                                       CI helpers
        cache                                                                    Cache utilities
        embeddings                                                               Embeddings utilities
        markers                                                                  Stable UID source marker utilities
        help [command]                                                           display help for command
      "
    `);
  });
});
