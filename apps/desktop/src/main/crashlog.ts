// Why the window went blank (asked 2/10: "app client hay bị trắng"): render errors the interface caught, and the
// renderer process dying or failing to load, go to a log next to config.json, so the next report has something to read.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { redactLines } from "@xdev-hive/core";

const MAX_BYTES = 1_000_000;

export const crashLogPath = (dataDir: string): string => path.join(dataDir, "logs", "renderer.log");

/** One timestamped entry; past 1 MB the file moves to renderer.log.1, so it never grows without end. */
export function appendCrashLog(file: string, text: string, now = new Date()): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(file, `${file}.1`);
    appendFileSync(file, `[${now.toISOString()}] ${redactLines(text).slice(0, 20_000)}\n\n`);
  } catch {
    // A log that cannot be written must not take the app down as well.
  }
}

/** Limits fast crash loops with `max/windowMs`, and recurring OOMs with a lifetime `maxTotal` budget. */
export class ReloadGuard {
  #times: number[] = [];
  readonly #max: number;
  readonly #windowMs: number;
  readonly #maxTotal: number;
  #total = 0;
  constructor(max = 3, windowMs = 5 * 60_000, maxTotal = Infinity) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#maxTotal = maxTotal;
  }

  allow(now = Date.now()): boolean {
    this.#times = this.#times.filter((t) => now - t < this.#windowMs);
    if (this.#times.length >= this.#max || this.#total >= this.#maxTotal) return false;
    this.#times.push(now);
    this.#total++;
    return true;
  }
}

export interface RendererMemorySample {
  at: number;
  pid: number;
  workingSetKB: number;
  peakWorkingSetKB: number;
  privateBytesKB?: number;
}

/** The process is already gone at crash time, so label the last live sample and its age explicitly. */
export function rendererGoneText(details: { reason: string; exitCode: number }, memory: RendererMemorySample | null, mainRSSBytes: number, recovery: string, now = Date.now()): string {
  const sample = memory
    ? `pid=${memory.pid} sampleAgeMs=${Math.max(0, now - memory.at)} workingSetKB=${memory.workingSetKB} peakWorkingSetKB=${memory.peakWorkingSetKB}${memory.privateBytesKB === undefined ? "" : ` privateBytesKB=${memory.privateBytesKB}`}`
    : "lastRendererMemory=unavailable";
  return `render-process-gone: ${details.reason} (exit ${details.exitCode}); ${sample}; mainRSSBytes=${mainRSSBytes}; recovery=${recovery}`;
}
