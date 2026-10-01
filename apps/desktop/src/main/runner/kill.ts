// Stops an agent CLI and whatever it started: it runs in its own process group (spawned detached).
import { spawn, type ChildProcess } from "node:child_process";

/** How killTree reaches the OS; tests pass their own so the Windows path runs (and spawns nothing) on any machine. */
export interface KillOs {
  platform?: NodeJS.Platform;
  spawn?: (command: string, args: string[], options: { windowsHide: boolean }) => unknown;
}

/** SIGTERM to the group, SIGKILL five seconds later if something is still there. */
export function killTree(child: ChildProcess, os: KillOs = {}): void {
  if (!child.pid) return;
  if ((os.platform ?? process.platform) === "win32") {
    (os.spawn ?? spawn)("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  const pid = child.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }, 5000).unref();
}
