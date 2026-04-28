import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG, type DSPConfig } from "./types.ts";

export function configPath(rootDir: string): string {
  return path.join(rootDir, ".dsp", "config.json");
}

export function loadConfig(rootDir: string): DSPConfig {
  const target = configPath(rootDir);
  if (!fs.existsSync(target)) {
    return DEFAULT_CONFIG;
  }
  const raw = fs.readFileSync(target, "utf8");
  const parsed = JSON.parse(raw) as Partial<DSPConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    performance: { ...DEFAULT_CONFIG.performance, ...(parsed.performance ?? {}) },
    embeddings: { ...DEFAULT_CONFIG.embeddings, ...(parsed.embeddings ?? {}) }
  };
}

export function writeDefaultConfig(rootDir: string): DSPConfig {
  const target = configPath(rootDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
  return DEFAULT_CONFIG;
}
