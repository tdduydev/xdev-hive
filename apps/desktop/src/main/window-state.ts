// The window across a self-update (BUG-update-hidden-window, 10/10): an idle install on a Linux machine relaunched
// 0.162.0 hidden while the person had the window open, so the app looked gone. The updater now records whether the
// window was showing, and where, beside its downloads; the new build reads it once and opens the same way.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  /** Showing on screen (minimized counts: the person left it in the taskbar, not in the tray). */
  visible: boolean;
  /** Normal (not maximized) bounds, so a maximized window comes back maximized over the same place. */
  bounds?: Rect;
  maximized?: boolean;
  minimized?: boolean;
  /** The page it showed ("/tasks"). */
  hash?: string;
}

// The name builds before 0.162.1 wrote (a bare timestamp, always hidden): kept so their relaunch still reads it.
export const RELAUNCH_WINDOW = "start-hidden";
/** Long enough for a slow swap; short enough that a helper that failed never decides a window someone opens later. */
const VALID_FOR_MS = 10 * 60_000;

/** Written by the updater right before the helper that relaunches; also on Windows, as NSIS --force-run takes no args. */
export function markRelaunchWindow(updatesDir: string, window: WindowState, now = Date.now()): void {
  mkdirSync(updatesDir, { recursive: true });
  writeFileSync(path.join(updatesDir, RELAUNCH_WINDOW), JSON.stringify({ at: now, ...window }));
}

/** Read and removed by the next start; null for an ordinary start (no marker, or one too old to trust). */
export function takeRelaunchWindow(updatesDir: string, now = Date.now()): WindowState | null {
  const file = path.join(updatesDir, RELAUNCH_WINDOW);
  try {
    if (!existsSync(file)) return null;
    const text = readFileSync(file, "utf8").trim();
    rmSync(file, { force: true });
    const legacy = /^\d+$/.test(text);
    const raw = (legacy ? { at: Number(text), visible: false } : JSON.parse(text)) as Partial<WindowState> & { at?: unknown };
    const at = Number(raw.at);
    if (!Number.isFinite(at) || now - at < 0 || now - at >= VALID_FOR_MS) return null;
    return {
      visible: raw.visible === true,
      ...(isRect(raw.bounds) ? { bounds: raw.bounds } : {}),
      ...(raw.maximized === true ? { maximized: true } : {}),
      ...(raw.minimized === true ? { minimized: true } : {}),
      ...(typeof raw.hash === "string" && raw.hash ? { hash: raw.hash } : {}),
    };
  } catch {
    return null;
  }
}

function isRect(value: unknown): value is Rect {
  const r = value as Rect | null;
  return Boolean(r) && [r!.x, r!.y, r!.width, r!.height].every((n) => typeof n === "number" && Number.isFinite(n)) && r!.width > 0 && r!.height > 0;
}

/**
 * The saved bounds when they still land on a screen (a monitor unplugged or a remote session with a smaller desktop
 * would put the window out of reach): the title bar must overlap some display's work area by a usable strip.
 * Larger than that work area: shrunk to fit. Otherwise undefined, and the window opens centred at its default size.
 */
export function fitBounds(bounds: Rect | undefined, workAreas: Rect[], min = { width: 820, height: 560 }): Rect | undefined {
  if (!bounds) return undefined;
  const titleBar = { x: bounds.x, y: bounds.y, width: bounds.width, height: 40 };
  const area = workAreas.find((a) => overlap(titleBar, a) >= 80 * 20);
  if (!area) return undefined;
  const width = Math.max(Math.min(bounds.width, area.width), Math.min(min.width, area.width));
  const height = Math.max(Math.min(bounds.height, area.height), Math.min(min.height, area.height));
  return { x: bounds.x, y: bounds.y, width, height };
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
