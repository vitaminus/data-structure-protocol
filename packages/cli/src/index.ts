#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { Command } from "commander";
import {
  findEntityByUidOrPath,
  getNeighbors,
  initDSP,
  openDSP,
  runBootstrap,
  runChanged,
  runContextPack,
  runEmbeddingsUpdate,
  runExport,
  runImport,
  runImpact,
  runIndex,
  runSearch,
  runValidate,
  type LanguageAdapter
} from "@dsp/core";
import { createTypeScriptLanguageAdapter } from "@dsp/language-typescript";
import { createPythonLanguageAdapter } from "@dsp/language-python";
import { createRustLanguageAdapter } from "@dsp/language-rust";
import { createRubyLanguageAdapter } from "@dsp/language-ruby";
import { startMcpServer } from "@dsp/mcp-server";

function adapters(): LanguageAdapter[] {
  return [
    createTypeScriptLanguageAdapter(),
    createPythonLanguageAdapter(),
    createRustLanguageAdapter(),
    createRubyLanguageAdapter()
  ];
}

function printOutput(output: unknown, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }
  if (typeof output === "string") {
    process.stdout.write(`${output}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

const program = new Command();
program.name("dsp").description("DSP v2 context compiler").version("0.1.0");

program
  .command("init")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((rootDir: string, options: { json: boolean }) => {
    const result = initDSP(path.resolve(rootDir));
    printOutput(result, options.json);
  });

program
  .command("index")
  .argument("[rootDir]", "root directory", ".")
  .option("--lazy", "lazy indexing mode", false)
  .option("--full", "full reindex", false)
  .option("--changed-only", "index only changed files", false)
  .option("--from-git-diff", "index files from git diff", false)
  .option("--no-embeddings", "disable embeddings for this run")
  .option("--json", "machine-readable output", false)
  .action(async (rootDir: string, options) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const summary = await runIndex(
        services,
        {
          rootDir: services.rootDir,
          lazy: options.lazy,
          full: options.full,
          changedOnly: options.changedOnly,
          fromGitDiff: options.fromGitDiff,
          noEmbeddings: options.embeddings === false
        }
      );
      printOutput(summary, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("bootstrap")
  .argument("[rootDir]", "root directory", ".")
  .option("--large-repo", "large repository mode", false)
  .option("--lazy", "lazy bootstrap mode", false)
  .option("--no-embeddings", "disable embeddings for this run")
  .option("--dry-run", "simulate without writes", false)
  .option("--reset", "reset existing index before bootstrap", false)
  .option("--merge-existing", "preserve existing data and merge", false)
  .option("--backup-existing", "backup existing .dsp before bootstrap", false)
  .option("--replace-existing", "replace existing .dsp index", false)
  .option("--json", "machine-readable output", false)
  .action(async (rootDir: string, options) => {
    const resolvedRoot = path.resolve(rootDir);
    const dspDir = path.join(resolvedRoot, ".dsp");
    const dbPath = path.join(dspDir, "dsp.sqlite");
    if (options.backupExisting && fs.existsSync(dspDir)) {
      const backupPath = `${dspDir}.backup.${Date.now()}`;
      fs.cpSync(dspDir, backupPath, { recursive: true });
    }
    if ((options.replaceExisting || options.reset) && fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }

    const services = openDSP(resolvedRoot, adapters());
    try {
      const summary = await runBootstrap(services, {
        largeRepo: options.largeRepo,
        lazy: options.lazy,
        noEmbeddings: options.embeddings === false,
        dryRun: options.dryRun
      });
      const validation = runValidate(services);
      printOutput({ summary, validation }, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("update")
  .argument("[rootDir]", "root directory", ".")
  .option("--from-git-diff", "update from git diff", false)
  .option("--changed-only", "only changed files", false)
  .option("--json", "machine-readable output", false)
  .action(async (rootDir: string, options) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const summary = await runIndex(services, {
        rootDir: services.rootDir,
        fromGitDiff: options.fromGitDiff,
        changedOnly: options.changedOnly
      });
      printOutput(summary, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("changed")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const result = runChanged(services);
      printOutput(result, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("explain")
  .argument("<uidOrPath>", "entity uid or path")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((uidOrPath: string, rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const entity = findEntityByUidOrPath(services.db, uidOrPath);
      if (!entity) {
        printOutput({ found: false, uidOrPath }, options.json);
        return;
      }
      const neighbors = getNeighbors(services.db, entity.uid, 1);
      printOutput({ found: true, entity, neighbors }, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("graph")
  .argument("<uidOrPath>", "entity uid or path")
  .argument("[rootDir]", "root directory", ".")
  .option("--depth <number>", "graph depth", "2")
  .option("--json", "machine-readable output", false)
  .action(
    (uidOrPath: string, rootDir: string, options: { depth: string; json: boolean }) => {
      const services = openDSP(path.resolve(rootDir), adapters());
      try {
        const entity = findEntityByUidOrPath(services.db, uidOrPath);
        if (!entity) {
          printOutput({ found: false, uidOrPath }, options.json);
          return;
        }
        const graph = getNeighbors(services.db, entity.uid, Number(options.depth));
        printOutput({ root: entity.uid, ...graph }, options.json);
      } finally {
        services.db.close();
      }
    }
  );

program
  .command("search")
  .argument("<query>", "search query")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .option("--top-k <number>", "number of results", "20")
  .action(async (query: string, rootDir: string, options: { json: boolean; topK: string }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const result = await runSearch(services, query, { topK: Number(options.topK) });
      printOutput(result, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("impact")
  .argument("<uidOrPath>", "target uid or path")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((uidOrPath: string, rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const result = runImpact(services, uidOrPath);
      printOutput(result, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("validate")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const result = runValidate(services);
      printOutput(result, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("export")
  .argument("[rootDir]", "root directory", ".")
  .option("--format <format>", "json, dsp, or protocol", "json")
  .option("--output <path>", "output path")
  .option("--json", "machine-readable output", false)
  .action((rootDir: string, options: { format: "json" | "dsp" | "protocol"; output?: string; json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const result = runExport(services, options.format, options.output);
      printOutput(result, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("import")
  .argument("<jsonPath>", "graph json path")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((jsonPath: string, rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const result = runImport(services, path.resolve(jsonPath));
      printOutput(result, options.json);
    } finally {
      services.db.close();
    }
  });

program
  .command("mcp")
  .argument("[rootDir]", "root directory", ".")
  .action(async (rootDir: string) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    await startMcpServer(services);
  });

program
  .command("precommit-check")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action(async (rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const changed = runChanged(services);
      const impacts = changed.map((target) => runImpact(services, target));
      const validation = runValidate(services);
      printOutput({ changed, impacts, validation }, options.json);
    } finally {
      services.db.close();
    }
  });

const ci = program.command("ci").description("CI helpers");
const cache = program.command("cache").description("Cache utilities");
const embeddings = program.command("embeddings").description("Embeddings utilities");

cache
  .command("stats")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      printOutput(services.db.cacheStats(), options.json);
    } finally {
      services.db.close();
    }
  });

embeddings
  .command("update")
  .argument("[rootDir]", "root directory", ".")
  .option("--changed-only", "embed only changed entities", false)
  .option("--json", "machine-readable output", false)
  .action(async (rootDir: string, options: { changedOnly: boolean; json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const result = await runEmbeddingsUpdate(services, {
        changedOnly: options.changedOnly
      });
      printOutput(result, options.json);
    } finally {
      services.db.close();
    }
  });

embeddings
  .command("stats")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      printOutput(services.db.cacheStats(), options.json);
    } finally {
      services.db.close();
    }
  });

cache
  .command("clear")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", false)
  .action((rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      services.db.clearCache();
      printOutput({ cleared: true }, options.json);
    } finally {
      services.db.close();
    }
  });

ci
  .command("check")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", true)
  .action((rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const validation = runValidate(services);
      printOutput(validation, options.json);
      process.exitCode = validation.ok ? 0 : 1;
    } finally {
      services.db.close();
    }
  });

ci
  .command("impact")
  .argument("[rootDir]", "root directory", ".")
  .option("--json", "machine-readable output", true)
  .action((rootDir: string, options: { json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const changed = runChanged(services);
      const impacts = changed.map((target) => runImpact(services, target));
      printOutput({ changed, impacts }, options.json);
    } finally {
      services.db.close();
    }
  });

ci
  .command("context-summary")
  .argument("[rootDir]", "root directory", ".")
  .option("--task <task>", "task description", "Review changes")
  .option("--json", "machine-readable output", true)
  .action(async (rootDir: string, options: { task: string; json: boolean }) => {
    const services = openDSP(path.resolve(rootDir), adapters());
    try {
      const pack = await runContextPack(services, {
        task: options.task,
        strategy: "minimal",
        maxTokens: 4000,
        includeCode: "snippets-only",
        includeTests: true
      });
      printOutput(pack, options.json);
    } finally {
      services.db.close();
    }
  });

program.parseAsync(process.argv);
