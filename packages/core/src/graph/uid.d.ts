import type { EntityKind } from "./types.js";
export declare function normalizePath(inputPath: string): string;
export declare function buildUid(kind: EntityKind, filePath: string, symbol?: string): string;
export declare function contentHash(content: string): string;
export declare function stableNowIso(date?: Date): string;
//# sourceMappingURL=uid.d.ts.map