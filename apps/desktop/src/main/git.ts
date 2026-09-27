import { execFile, execFileSync } from "node:child_process";

export function git(repo: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Async variant for network operations (push), so the main process never blocks on the network. */
export function gitAsync(repo: string, args: string[], env: Record<string, string> = {}, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd: repo, encoding: "utf8", env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr }));
        else resolve(`${stdout}${stderr}`.trim());
      },
    );
  });
}

export function isGitRepo(repo: string): boolean {
  try {
    return git(repo, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}

export function gitErrorText(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr || e.message || String(err)).trim().split("\n").slice(-3).join(" ");
}
