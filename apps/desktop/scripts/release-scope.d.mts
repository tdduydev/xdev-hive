export function releaseScope(paths: Iterable<string>, forceApp?: boolean): { app: boolean; appFiles: string[]; files: string[] };
export function changedSinceAppRelease(repoRoot: string, head?: string): { baseline: string | null; app: boolean; appFiles: string[]; files: string[] };
export function changedSinceAppReleaseAsync(repoRoot: string, head?: string): Promise<{ baseline: string | null; app: boolean; appFiles: string[]; files: string[] }>;
