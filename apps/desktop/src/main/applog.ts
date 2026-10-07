// The main process's own log (BUG-update-relaunch, 6/10): the runner Mac mini quit, installed the new build at quit and
// stayed shut, and nothing said why it quit. Each start, each quit with its reason, crashed child processes, sleep and
// wake, and every updater step go to a file the OS's usual place for logs, so the next report has something to read.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redactLines } from "@xdev-hive/core";

/**
 * Where main.log lives: ~/Library/Logs/<app> on macOS (Console.app shows it), %APPDATA%\<app>\logs on Windows, and on
 * Linux $XDG_STATE_HOME/<app>/logs when set (logs are state in the XDG spec), else ~/.config/<app>/logs like Electron.
 */
export function mainLogDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string, name = "xDev Hive"): string {
  if (platform === "darwin") return path.join(home, "Library", "Logs", name);
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), name, "logs");
  if (env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, name, "logs");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), name, "logs");
}

/** One line per event; past maxBytes main.log becomes main.log.1 (and .1 → .2 …, `keep` old files at most). */
export class MainLog {
  readonly file: string;
  readonly #maxBytes: number;
  readonly #keep: number;
  readonly #now: () => Date;

  constructor(file: string, { maxBytes = 1_000_000, keep = 3, now = () => new Date() }: { maxBytes?: number; keep?: number; now?: () => Date } = {}) {
    this.file = file;
    this.#maxBytes = maxBytes;
    this.#keep = keep;
    this.#now = now;
  }

  // Written synchronously: the last lines before a quit are the ones that matter, and an async write may never land.
  write(text: string): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      if ((statSync(this.file, { throwIfNoEntry: false })?.size ?? 0) > this.#maxBytes) this.#rotate();
      appendFileSync(this.file, `[${this.#now().toISOString()}] ${redactLines(text).replace(/\s*\n\s*/g, " ").slice(0, 4000)}\n`);
    } catch {
      // A log that cannot be written must not take the app down as well.
    }
  }

  #rotate(): void {
    rmSync(`${this.file}.${this.#keep}`, { force: true });
    for (let i = this.#keep - 1; i >= 1; i--) if (existsSync(`${this.file}.${i}`)) renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
    renameSync(this.file, `${this.file}.1`);
  }
}

/**
 * Why the app is quitting. "user": the tray's or the menu's Quit (Cmd+Q). "shutdown": the computer shuts down,
 * restarts or logs out. "signal": SIGTERM/SIGINT/SIGHUP (kill, launchd, systemd). "update": a restart into a new build.
 * "unknown": anything else that quits the app, such as the Dock's Quit or an AppleScript quit on macOS.
 */
export type QuitReason = "user" | "shutdown" | "signal" | "update" | "unknown";

/** The first cause wins: a shutdown that then quits the app is a shutdown, not an unknown quit. */
export class QuitReasons {
  #reason: QuitReason | null = null;
  #detail = "";

  mark(reason: QuitReason, detail = ""): void {
    if (this.#reason) return;
    this.#reason = reason;
    this.#detail = detail;
  }

  get reason(): QuitReason {
    return this.#reason ?? "unknown";
  }

  /** "quit: user (tray)" — what main.log says at before-quit. */
  describe(): string {
    return `quit: ${this.reason}${this.#detail ? ` (${this.#detail})` : ""}`;
  }
}

/**
 * The rollout installs the new build when the app quits: should the app start again once it is swapped in?
 * Rule: a machine that takes work (accepts the hub's runs, or still had runs running or queued) comes back, opened
 * hidden in the tray like a start with the computer, so the hub does not lose a runner until someone opens it by hand.
 * Never when the person chose Quit ("user": they want it closed) or the computer is shutting down ("shutdown": it
 * starts at sign-in if they asked for that, and an app opening mid-shutdown could hold the shutdown up). A machine
 * that takes no work stays shut, as before.
 */
export function relaunchAfterQuitInstall(reason: QuitReason, takesWork: boolean): boolean {
  if (reason === "user" || reason === "shutdown") return false;
  return takesWork;
}

export const START_HIDDEN = "start-hidden";
/** Long enough for a slow swap; short enough that a helper that failed never hides a window someone opens later. */
const HIDDEN_FOR_MS = 10 * 60_000;

/**
 * The relaunch after an install at quit opens hidden. The NSIS installer's --force-run cannot pass --hidden, so the
 * updater leaves a marker beside its downloads that the next start reads (and removes) instead, on every platform.
 */
export function markStartHidden(updatesDir: string, now = Date.now()): void {
  mkdirSync(updatesDir, { recursive: true });
  writeFileSync(path.join(updatesDir, START_HIDDEN), String(now));
}

export function takeStartHidden(updatesDir: string, now = Date.now()): boolean {
  const file = path.join(updatesDir, START_HIDDEN);
  try {
    if (!existsSync(file)) return false;
    const at = Number(readFileSync(file, "utf8"));
    rmSync(file, { force: true });
    return Number.isFinite(at) && now - at >= 0 && now - at < HIDDEN_FOR_MS;
  } catch {
    return false;
  }
}
