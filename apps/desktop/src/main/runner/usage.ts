// What an agent CLI says about a finished run. Claude Code with `--output-format json` prints one
// result object: the final message, an API-price cost estimate and token counts. Codex with `exec --json` reports the
// tokens of each turn (roadmap 28c).
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";
import type { AgentProfile, PlanLimit, PlanUsage } from "@xdev-hive/core";

export interface RunUsage {
  /** The agent's final message; replaces the raw stdout as the run's summary. */
  text: string | null;
  /** Estimated at API prices; a subscription does not bill it. */
  costUsd: number | null;
  /** Input tokens read fresh: neither written to the prompt cache nor read from it (roadmap 28c). */
  inputTokens: number | null;
  /** Input written to the prompt cache (Claude); Codex has no such count (0). */
  cacheWriteTokens: number | null;
  /** Input read from the prompt cache: what a long session saves by reusing its prefix. */
  cacheReadTokens: number | null;
  outputTokens: number | null;
}


const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** The last `{"type":"result",…}` line on stdout, or null when there is none. */
export function parseClaudeResult(stdout: string): RunUsage | null {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (json.type !== "result") continue;
    const usage = (json.usage ?? {}) as Record<string, unknown>;
    // Kept apart (roadmap 28c): input_tokens is what was neither written to the cache nor read from it.
    return {
      text: typeof json.result === "string" ? json.result : null,
      costUsd: count(json.total_cost_usd),
      inputTokens: count(usage.input_tokens),
      cacheWriteTokens: count(usage.cache_creation_input_tokens),
      cacheReadTokens: count(usage.cache_read_input_tokens),
      outputTokens: count(usage.output_tokens),
    };
  }
  return null;
}

/**
 * A Codex run's tokens from `codex exec --json`: the usage of every `turn.completed` added up. OpenAI counts cached
 * input inside input_tokens, so it is taken out to mean what Claude's input_tokens means. [Unverified] against every
 * Codex version: the event and field names are those of codex-cli 0.1xx's exec --json; a line it does not know is skipped.
 */
export function parseCodexUsage(stdout: string, lastMessage: string | null = null): RunUsage | null {
  let input = 0;
  let cached = 0;
  let output = 0;
  let turns = 0;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e.type !== "turn.completed") continue;
    const u = (e.usage ?? {}) as Record<string, unknown>;
    turns++;
    input += count(u.input_tokens) ?? 0;
    cached += count(u.cached_input_tokens) ?? 0;
    output += count(u.output_tokens) ?? 0;
  }
  if (!turns) return null;
  return { text: lastMessage, costUsd: null, inputTokens: Math.max(0, input - cached), cacheWriteTokens: 0, cacheReadTokens: cached, outputTokens: output };
}

/** "Current session: 3% used · resets Sep 28 at 6:19pm (Asia/Saigon)", "Current week (all models): 47% used · …". */
const LIMIT_LINE = /^Current (session|week(?: \(([^)]+)\))?):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+))?$/;

/** Plan usage from Claude Code's /usage text; null when it names no limit (an API key, an older CLI). */
export function parsePlanUsage(text: string, now: Date): PlanUsage | null {
  let session: PlanLimit | null = null;
  let week: PlanLimit | null = null;
  const others: PlanUsage["others"] = [];
  for (const line of text.split("\n")) {
    const m = LIMIT_LINE.exec(line.trim());
    if (!m) continue;
    const limit = { percent: Number(m[3]), resets: m[4]?.trim() || null };
    if (m[1] === "session") session = limit;
    else if (!m[2] || /^all models$/i.test(m[2])) week = limit;
    else others.push({ label: m[2], ...limit });
  }
  return session || week || others.length ? { session, week, others, checkedAt: now.toISOString() } : null;
}

/** Session files looked at, newest first: the latest Codex turn is in one of the last few. */
const CODEX_FILES = 6;
/** Bytes read from the end of one session file before giving up on it: a long session reports its limits every turn. */
const CODEX_TAIL = 8 * 1024 * 1024;

/** The names in `dir` made of digits only (a year, month or day folder), highest first; none when it cannot be read. */
function numbered(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => /^\d+$/.test(n))
      .sort((a, b) => Number(b) - Number(a));
  } catch {
    return [];
  }
}

