// Recognises "out of quota" exits from coding-agent CLIs and, when the message says so, when the quota resets.
// Message formats change between CLI versions: these patterns come from observed output and are best-effort.
// Only the tail of a *failed* run is checked, so a task that merely talks about rate limiting is not misread.

export interface RateLimitHit {
  /** Matched text, for the run log / UI. */
  reason: string;
  /** Parsed reset time, or null to fall back to the profile's cooldownMinutes. */
  resetAt: Date | null;
}

const PATTERNS: RegExp[] = [
  /usage limit (?:reached|exceeded)/i,
  /hit your (?:usage )?limit/i,
  /\b\d+-hour limit reached/i,
  /weekly limit reached/i,
  /rate[- ]?limit(?:ed| exceeded| reached)/i,
  /quota (?:exceeded|exhausted)/i,
  /RESOURCE_EXHAUSTED/,
  /too many requests/i,
  /\b429\b/,
  /out of (?:credits|quota)/i,
  /credit balance is too low/i,
];

const TAIL = 4000;

export function detectRateLimit(output: string, now: Date = new Date()): RateLimitHit | null {
  const tail = output.slice(-TAIL);
  for (const pattern of PATTERNS) {
    const match = pattern.exec(tail);
    if (match) return { reason: lineAround(tail, match.index), resetAt: parseResetTime(tail, now) };
  }
  return null;
}

function lineAround(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? undefined : end).trim().slice(0, 300);
}

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseResetTime(text: string, now: Date = new Date()): Date | null {
  // "…limit reached|1767225600" (epoch seconds after a pipe)
  const epoch = /\|(\d{10})\b/.exec(text);
  if (epoch) return new Date(Number(epoch[1]) * 1000);

  // ISO timestamp near "reset"
  const iso = /reset[s]?\D{0,20}(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(text);
  if (iso) {
    const d = new Date(iso[1]!);
    if (!Number.isNaN(d.getTime())) return d;
  }

  // "try again in 2 hours 13 minutes", "retry after 30s", "resets in 5h"
  const rel = /(?:try again|retry|reset[s]?|available again)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)[\s,and]*)+)/i.exec(
    text,
  );
  if (rel) {
    let ms = 0;
    for (const part of rel[1]!.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) {
      ms += Number(part[1]) * UNIT_MS[part[2]!.toLowerCase()]!;
    }
    if (ms > 0) return new Date(now.getTime() + ms);
  }

  // "resets 3pm", "resets at 15:30" (local time, next occurrence)
  const clock = /reset[s]?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] ?? 0);
    const meridiem = clock[3]?.toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (hour < 24 && minute < 60 && (meridiem || clock[2])) {
      const d = new Date(now);
      d.setHours(hour, minute, 0, 0);
      if (d <= now) d.setDate(d.getDate() + 1);
      return d;
    }
  }
  return null;
}
