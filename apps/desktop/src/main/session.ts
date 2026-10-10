// The app in another login session of the same Linux machine (BUG-update-hidden-window, 10/10): it ran in the Wayland
// session on seat0 while the person worked over xrdp in an xfce session (Xorg :10). Opening it there only woke the
// copy in the other session, whose window nobody could see. The second start now tells which session it is in, and
// the first one moves there when it can, or the second start says why it cannot yet.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * What a graphical program needs to open in a session, not only to tell it apart (DISPLAY, WAYLAND_DISPLAY,
 * XDG_SESSION_ID): an xrdp session has its own XAUTHORITY and session bus, and Electron picks X11 or Wayland by
 * XDG_SESSION_TYPE and WAYLAND_DISPLAY.
 */
export const SESSION_KEYS = [
  "DISPLAY", "WAYLAND_DISPLAY", "XDG_SESSION_ID", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP",
  "DESKTOP_SESSION", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR",
] as const;
export type SessionEnv = Partial<Record<(typeof SESSION_KEYS)[number], string>>;

/** The second start's additionalData for requestSingleInstanceLock (a type, as Electron takes a Record). */
export type SecondInstanceData = {
  pid: number;
  session: SessionEnv;
  /** Started again by the notice's "switch here once the runs are done": queue the move instead of asking. */
  switchWhenIdle?: boolean;
};

export const SWITCH_WHEN_IDLE = "--switch-when-idle";

export function sessionEnv(env: NodeJS.ProcessEnv): SessionEnv {
  const out: SessionEnv = {};
  for (const key of SESSION_KEYS) if (env[key]) out[key] = env[key];
  return out;
}

export function parseSecondInstanceData(data: unknown): SecondInstanceData | null {
  const d = data as Partial<SecondInstanceData> | null;
  if (!d || typeof d !== "object" || typeof d.pid !== "number" || !d.session || typeof d.session !== "object") return null;
  const session: SessionEnv = {};
  for (const key of SESSION_KEYS) {
    const value = (d.session as Record<string, unknown>)[key];
    if (typeof value === "string" && value) session[key] = value;
  }
  return { pid: d.pid, session, ...(d.switchWhenIdle === true ? { switchWhenIdle: true } : {}) };
}

const hasDisplay = (s: SessionEnv) => Boolean(s.DISPLAY || s.WAYLAND_DISPLAY);

/**
 * The session id decides when both have one. GNOME starts apps from the systemd user manager, whose environment often
 * lacks XDG_SESSION_ID, so without it the displays decide: one session's Wayland socket and XWayland display stay
 * the same for every app in it, and another session (xrdp's :10) has others.
 */
export function sameSession(a: SessionEnv, b: SessionEnv): boolean {
  if (a.XDG_SESSION_ID && b.XDG_SESSION_ID) return a.XDG_SESSION_ID === b.XDG_SESSION_ID;
  return (a.DISPLAY ?? "") === (b.DISPLAY ?? "") && (a.WAYLAND_DISPLAY ?? "") === (b.WAYLAND_DISPLAY ?? "");
}

/**
 * show: open the window here, as before (same session, not Linux, an older build that sent nothing, or a start with no
 * display such as over ssh). move: nothing is running, so quit and start again in the new session. busy: runs would
 * be cut, so the new session is told and may ask to move once they are done. queue: it asked; move when idle.
 */
export type SessionAction = "show" | "move" | "busy" | "queue";

export function secondInstanceAction({ platform, mine, theirs, busy }: { platform: NodeJS.Platform; mine: SessionEnv; theirs: SecondInstanceData | null; busy: boolean }): SessionAction {
  if (platform !== "linux" || !theirs || !hasDisplay(theirs.session) || sameSession(mine, theirs.session)) return "show";
  if (!busy) return "move";
  return theirs.switchWhenIdle ? "queue" : "busy";
}

/** This process's environment with the other session's keys in place; a key that session lacks is dropped too. */
export function envForSession(base: NodeJS.ProcessEnv, target: SessionEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of SESSION_KEYS) {
    if (target[key]) env[key] = target[key];
    else delete env[key];
  }
  return env;
}

/** How to start this app again: an AppImage through its file (its mount goes away with this process). */
export function selfCommand(execPath: string, argv: string[], env: NodeJS.ProcessEnv): { file: string; args: string[] } {
  return { file: env.APPIMAGE || execPath, args: argv.slice(1).filter((a) => a !== "--hidden" && a !== SWITCH_WHEN_IDLE) };
}

/** The first instance's answer, which the second one waits for: second-instance has no reply channel on Linux. */
export interface HandoffReply {
  action: SessionAction;
  /** Runs running in the other session. */
  runs: number;
  locale: string;
  at: number;
}

const replyFile = (dir: string, pid: number) => path.join(dir, `handoff-${pid}.json`);

export function writeHandoff(dir: string, pid: number, reply: HandoffReply): void {
  mkdirSync(dir, { recursive: true });
  // Renamed into place, so the waiting start never reads half a file.
  const tmp = `${replyFile(dir, pid)}.tmp`;
  writeFileSync(tmp, JSON.stringify(reply));
  renameSync(tmp, replyFile(dir, pid));
}

/** Null when no answer came in time: a first instance from before this change, which only showed its window. */
export async function waitHandoff(dir: string, pid: number, timeoutMs = 5000, pollMs = 100): Promise<HandoffReply | null> {
  const file = replyFile(dir, pid);
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(file)) {
      try {
        const reply = JSON.parse(readFileSync(file, "utf8")) as HandoffReply;
        rmSync(file, { force: true });
        return reply;
      } catch {
        return null;
      }
    }
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
