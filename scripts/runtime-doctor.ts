import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
};

function parseMajor(version: string): number | undefined {
  const match = version.match(/^v?(\d+)/);
  return match ? Number(match[1]) : undefined;
}

function format(check: CheckResult): string {
  return `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`;
}

function runCommandCheck(command: string, args: string[], name: string): CheckResult {
  try {
    const output = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000
    }).trim();
    return {
      name,
      ok: true,
      detail: output || `${command} ${args.join(" ")} succeeded.`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name,
      ok: false,
      detail: message
    };
  }
}

async function runChecks(): Promise<CheckResult[]> {
  const nodeVersion = process.version;
  const major = parseMajor(nodeVersion);
  const supportedNode = major !== undefined && major >= 20 && major < 23;
  const checks: CheckResult[] = [
    {
      name: "node-version",
      ok: supportedNode,
      detail: supportedNode
        ? `${nodeVersion} is within the supported DSP range (20.x - 22.x).`
        : `${nodeVersion} is outside the supported DSP range (20.x - 22.x).`
    }
  ];

  checks.push(runCommandCheck("python3", ["--version"], "python3-runtime"));
  checks.push(runCommandCheck("ruby", ["--version"], "ruby-runtime"));

  let betterSqlite3Loaded = false;
  let BetterSqlite3: undefined | (new (path: string, options?: Record<string, unknown>) => {
    prepare(sql: string): { all(): Array<{ compile_options: string }> };
    close(): void;
  });
  try {
    const coreRequire = createRequire(path.join(process.cwd(), "packages/core/package.json"));
    BetterSqlite3 = coreRequire("better-sqlite3") as typeof BetterSqlite3;
    betterSqlite3Loaded = typeof BetterSqlite3 === "function";
    checks.push({
      name: "better-sqlite3-load",
      ok: betterSqlite3Loaded,
      detail: "Native SQLite binding loaded successfully."
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({
      name: "better-sqlite3-load",
      ok: false,
      detail: message
    });
  }

  if (betterSqlite3Loaded) {
    try {
      const db = new BetterSqlite3!(":memory:");
      const compileOptions = db.prepare("PRAGMA compile_options").all().map((row) => row.compile_options);
      db.close();
      const hasFts5 = compileOptions.some((option) => option.includes("ENABLE_FTS5"));
      checks.push({
        name: "sqlite-capabilities",
        ok: hasFts5,
        detail: hasFts5
          ? "SQLite compile options include ENABLE_FTS5."
          : "SQLite compile options are missing ENABLE_FTS5."
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({
        name: "sqlite-capabilities",
        ok: false,
        detail: message
      });
    }
  } else {
    checks.push({
      name: "sqlite-capabilities",
      ok: false,
      detail: "Skipped because better-sqlite3 failed to load."
    });
  }

  try {
    const resolved = await import.meta.resolve?.("tsx");
    checks.push({
      name: "tsx-resolution",
      ok: Boolean(resolved),
      detail: resolved ? `Resolved to ${resolved}.` : "Unable to resolve tsx."
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({
      name: "tsx-resolution",
      ok: false,
      detail: message
    });
  }

  return checks;
}

async function main(): Promise<void> {
  const checks = await runChecks();
  const cwd = path.resolve(process.cwd());
  const asJson = process.argv.includes("--json");
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ cwd, checks }, null, 2)}\n`);
    if (checks.some((check) => !check.ok)) {
      process.exitCode = 1;
    }
    return;
  }
  process.stdout.write(`DSP runtime doctor for ${cwd}\n`);
  for (const check of checks) {
    process.stdout.write(`${format(check)}\n`);
  }
  if (checks.some((check) => !check.ok)) {
    process.exitCode = 1;
  }
}

void main();
