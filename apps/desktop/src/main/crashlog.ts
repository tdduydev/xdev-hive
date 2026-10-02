// Why the window went blank (asked 2/10: "app client hay bị trắng"): render errors the interface caught, and the
// renderer process dying or failing to load, go to a log next to config.json, so the next report has something to read.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

const MAX_BYTES = 1_000_000;

export const crashLogPath = (dataDir: string): string => path.join(dataDir, "logs", "renderer.log");

/** One timestamped entry; past 1 MB the file moves to renderer.log.1, so it never grows without end. */
export function appendCrashLog(file: string, text: string, now = new Date()): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(file, `${file}.1`);
    appendFileSync(file, `[${now.toISOString()}] ${text.slice(0, 20_000)}\n\n`);
  } catch {
    // A log that cannot be written must not take the app down as well.
  }
}

/** Reloads a dead renderer, but at most `max` times in `windowMs`: a page that crashes as it loads would loop. */
export class ReloadGuard {
  #times: number[] = [];
  readonly #max: number;
  readonly #windowMs: number;
  constructor(max = 3, windowMs = 5 * 60_000) {
    this.#max = max;
    this.#windowMs = windowMs;
  }

  allow(now = Date.now()): boolean {
    this.#times = this.#times.filter((t) => now - t < this.#windowMs);
    if (this.#times.length >= this.#max) return false;
    this.#times.push(now);
    return true;
  }
}
