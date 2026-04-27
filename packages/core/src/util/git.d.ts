export type GitChangedFile = {
    status: string;
    path: string;
    oldPath?: string;
};
export declare function changedFileEntriesFromGit(rootDir: string, baseRef?: string): GitChangedFile[];
export declare function changedFilesFromGit(rootDir: string, baseRef?: string): string[];
export declare function changedFilesStaged(rootDir: string): string[];
//# sourceMappingURL=git.d.ts.map