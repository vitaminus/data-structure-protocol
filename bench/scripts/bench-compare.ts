import fs from "node:fs";

type BenchResult = {
  case: string;
  parallelism: number;
  [metric: string]: string | number;
};

type BenchOutput = {
  results: BenchResult[];
};

type Thresholds = {
  max?: Record<string, Record<string, number>>;
  min?: Record<string, Record<string, number>>;
};

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

const [actualPath, thresholdPath] = process.argv.slice(2);
if (!actualPath || !thresholdPath) {
  throw new Error("Usage: bench-compare <actual.json> <thresholds.json>");
}

const actual = readJson<BenchOutput>(actualPath);
const thresholds = readJson<Thresholds>(thresholdPath);
const failures: string[] = [];

for (const result of actual.results) {
  const caseMax = thresholds.max?.[result.case] ?? {};
  const caseMin = thresholds.min?.[result.case] ?? {};
  for (const [metric, limit] of Object.entries(caseMax)) {
    const value = Number(result[metric]);
    if (Number.isFinite(value) && value > limit) {
      failures.push(`${result.case}/p${result.parallelism} ${metric}=${value.toFixed(2)} > ${limit}`);
    }
  }
  for (const [metric, limit] of Object.entries(caseMin)) {
    const value = Number(result[metric]);
    if (Number.isFinite(value) && value < limit) {
      failures.push(`${result.case}/p${result.parallelism} ${metric}=${value.toFixed(2)} < ${limit}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`Benchmark threshold failures:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Benchmark thresholds passed for ${actual.results.length} result(s).\n`);
}
