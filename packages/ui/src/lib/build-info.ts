// The hub's build (UI-hub-build-info) in words, for the Hub page, the status bar and the account menu.
import type { HubBuild } from "@xdev-hive/core";

type Translate = (key: "build.dev" | "build.unknownDate" | "build.tip", vars?: Record<string, string>) => string;

/** The build date in the reader's locale and time zone; null when there is none or it is not a date. */
export function formatBuildDate(iso: string | null | undefined, locale: string, opts: { short?: boolean; timeZone?: string } = {}): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(locale, opts.short ? { dateStyle: "medium", timeZone: opts.timeZone } : { dateStyle: "medium", timeStyle: "short", timeZone: opts.timeZone });
}

/**
 * What to print: the image's version (0.158.0+6dc8d24) when it was built with one; otherwise the app's version marked
 * as a dev build, so an image built by hand never passes for a release.
 */
export function buildText(b: HubBuild, locale: string, t: Translate, timeZone?: string): { label: string; date: string; tip: string } {
  const version = b.buildVersion ?? `${b.version}${b.commit ? `+${b.commit.slice(0, 7)}` : ""} (${t("build.dev")})`;
  const date = formatBuildDate(b.buildDate, locale, { timeZone }) ?? t("build.unknownDate");
  const short = formatBuildDate(b.buildDate, locale, { short: true, timeZone });
  return {
    label: short ? `${version} · ${short}` : version,
    date,
    tip: t("build.tip", { version, date, commit: b.commit ?? "—" }),
  };
}
