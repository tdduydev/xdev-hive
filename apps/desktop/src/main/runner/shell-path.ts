// Apps started from Finder/Dock get a minimal PATH (/usr/bin:/bin…), so `claude`, `codex`, `gemini`
// installed through npm/nvm/Homebrew are not found. Ask the user's login shell for its PATH once.
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { shimBinDir } from "#desktop/main/installer.ts";
import { toolBinDirs } from "#desktop/main/linux-tools.ts";

let cached: string | null = null;

/** refresh: ask the shell again (after installing Node or a CLI that changed PATH). */
export function agentPath(refresh = false): string {
  if (cached === null) {
    remember(null);
    void refreshAgentPath();
  } else if (refresh) void refreshAgentPath();
  return cached!;
}

let pending: Promise<string> | null = null;

/**
 * The same, without blocking the main process: an interactive login shell takes 0.4s to several seconds (nvm,
 * oh-my-zsh), and the sync call froze the window at start and each time Cài đặt checked the machine.
 */
export function refreshAgentPath(): Promise<string> {
  pending ??= loginShellPathAsync().then(remember).finally(() => { pending = null; });
  return pending;
}

function remember(login: string | null): string {
  // The shim's folder too, because the runner's own MCP config calls hive-mcp by name; on Windows that folder
  // is ~/.xdev-hive/bin, which nothing else puts on PATH.
  // Node and its CLIs moved out of the Linux app's folder (linux-tools.ts) come before the shell's copy of them.
  const tools = process.platform === "linux" ? toolBinDirs(os.homedir()) : [];
  const parts = [shimBinDir(), path.join(os.homedir(), ".local", "bin"), ...tools, login, process.env.PATH]
    .filter((p): p is string => !!p)
    .flatMap((p) => p.split(path.delimiter));
  cached = [...new Set(parts.filter(Boolean))].join(path.delimiter);
  return cached;
}

const SHELL_ARGS = ["-ilc", 'printf "__HIVE_PATH__%s__HIVE_PATH__" "$PATH"'];
const SHELL_OPTS = { encoding: "utf8", timeout: 8000 } as const;
const parsePath = (out: string) => /__HIVE_PATH__(.*?)__HIVE_PATH__/s.exec(out)?.[1] ?? null;
const loginShell = () => (process.platform === "win32" ? null : process.env.SHELL || "/bin/zsh");

function loginShellPathAsync(): Promise<string | null> {
  const shell = loginShell();
  if (!shell) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = execFile(shell, SHELL_ARGS, SHELL_OPTS, (err, out) => resolve(err ? null : parsePath(out)));
    child.stdin?.end();
  });
}
