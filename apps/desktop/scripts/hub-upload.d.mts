// Types for hub-upload.mjs: the desktop tsconfig has no allowJs, and the test imports the script.
export type BuildInfo = { platform: "mac" | "win" | "linux"; arch: "arm64" | "x64"; kind: "dmg" | "zip" | "exe" | "AppImage" };

export function describeBuild(name: string): BuildInfo | null;

export const ATTEMPTS: number;

export function retryable(err: unknown): boolean;

export function uploadToHub(opts: {
  hub: string;
  token: string;
  version: string;
  assets: string[];
  notes: string;
  log?: (line: string) => void;
  wait?: (attempt: number) => Promise<void>;
}): Promise<void>;

export function readReleaseEnv(file?: string, env?: Record<string, string | undefined>): Record<string, string>;

export function importOverSsh(opts: {
  ssh: string;
  container?: string;
  version: string;
  files: string[];
  by: string;
  log?: (line: string) => void;
  run?: (from: string[] | null, to: string[], env: Record<string, string | undefined>, log?: (line: string) => void) => Promise<void>;
}): Promise<void>;
