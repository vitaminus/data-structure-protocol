import path from "node:path";
import process from "node:process";

type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
};

const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<{ default?: unknown }>;

function parseMajor(version: string): number | undefined {
  const match = version.match(/^v?(\d+)/);
  return match ? Number(match[1]) : undefined;
}

function format(check: CheckResult): string {
  return `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`;
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

  try {
    const betterSqlite3 = await dynamicImport("better-sqlite3");
    checks.push({
      name: "better-sqlite3-load",
      ok: typeof betterSqlite3.default === "function",
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
  process.stdout.write(`DSP runtime doctor for ${cwd}\n`);
  for (const check of checks) {
    process.stdout.write(`${format(check)}\n`);
  }
  if (checks.some((check) => !check.ok)) {
    process.exitCode = 1;
  }
}

void main();
