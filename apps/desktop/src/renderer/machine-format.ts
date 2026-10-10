// Numbers on Máy này, as text. Free of React so a test can read it.

/** 1536 → "1.5 KiB"; the unit grows by 1024 like the disk and memory figures the system reports. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** used / total as a whole percent, clamped to 0–100; null when the total is unknown or zero. */
export function percentOf(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
}

/** The 1-minute load per core as a percent of the cores; it may pass 100 when work is queued, the bar stops at 100. */
export const loadPercent = (load: number | null): number | null => (load === null ? null : Math.max(0, Math.round(load * 100)));

/** Seconds up → the two largest units worth showing. */
export function uptimeParts(seconds: number): { days: number; hours: number; minutes: number } {
  const total = Math.max(0, Math.floor(seconds / 60));
  return { days: Math.floor(total / 1440), hours: Math.floor((total % 1440) / 60), minutes: total % 60 };
}
