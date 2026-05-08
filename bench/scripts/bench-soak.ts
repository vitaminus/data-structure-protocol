import { runCase, selectBenchCases, type BenchResult } from "./bench-lib.ts";

type SoakSummary = {
  generatedAt: string;
  repeats: number;
  results: BenchResult[];
  aggregates: Array<{
    case: string;
    parallelism: number;
    runs: number;
    warmIndexAvgMs: number;
    warmIndexMaxMs: number;
    changedOnlyAvgMs: number;
    changedOnlyMaxMs: number;
    rssAvgMb: number;
    rssMaxMb: number;
  }>;
};

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

const repeats = Math.max(1, Number(process.env.DSP_BENCH_REPEATS ?? "3"));
const parallelismValues = (process.env.DSP_BENCH_PARALLELISM ?? "1,4,8")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const benchCases = selectBenchCases(process.env.DSP_BENCH_CASES ?? "tiny,medium");

const results: BenchResult[] = [];
for (let repeat = 0; repeat < repeats; repeat += 1) {
  for (const benchCase of benchCases) {
    for (const parallelism of parallelismValues) {
      results.push(await runCase(benchCase, parallelism));
    }
  }
}

const buckets = new Map<string, BenchResult[]>();
for (const result of results) {
  const key = `${result.case}\0${result.parallelism}`;
  const bucket = buckets.get(key);
  if (bucket) {
    bucket.push(result);
  } else {
    buckets.set(key, [result]);
  }
}

const aggregates = [...buckets.entries()]
  .map(([key, bucket]) => {
    const [benchCase, parallelism] = key.split("\0");
    return {
      case: benchCase,
      parallelism: Number(parallelism),
      runs: bucket.length,
      warmIndexAvgMs: average(bucket.map((entry) => entry.warmIndexMs)),
      warmIndexMaxMs: Math.max(...bucket.map((entry) => entry.warmIndexMs)),
      changedOnlyAvgMs: average(bucket.map((entry) => entry.changedOnlyMs)),
      changedOnlyMaxMs: Math.max(...bucket.map((entry) => entry.changedOnlyMs)),
      rssAvgMb: average(bucket.map((entry) => entry.rssMb)),
      rssMaxMb: Math.max(...bucket.map((entry) => entry.rssMb))
    };
  })
  .sort((a, b) => `${a.case}\0${a.parallelism}`.localeCompare(`${b.case}\0${b.parallelism}`));

const summary: SoakSummary = {
  generatedAt: new Date().toISOString(),
  repeats,
  results,
  aggregates
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
