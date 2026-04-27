import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG } from "./types.js";
export function configPath(rootDir) {
    return path.join(rootDir, ".dsp", "config.json");
}
export function loadConfig(rootDir) {
    const target = configPath(rootDir);
    if (!fs.existsSync(target)) {
        return DEFAULT_CONFIG;
    }
    const raw = fs.readFileSync(target, "utf8");
    const parsed = JSON.parse(raw);
    return {
        ...DEFAULT_CONFIG,
        ...parsed,
        performance: { ...DEFAULT_CONFIG.performance, ...(parsed.performance ?? {}) },
        embeddings: { ...DEFAULT_CONFIG.embeddings, ...(parsed.embeddings ?? {}) }
    };
}
export function writeDefaultConfig(rootDir) {
    const target = configPath(rootDir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
    return DEFAULT_CONFIG;
}
//# sourceMappingURL=config.js.map