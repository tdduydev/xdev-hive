import { format } from "node:util";
import { createHash } from "node:crypto";
import { redactLines, stripHidden, type DeployLogInfo } from "@xdev-hive/core";

const DAY = 24 * 3_600_000;
const MAX_LINES = 50_000;
const MAX_TEXT = 2_000;
type Level = "error" | "warning";
type Entry = { at: number; level: Level; key: string; message: string };

/** IDs and numbers vary between retries; keep the surrounding words to identify the failure. */
export function logPattern(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\b[\w.-]*(?:id|run|request|task)[=:][\w.-]+/gi, "<id>")
    .replace(/\b(?:R|T|run|task)-[A-Za-z0-9_-]+\b/gi, "<id>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ").trim();
}

export class DeployLog {
  readonly startedAt: string;
  readonly threshold: number;
  backup: DeployLogInfo["backup"] = "off";
  #entries: Entry[] = [];
  #dropped = 0;
  readonly #now: () => number;

  constructor({ now = Date.now, threshold = 10 }: { now?: () => number; threshold?: number } = {}) {
    this.#now = now;
    this.startedAt = new Date(now()).toISOString();
    this.threshold = Number.isSafeInteger(threshold) && threshold > 0 ? threshold : 10;
  }

  record(level: Level, text: string): void {
    if (!text.includes("[xdev-hive]")) return;
    this.#prune();
    // Filter the complete line before truncation: a credential may be beyond the display limit.
    for (const line of redactLines(stripHidden(text)).split("\n").filter((s) => s.trim())) {
      const message = line.slice(0, MAX_TEXT);
      const key = createHash("sha256").update(logPattern(message)).digest("hex");
      this.#entries.push({ at: this.#now(), level, key, message });
    }
    if (this.#entries.length > MAX_LINES) {
      this.#dropped += this.#entries.length - MAX_LINES;
      this.#entries.splice(0, this.#entries.length - MAX_LINES);
    }
  }

  #prune(): void {
    const since = this.#now() - DAY;
    const first = this.#entries.findIndex((e) => e.at > since);
    if (first < 0) this.#entries = [];
    else if (first > 0) this.#entries.splice(0, first);
  }

  info(): DeployLogInfo {
    this.#prune();
    const groups = new Map<string, DeployLogInfo["groups"][number]>();
    const hour = this.#now() - 3_600_000;
    for (const e of this.#entries) {
      const id = `${e.level}:${e.key}`;
      const group = groups.get(id) ?? { key: e.key, level: e.level, message: e.message, count: 0, hourCount: 0, lastAt: "" };
      group.count++;
      if (e.at > hour) group.hourCount++;
      group.lastAt = new Date(e.at).toISOString();
      groups.set(id, group);
    }
    return {
      startedAt: this.startedAt, backup: this.backup, threshold: this.threshold, dropped: this.#dropped,
      errors: this.#entries.filter((e) => e.level === "error").length,
      warnings: this.#entries.filter((e) => e.level === "warning").length,
      groups: [...groups.values()].sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt)),
    };
  }
}

export const deployLog = new DeployLog({ threshold: Number(process.env.HIVE_LOG_REPEAT_THRESHOLD ?? 10) });

/** Use only for hub diagnostics; bootstrap credentials deliberately keep their separate output. */
export const hubLog = {
  log: (...args: unknown[]) => console.log(...args),
  error: (...args: unknown[]) => { deployLog.record("error", format(...args)); console.error(...args); },
  warn: (...args: unknown[]) => { deployLog.record("warning", format(...args)); console.warn(...args); },
};
