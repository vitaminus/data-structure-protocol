import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { PythonLanguageAdapter, resetPythonAstWorker } from "./index.ts";

describe("python adapter", () => {
  const cleanupDirs: string[] = [];
  const hasPython3 = spawnSync("python3", ["-c", "import ast"], { stdio: "ignore" }).status === 0;

  afterEach(async () => {
    delete process.env.DSP_PYTHON_PARSER_COMMAND;
    delete process.env.DSP_PYTHON_PARSER_TIMEOUT_MS;
    delete process.env.DSP_PYTHON_PARSER_MAX_JOBS;
    await resetPythonAstWorker();
    for (const dir of cleanupDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function installFakePythonWorker(): void {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-py-worker-"));
    cleanupDirs.push(tempDir);
    const scriptPath = path.join(tempDir, "fake-python-worker.mjs");
    fs.writeFileSync(
      scriptPath,
      `
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let crashed = false;

for await (const line of rl) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  const content = String(request.content ?? "");
  if (content.includes("__timeout__")) {
    continue;
  }
  if (content.includes("__crash__") && !crashed) {
    crashed = true;
    process.exit(91);
  }
  if (content.includes("__syntax__")) {
    process.stdout.write(JSON.stringify({
      id: request.id,
      ok: false,
      error: { code: "syntax_error", message: "bad syntax", syntaxError: true }
    }) + "\\n");
    continue;
  }
  const imports = [];
  if (content.includes("from .crypto")) {
    imports.push(".crypto");
  }
  if (content.includes("import os")) {
    imports.push("os");
  }
  const symbols = [];
  if (content.includes("class AuthService")) {
    symbols.push({ kind: "class", name: "AuthService", startLine: 1, endLine: 2 });
  }
  if (content.includes("def create_user")) {
    symbols.push({ kind: "method", name: "create_user", className: "AuthService", startLine: 2, endLine: 2 });
  }
  if (content.includes("def login")) {
    symbols.push({ kind: "function", name: "login", startLine: 3, endLine: 3 });
  }
  process.stdout.write(JSON.stringify({
    id: request.id,
    ok: true,
    result: { imports, symbols }
  }) + "\\n");
}
`,
      "utf8"
    );
    process.env.DSP_PYTHON_PARSER_COMMAND = JSON.stringify([process.execPath, scriptPath]);
    process.env.DSP_PYTHON_PARSER_TIMEOUT_MS = "40";
    process.env.DSP_PYTHON_PARSER_MAX_JOBS = "2";
  }

  (hasPython3 ? it : it.skip)("extracts imports and symbols", async () => {
    const adapter = new PythonLanguageAdapter();
    const parsed = await adapter.parseFile(
      "app/auth.py",
      `
import os
from crypto import hash_password

class AuthService:
    def create_user(self, email, password):
        return hash_password(password)

def login():
    return True
`
    );
    const entities = adapter.extractEntities(parsed);
    const relations = adapter.extractRelations(parsed, entities);
    expect(entities.some((entity) => entity.kind === "class")).toBe(true);
    expect(entities.some((entity) => entity.kind === "method")).toBe(true);
    expect(entities.some((entity) => entity.kind === "function")).toBe(true);
    expect(relations.some((relation) => relation.kind === "imports")).toBe(true);
    expect(parsed.entities[0]?.provenance[0]?.source).toBe("ast");
  });

  (hasPython3 ? it : it.skip)("preserves relative import levels from Python AST", async () => {
    const adapter = new PythonLanguageAdapter();
    const parsed = await adapter.parseFile(
      "app/auth.py",
      `
from .crypto import hash_password
`
    );
    const relations = adapter.extractRelations(parsed, parsed.entities);
    expect(
      relations.some((relation) => relation.kind === "imports" && relation.to === "file:app/crypto.py")
    ).toBe(true);
  });

  it("falls back safely on syntax errors", async () => {
    installFakePythonWorker();
    const adapter = new PythonLanguageAdapter();
    const parsed = await adapter.parseFile(
      "app/auth.py",
      `
__syntax__
def login():
    return True
`
    );
    expect(parsed.entities.some((entity) => entity.kind === "function" && entity.name === "login")).toBe(true);
    expect(parsed.entities[0]?.provenance[0]?.source).toBe("regex");
  });

  it("falls back and records timeout telemetry when the parser worker stalls", async () => {
    installFakePythonWorker();
    const adapter = new PythonLanguageAdapter();
    const parsed = (await adapter.parseFile(
      "app/auth.py",
      `
__timeout__
def login():
    return True
`
    )) as Awaited<ReturnType<PythonLanguageAdapter["parseFile"]>> & { telemetry?: { workerTimeouts?: number } };
    expect(parsed.entities.some((entity) => entity.kind === "function" && entity.name === "login")).toBe(true);
    expect(parsed.entities[0]?.provenance[0]?.source).toBe("regex");
    expect(parsed.telemetry?.workerTimeouts).toBe(1);
  });

  it("restarts the parser worker after a crash and succeeds on the next file", async () => {
    installFakePythonWorker();
    const adapter = new PythonLanguageAdapter();
    const crashed = (await adapter.parseFile(
      "app/auth.py",
      `
__crash__
def login():
    return True
`
    )) as Awaited<ReturnType<PythonLanguageAdapter["parseFile"]>> & { telemetry?: { workerRestarts?: number } };
    expect(crashed.entities[0]?.provenance[0]?.source).toBe("regex");

    const recovered = await adapter.parseFile(
      "app/auth.py",
      `
import os
def login():
    return True
`
    );
    expect(recovered.entities.some((entity) => entity.kind === "function" && entity.name === "login")).toBe(true);
  });

  it("falls back when the external runtime is unavailable", async () => {
    process.env.DSP_PYTHON_PARSER_COMMAND = JSON.stringify(["/definitely-missing-python-runtime"]);
    const adapter = new PythonLanguageAdapter();
    const parsed = await adapter.parseFile(
      "app/auth.py",
      `
def login():
    return True
`
    );
    expect(parsed.entities.some((entity) => entity.kind === "function" && entity.name === "login")).toBe(true);
    expect(parsed.entities[0]?.provenance[0]?.source).toBe("regex");
  });
});
