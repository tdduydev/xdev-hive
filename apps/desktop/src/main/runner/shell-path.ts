// Apps started from Finder/Dock get a minimal PATH (/usr/bin:/bin…), so `claude`, `codex`, `gemini`
// installed through npm/nvm/Homebrew are not found. Ask the user's login shell for its PATH once.
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { shimBinDir } from "#desktop/main/installer.ts";

let cached: string | null = null;

/** refresh: ask the shell again (after installing Node or a CLI that changed PATH). */
export function agentPath(refresh = false): string {
  if (cached !== null && !refresh) return cached;
  // The shim's folder too, because the runner's own MCP config calls hive-mcp by name; on Windows that folder
  // is ~/.xdev-hive/bin, which nothing else puts on PATH.
  const parts = [shimBinDir(), path.join(os.homedir(), ".local", "bin"), loginShellPath(), process.env.PATH]
    .filter((p): p is string => !!p)
    .flatMap((p) => p.split(path.delimiter));
  cached = [...new Set(parts.filter(Boolean))].join(path.delimiter);
  return cached;
}

function loginShellPath(): string | null {
  if (process.platform === "win32") return null;
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const out = execFileSync(shell, ["-ilc", 'printf "__HIVE_PATH__%s__HIVE_PATH__" "$PATH"'], {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return /__HIVE_PATH__(.*?)__HIVE_PATH__/s.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}
