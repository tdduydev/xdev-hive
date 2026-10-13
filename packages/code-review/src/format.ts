import type { CodeReviewText } from "./text.ts";

const HOUR = 3_600_000;

export const shortSha = (sha: string) => sha.slice(0, 7);

export function formatScore(t: CodeReviewText, n: number | null): string {
  return n === null
    ? "—"
    : new Intl.NumberFormat(t.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);
}

export function formatSpan(t: CodeReviewText, ms: number): string {
  const h = Math.max(1, Math.round(Math.abs(ms) / HOUR));
  return h > 48 ? t.days(Math.round(h / 24)) : t.hours(h);
}

export function formatSla(
  t: CodeReviewText,
  gate: { sla: keyof CodeReviewText["slaText"]; dueAt: string | null },
  now: number,
) {
  if (gate.sla === "none" || !gate.dueAt) return t.slaText[gate.sla];
  const left = new Date(gate.dueAt).getTime() - now;
  return gate.sla === "overdue" ? t.overdueBy(formatSpan(t, left)) : t.left(formatSpan(t, left));
}

/** Tên nhà cung cấp Git theo máy chủ của URL PR; GitLab tự dựng có "gitlab" trong tên miền, còn lại coi là GitHub. */
export function providerName(prUrl: string): string {
  try {
    return new URL(prUrl).hostname.includes("gitlab") ? "GitLab" : "GitHub";
  } catch {
    return "GitHub";
  }
}
