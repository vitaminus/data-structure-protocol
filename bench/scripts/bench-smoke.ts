import { parseParallelismValues, runCase, selectBenchCases } from "./bench-lib.ts";

const parallelismValues = parseParallelismValues(process.env.DSP_BENCH_PARALLELISM ?? "1,4");
const benchCases = selectBenchCases(process.env.DSP_BENCH_CASES ?? "tiny,medium,large");

const results = [];
for (const benchCase of benchCases) {
  for (const parallelism of parallelismValues) {
    results.push(await runCase(benchCase, parallelism));
  }
}

process.stdout.write(`${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`);