/** The newest rollout files under `<home>/sessions/YYYY/MM/DD`: from the latest day folders, then by mtime. */
function codexSessionFiles(home: string): Array<{ file: string; mtime: number }> {
  const root = path.join(home, "sessions");
  const found: Array<{ file: string; mtime: number }> = [];
  days: for (const y of numbered(root))
    for (const m of numbered(path.join(root, y)))
      for (const d of numbered(path.join(root, y, m))) {
        if (found.length >= CODEX_FILES) break days;
        const dir = path.join(root, y, m, d);
        let names: string[] = [];
        try {
          names = readdirSync(dir).filter((n) => n.startsWith("rollout-") && n.endsWith(".jsonl"));
        } catch {
          continue;
        }
        for (const n of names) {
          try {
            found.push({ file: path.join(dir, n), mtime: statSync(path.join(dir, n)).mtimeMs });
          } catch {
            // Gone since the listing.
          }
        }
      }
  // A session started before midnight is still in yesterday's folder while it writes: mtime orders the few found.
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, CODEX_FILES);
}

/** A file's lines from the last one back, read in chunks so a long session file is not read whole. */
function* linesFromEnd(file: string, max = CODEX_TAIL, chunk = 64 * 1024): Generator<string> {
  const fd = openSync(file, "r");
  try {
    let pos = fstatSync(fd).size;
    const stop = Math.max(0, pos - max);
    // Kept as bytes: a chunk may end inside a multi-byte character.
    let carry = Buffer.alloc(0);
    while (pos > stop) {
      const len = Math.min(chunk, pos - stop);
      pos -= len;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, pos);
      const data = Buffer.concat([buf, carry]);
      let end = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 0x0a) continue;
        if (i + 1 < end) yield data.subarray(i + 1, end).toString("utf8");
        end = i;
      }
      carry = data.subarray(0, end);
    }
    // Only a whole line: the start of the file, not the middle of one cut by the byte limit.
    if (pos === 0 && carry.length) yield carry.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** "Oct 8 at 5:59pm (Asia/Saigon)": the form Claude Code's /usage uses, so parseResetAt and the pages read both alike. */
