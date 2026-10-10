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

/** The 1-minute load per core as a percent of the cores, for the bar: stops at 100 (overloaded() says when it passed). */
export const loadPercent = (load: number | null): number | null => (load === null ? null : Math.min(100, Math.max(0, Math.round(load * 100))));

/** More work queued than the cores can run: the bar turns to a warning however full it already looked. */
export const overloaded = (load: number | null): boolean => load !== null && load > 1;

/**
 * The load as the system counts it, for the number beside the bar: 1.46 per core on 8 cores reads "11,7" in Vietnamese.
 * "146 %" left people asking how a CPU passes 100; a figure next to the core count does not.
 */
export const loadFigure = (load: number, cores: number, intl: string): string =>
  (load * cores).toLocaleString(intl, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const OS_NAMES: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

/** process.platform as people say it ("darwin" → "macOS"), with the version when the app knows it. */
export function platformName(platform: string, version?: string | null): string {
  const name = OS_NAMES[platform] ?? platform;
  return version ? `${name} ${version}` : name;
}

/** Seconds up → the two largest units worth showing. */
export function uptimeParts(seconds: number): { days: number; hours: number; minutes: number } {
  const total = Math.max(0, Math.floor(seconds / 60));
  return { days: Math.floor(total / 1440), hours: Math.floor((total % 1440) / 60), minutes: total % 60 };
}
