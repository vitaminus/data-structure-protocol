import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openDSP,
  runContextPack,
  runExport,
  runImport,
  runIndex,
  runMarkersApply,
  runValidate
} from "../../packages/core/src/api.ts";
import { buildUid } from "../../packages/core/src/graph/uid.ts";
import { createTypeScriptLanguageAdapter } from "../../packages/language-typescript/src/index.ts";
import { PythonLanguageAdapter } from "../../packages/language-python/src/index.ts";
import { RubyLanguageAdapter } from "../../packages/language-ruby/src/index.ts";
import { RustLanguageAdapter } from "../../packages/language-rust/src/index.ts";

const fixtureRoot = path.resolve("tests/fixtures/polyglot-auth");

function adapters() {
  return [
    createTypeScriptLanguageAdapter(),
    new PythonLanguageAdapter(),
    new RubyLanguageAdapter(),
    new RustLanguageAdapter()
  ];
}

function initGitRepo(rootDir: string): void {
  execSync("git init", { cwd: rootDir, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: rootDir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: rootDir, stdio: "ignore" });
  execSync("git add .", { cwd: rootDir, stdio: "ignore" });
  execSync("git commit -m initial", { cwd: rootDir, stdio: "ignore" });
}

describe("DSP integration contract", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-contract-test-"));
    fs.cpSync(fixtureRoot, tempDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("indexes, validates, exports, imports, and builds context for a polyglot fixture", async () => {
    const services = openDSP(tempDir, adapters());
    try {
      const summary = await runIndex(services, { rootDir: tempDir, full: true });
      expect(summary.filesIndexed).toBeGreaterThan(3);
      expect(summary.languages).toEqual(expect.arrayContaining(["typescript", "python", "ruby", "rust"]));

      const validation = runValidate(services);
      expect(validation.issues).toEqual([]);

      const pack = await runContextPack(services, {
        task: "change auth token validation",
        includeCode: "snippets-only",
        maxFiles: 8
      });
      expect(pack.files.some((file) => file.includes("auth"))).toBe(true);
      expect(pack.estimatedTokens).toBeGreaterThan(0);

      runExport(services, "protocol");
      expect(fs.existsSync(path.join(tempDir, ".dsp", "protocol", "TOC"))).toBe(true);

      const exportPath = path.join(tempDir, ".dsp", "graph.json");
      runExport(services, "json", exportPath);
      const imported = runImport(services, exportPath);
      expect(imported.entities).toBeGreaterThan(0);

      const validationAfterRoundTrip = runValidate(services);
      expect(validationAfterRoundTrip.issues).toEqual([]);
    } finally {
      services.db.close();
    }
  });

  it("cleans stale graph data for changed-only rename and delete updates", async () => {
    initGitRepo(tempDir);
    const services = openDSP(tempDir, adapters());
    try {
      await runIndex(services, { rootDir: tempDir, full: true });
      expect(services.db.getEntity(buildUid("file", "src/auth/AuthService.ts"))).toBeDefined();
      expect(services.db.getEntity(buildUid("file", "app/models/user.rb"))).toBeDefined();

      execSync("git mv src/auth/AuthService.ts src/auth/TokenService.ts", {
        cwd: tempDir,
        stdio: "ignore"
      });
      fs.rmSync(path.join(tempDir, "app", "models", "user.rb"));

      const summary = await runIndex(services, { rootDir: tempDir, changedOnly: true });

      expect(summary.filesScanned).toBeGreaterThan(0);
      expect(services.db.getEntity(buildUid("file", "src/auth/AuthService.ts"))).toBeUndefined();
      expect(services.db.getEntity(buildUid("file", "src/auth/TokenService.ts"))).toBeDefined();
      expect(services.db.getEntity(buildUid("file", "app/models/user.rb"))).toBeUndefined();
      expect(runValidate(services).issues).toEqual([]);
    } finally {
      services.db.close();
    }
  });

  it("applies stable markers after a dry run without changing files first", async () => {
    const services = openDSP(tempDir, adapters());
    try {
      await runIndex(services, { rootDir: tempDir, full: true });
      const target = path.join(tempDir, "src", "auth", "AuthService.ts");
      const before = fs.readFileSync(target, "utf8");

      const dryRun = runMarkersApply(services, { dryRun: true });
      expect(dryRun.markersInserted).toBeGreaterThan(0);
      expect(fs.readFileSync(target, "utf8")).toBe(before);

      const applied = runMarkersApply(services);
      expect(applied.markersInserted).toBe(dryRun.markersInserted);
      expect(fs.readFileSync(target, "utf8")).toContain("@dsp");
    } finally {
      services.db.close();
    }
  });

  it("keeps DSP and protocol export golden surfaces stable", async () => {
    const services = openDSP(tempDir, adapters());
    try {
      await runIndex(services, { rootDir: tempDir, full: true });
      runExport(services, "dsp");
      runExport(services, "protocol");

      const exportDir = path.join(tempDir, ".dsp", "export");
      const protocolDir = path.join(tempDir, ".dsp", "protocol");
      const entities = fs.readFileSync(path.join(exportDir, "entities.txt"), "utf8").trim().split("\n");
      const relations = fs.readFileSync(path.join(exportDir, "relations.txt"), "utf8").trim().split("\n");
      const protocolToc = fs.readFileSync(path.join(protocolDir, "TOC"), "utf8").trim().split("\n");
      const uidMap = JSON.parse(fs.readFileSync(path.join(protocolDir, "uid-map.json"), "utf8")) as Record<string, string>;

      expect({
        entityCount: entities.length,
        relationCount: relations.length,
        protocolCount: protocolToc.length,
        authEntities: entities.filter((line) => line.includes("auth")).slice(0, 8),
        protocolAuthMappings: Object.entries(uidMap)
          .filter(([uid]) => uid.includes("auth"))
          .sort()
          .slice(0, 8)
      }).toMatchInlineSnapshot(`
        {
          "authEntities": [
            "class:src/auth/AuthService.ts#AuthService [class] | name=AuthService | path=src/auth/AuthService.ts | language=typescript | confidence=0.98",
            "directory:src/auth [directory] | name=auth | path=src/auth | language= | confidence=1.00",
            "file:app/auth.py [file] | name=auth.py | path=app/auth.py | language=python | confidence=1.00",
            "file:src/auth/AuthService.ts [file] | name=AuthService.ts | path=src/auth/AuthService.ts | language=typescript | confidence=1.00",
            "file:src/auth/crypto.ts [file] | name=crypto.ts | path=src/auth/crypto.ts | language=typescript | confidence=1.00",
            "function:app/auth.py#validate_token [function] | name=validate_token | path=app/auth.py | language=python | confidence=0.95",
            "function:src/auth/crypto.ts#hashToken [function] | name=hashToken | path=src/auth/crypto.ts | language=typescript | confidence=0.98",
            "method:src/auth/AuthService.ts#AuthService.validateToken [method] | name=validateToken | path=src/auth/AuthService.ts | language=typescript | confidence=0.95",
          ],
          "entityCount": 20,
          "protocolAuthMappings": [
            [
              "class:src/auth/AuthService.ts#AuthService",
              "obj-71283643",
            ],
            [
              "directory:src/auth",
              "obj-44a32554",
            ],
            [
              "file:app/auth.py",
              "obj-18550af7",
            ],
            [
              "file:src/auth/AuthService.ts",
              "obj-78eb152a",
            ],
            [
              "file:src/auth/crypto.ts",
              "obj-1fc1cb89",
            ],
            [
              "function:app/auth.py#validate_token",
              "func-6678e6e2",
            ],
            [
              "function:src/auth/crypto.ts#hashToken",
              "func-cc86f169",
            ],
            [
              "method:src/auth/AuthService.ts#AuthService.validateToken",
              "func-a3537bd9",
            ],
          ],
          "protocolCount": 20,
          "relationCount": 23,
        }
      `);
    } finally {
      services.db.close();
    }
  });
});
