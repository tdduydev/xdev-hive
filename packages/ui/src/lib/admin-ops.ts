// Pure helpers of the Quản trị operations blocks (pages/admin/cosmic.tsx), apart so they can be tested without React.

/** A dot's colour is a tone, not a hex, so light and dark themes both get a readable one. */
export type AdminTone = "ok" | "warn" | "bad" | "run" | "info" | "neutral";

/** Percent of a limit used, clamped for a bar; null when there is no limit to measure against. */
export function usedPercent(used: number, limit: number | undefined | null): number | null {
  if (limit === undefined || limit === null || !(limit > 0)) return null;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

/** Red from the cap, amber from 70%: the same thresholds the old budget bars had. */
export function toneForRatio(ratio: number): AdminTone {
  return ratio >= 1 ? "bad" : ratio >= 0.7 ? "warn" : "ok";
}

