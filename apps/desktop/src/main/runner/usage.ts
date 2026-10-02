// What an agent CLI says about a finished run. Claude Code with `--output-format json` prints one
// result object: the final message, an API-price cost estimate and token counts. Codex with `exec --json` reports the
// tokens of each turn (roadmap 28c).
import type { PlanLimit, PlanUsage } from "@xdev-hive/core";

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

/** The `--output-format` a claude command line asks for, or null when it names none. */
export function outputFormat(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--output-format") return args[i + 1] ?? null;
    if (a.startsWith("--output-format=")) return a.slice("--output-format=".length);
  }
  return null;
}
