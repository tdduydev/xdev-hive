import path from "node:path";
import { resetText } from "./usage.ts";
import { tr } from "#desktop/main/i18n.ts";
import { compareVersions, flagValue, type PlanLimit, type PlanUsage } from "@xdev-hive/core";

export const AGY_USAGE_ARGS = ["-p", "/usage", "--output-format", "json"];

/** /usage was a billable prompt before 1.1.11 (docs/specs/53-antigravity.md). Unknown versions stay off. */
export function supportsAgyUsage(output: string): boolean {
  const version = /\b(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(output)?.[1];
  return !!version && compareVersions(version, "1.1.11") >= 0;
}

type Json = Record<string, unknown>;
const object = (v: unknown): Json => v && typeof v === "object" && !Array.isArray(v) ? v as Json : {};
function limit(v: unknown): PlanLimit | null {
  const j = object(v);
  const n = j.percent ?? j.used_percent ?? j.usedPercent;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 100) return null;
  const reset = j.resets ?? j.resets_at ?? j.resetsAt;
  const iso = typeof reset === "string" && /^\d{4}-\d{2}-\d{2}T/.test(reset) ? new Date(reset) : null;
  return { percent: n, resets: iso && !Number.isNaN(iso.getTime()) ? resetText(iso, "UTC") : typeof reset === "string" ? reset : null };
}

/** Provisional aliases until a real /usage sample exists; missing fields never imply zero usage. */
export function parseAgyUsage(output: string, args: string[], now: Date): PlanUsage | null {
  let root: Json;
  try { root = object(JSON.parse(output)); } catch { return null; }
  const pools = object(root.pools ?? root.usage ?? root);
  const gemini = object(pools.gemini);
  const other = object(pools.claude_gpt ?? pools.claudeGpt ?? pools.claude);
  const windows = (p: Json) => ({ session: limit(p.session ?? p.five_hour ?? p.fiveHour), week: limit(p.week ?? p.weekly) });
  const alternate = /claude|gpt/i.test(flagValue(args, ["--model"]) ?? "");
  const selected = windows(alternate ? other : gemini);
  const secondary = windows(alternate ? gemini : other);
  const label = alternate ? "Gemini" : "Claude/GPT";
  if (![selected.session, selected.week, secondary.session, secondary.week].some(Boolean)) return null;
  return { ...selected, others: [
    ...(secondary.session ? [{ ...secondary.session, label: tr("agents.agyPoolSession", { pool: label }) }] : []),
    ...(secondary.week ? [{ ...secondary.week, label: tr("agents.agyPoolWeek", { pool: label }) }] : []),
  ], checkedAt: now.toISOString() };
}

/** Headless errors use AGY_ERROR even after output; retain the whole payload for diagnosis. */
export function agyError(output: string): string | null {
  return [...output.matchAll(/^AGY_ERROR:[\t ]*([^\r\n]*)/gm)].at(-1)?.[1]?.trim() ?? null;
}

// Provisional messages from the headless docs cited in spec 53; update after a real quota failure is recorded.
export const AGY_LIMIT_PATTERN = /rate[_ -]?limit|quota[_ -]?(?:exceeded|exhausted)|resource_exhausted|usage limit|too many requests|\b429\b/i;

/** Experimental file-based Linux isolation; OS keyrings on macOS/Windows remain shared. */
export function antigravityHome(id: string, platform: NodeJS.Platform, home: string, hasAnother: boolean): string | null {
  return platform === "linux" && hasAnother ? path.join(home, ".xdev-hive", "antigravity", id) : null;
}
