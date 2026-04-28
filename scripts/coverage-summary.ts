import fs from "node:fs";
import path from "node:path";

type V8CoverageRange = {
  count: number;
};

type V8FunctionCoverage = {
  ranges: V8CoverageRange[];
};

type V8ScriptCoverage = {
  url: string;
  functions: V8FunctionCoverage[];
};

type V8CoverageFile = {
  result?: V8ScriptCoverage[];
};

type CoverageSummary = {
  files: number;
  functions: number;
  coveredFunctions: number;
  functionCoverage: number;
  sourceFiles: number;
  coveredSourceFiles: number;
  sourceFileCoverage: number;
};

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

const coverageDir = process.argv[2] ?? ".coverage/v8";
const threshold = Number(process.env.DSP_COVERAGE_MIN_FUNCTIONS ?? "0");
const rootDir = process.cwd();
const files = walk(coverageDir).filter((filePath) => filePath.endsWith(".json"));
if (files.length === 0) {
  throw new Error(`No V8 coverage JSON files found in ${coverageDir}`);
}
const scripts = files.flatMap((filePath) => {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as V8CoverageFile;
  return parsed.result ?? [];
});
const localScripts = scripts.filter(
  (script) =>
    script.url.includes("/packages/") ||
    script.url.includes("/tests/") ||
    script.url.includes("packages/") ||
    script.url.includes("tests/")
);
let functions = 0;
let coveredFunctions = 0;

for (const script of localScripts) {
  for (const fn of script.functions) {
    functions += 1;
    if (fn.ranges.some((range) => range.count > 0)) {
      coveredFunctions += 1;
    }
  }
}

const sourceFiles = walk(path.join(rootDir, "packages"))
  .filter((filePath) => filePath.endsWith(".ts"))
  .filter((filePath) => filePath.includes(`${path.sep}src${path.sep}`))
  .filter((filePath) => !filePath.endsWith(".test.ts"))
  .filter((filePath) => !filePath.endsWith(".d.ts"));
const testFiles = walk(rootDir).filter((filePath) => filePath.endsWith(".test.ts"));
const testText = testFiles
  .map((filePath) => fs.readFileSync(filePath, "utf8"))
  .join("\n");
const coveredSourceFiles = sourceFiles.filter((filePath) => {
  const basename = path.basename(filePath).replace(/\.ts$/, "");
  const testNeighbor = filePath.replace(/\.ts$/, ".test.ts");
  return fs.existsSync(testNeighbor) || testText.includes(`${basename}.ts`) || testText.includes(`/${basename}`);
});

const summary: CoverageSummary = {
  files: localScripts.length,
  functions,
  coveredFunctions,
  functionCoverage: functions === 0 ? 0 : coveredFunctions / functions,
  sourceFiles: sourceFiles.length,
  coveredSourceFiles: coveredSourceFiles.length,
  sourceFileCoverage: sourceFiles.length === 0 ? 0 : coveredSourceFiles.length / sourceFiles.length
};

fs.mkdirSync(".coverage", { recursive: true });
fs.writeFileSync(".coverage/summary.json", `${JSON.stringify(summary, null, 2)}\n`, "utf8");
fs.writeFileSync(
  ".coverage/index.html",
  [
    "<!doctype html>",
    "<html>",
    "<head><meta charset=\"utf-8\"><title>DSP Coverage Summary</title></head>",
    "<body>",
    "<h1>DSP Coverage Summary</h1>",
    `<p>Files: ${summary.files}</p>`,
    `<p>Functions: ${summary.coveredFunctions}/${summary.functions}</p>`,
    `<p>Function coverage: ${(summary.functionCoverage * 100).toFixed(2)}%</p>`,
    `<p>Source file coverage fallback: ${summary.coveredSourceFiles}/${summary.sourceFiles} (${(summary.sourceFileCoverage * 100).toFixed(2)}%)</p>`,
    "</body>",
    "</html>"
  ].join("\n"),
  "utf8"
);
fs.writeFileSync(
  ".coverage/lcov.info",
  [
    "TN:",
    "SF:v8-function-summary",
    `FNF:${summary.functions}`,
    `FNH:${summary.coveredFunctions}`,
    "end_of_record"
  ].join("\n"),
  "utf8"
);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

const effectiveCoverage = summary.functions > 0 ? summary.functionCoverage : summary.sourceFileCoverage;
if (effectiveCoverage < threshold) {
  process.stderr.write(`Coverage ${effectiveCoverage.toFixed(4)} is below ${threshold}.\n`);
  process.exitCode = 1;
}
