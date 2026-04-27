export type DiscoverOptions = {
    excludes?: string[];
    maxFileSizeKb?: number;
};
export declare function ensureDir(target: string): void;
export declare function findRepoRoot(startDir: string): string;
export declare function discoverFiles(rootDir: string, options?: DiscoverOptions): string[];
export declare function readTextFile(filePath: string): string;
export declare function writeTextFile(filePath: string, content: string): void;
export declare function fileExists(filePath: string): boolean;
//# sourceMappingURL=fs.d.ts.map