export function resetText(at: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(at);
  const part = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${part("month")} ${part("day")} at ${part("hour")}:${part("minute")}${part("dayPeriod").toLowerCase()} (${zone})`;
}

/** One of Codex's rate-limit windows as a PlanLimit; a window whose reset is past starts again at 0. */
function codexLimit(w: unknown, now: Date, zone: string): PlanLimit | null {
  if (!w || typeof w !== "object") return null;
  const { used_percent, resets_at } = w as Record<string, unknown>;
  if (typeof used_percent !== "number" || !Number.isFinite(used_percent)) return null;
  const at = typeof resets_at === "number" && Number.isFinite(resets_at) ? new Date(resets_at * 1000) : null;
  if (at && at.getTime() <= now.getTime()) return { percent: 0, resets: null };
  return { percent: used_percent, resets: at ? resetText(at, zone) : null };
}

/**
 * Codex's plan usage from its own session files (roadmap 45): every turn writes a token_count event with the
 * plan's rate limits to `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`, primary the 5-hour window and secondary
 * the week. Codex has no command that prints them, so nothing is run; the numbers are those of the last turn on this
 * machine, and checkedAt says when that was. Null when no session file has them (no folder, a Codex too old).
 * [Unverified] beyond codex-cli 0.160.0: the event and field names are the ones it writes.
 */
export function readCodexUsage(home: string, now: Date, zone = Intl.DateTimeFormat().resolvedOptions().timeZone): PlanUsage | null {
  for (const { file, mtime } of codexSessionFiles(home)) {
    let lines: Generator<string>;
    try {
      lines = linesFromEnd(file);
    } catch {
      continue;
    }
    try {
      for (const raw of lines) {
        // Most lines are messages: only those that can be a limit report are parsed.
        if (!raw.includes('"rate_limits"') || !raw.includes('"token_count"')) continue;
        let e: { timestamp?: unknown; type?: unknown; payload?: { type?: unknown; rate_limits?: Record<string, unknown> | null } };
        try {
          e = JSON.parse(raw) as typeof e;
        } catch {
          continue;
        }
        const limits = e.payload?.rate_limits;
        // "premium" and other ids come with null windows: only the plan's own counts.
        if (e.type !== "event_msg" || e.payload?.type !== "token_count" || !limits || limits.limit_id !== "codex") continue;
        if (!limits.primary && !limits.secondary) continue;
        const stamp = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
        return {
          session: codexLimit(limits.primary, now, zone),
          week: codexLimit(limits.secondary, now, zone),
          others: [],
          checkedAt: new Date(Number.isNaN(stamp) ? mtime : stamp).toISOString(),
        };
      }
    } catch {
      // Unreadable now (removed, no permission): the next file may do.
    }
  }
  return null;
}

/** The `--output-format` a claude command line asks for, or null when it names none. */
export function outputFormat(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--output-format") return args[i + 1] ?? null;
    if (a.startsWith("--output-format=")) return a.slice("--output-format=".length);
  }
  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** "Oct 8 at 5:59pm (Asia/Saigon)", "6:20pm (Asia/Saigon)", "Oct 8, 6pm (Asia/Ho_Chi_Minh)"; the month and day are optional. */
const RESET_TEXT = /^(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,|\s+at)?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([A-Za-z0-9_+\-/]+)\)$/i;

/** How far `zone` is ahead of UTC at `at`, in ms; null for a zone this runtime does not know. */
function zoneOffset(at: number, zone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    }).formatToParts(new Date(at));
    const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(at / 1000) * 1000;
  } catch {
    return null;
  }
}

/** The instant a wall-clock time in `zone` names; checked twice so a DST change between guess and answer is caught. */
function zonedTime(y: number, mo: number, d: number, h: number, mi: number, zone: string): number | null {
  const wall = Date.UTC(y, mo, d, h, mi);
  const first = zoneOffset(wall, zone);
  if (first === null) return null;
  const second = zoneOffset(wall - first, zone)!;
  return wall - second;
}

/**
 * When a plan limit resets, from the text Claude Code's /usage prints after "resets" (roadmap 24c). The CLI leaves out
 * the year, and the date when the reset is today: the next such time after `now` (a day back is allowed, as /usage may
 * be a few minutes old). Null when the text is not one of these forms or has no known time zone: then it is not known.
 */
export function parseResetAt(text: string | null | undefined, now: Date): Date | null {
  const m = RESET_TEXT.exec((text ?? "").trim());
  if (!m) return null;
  const [, mon, day, hh, mm, ampm, zone] = m;
  let hour = Number(hh);
  const minute = Number(mm ?? 0);
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const offset = zoneOffset(now.getTime(), zone!);
  if (offset === null) return null;
  // Today's date as the zone has it.
  const local = new Date(now.getTime() + offset);
  const year = local.getUTCFullYear();
  const slack = 24 * 3600_000;
  if (mon) {
    const month = MONTHS.indexOf(mon.toLowerCase());
    const date = Number(day);
    if (month < 0 || date < 1 || date > 31) return null;
    for (const y of [year, year + 1]) {
      const at = zonedTime(y, month, date, hour, minute, zone!);
      if (at !== null && at > now.getTime() - slack) return new Date(at);
    }
    return null;
  }
  for (const add of [0, 1]) {
    const at = zonedTime(year, local.getUTCMonth(), local.getUTCDate() + add, hour, minute, zone!);
    if (at !== null && at > now.getTime()) return new Date(at);
  }
  return null;
}

/**
 * When the limit that stops the profile first resets (the session or the week, whichever has less left before its
 * threshold), or null when that is not known or already past: then the profile's quota is not about to go to waste.
 */
export function limitResetAt(profile: Pick<AgentProfile, "stopAtSession" | "stopAtWeek">, usage: PlanUsage | null | undefined, now: Date): Date | null {
  const limits = [
    usage?.session ? { left: profile.stopAtSession - usage.session.percent, resets: usage.session.resets } : null,
    usage?.week ? { left: profile.stopAtWeek - usage.week.percent, resets: usage.week.resets } : null,
  ].filter((l) => l !== null);
  if (!limits.length) return null;
  const binding = limits.reduce((a, b) => (b.left < a.left ? b : a));
  const at = parseResetAt(binding.resets, now);
  return at && at > now ? at : null;
}
