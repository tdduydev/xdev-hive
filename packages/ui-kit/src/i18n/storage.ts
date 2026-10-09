// The chosen language in the browser (web hub, desktop renderer).
import { DEFAULT_LOCALE, isLocale, type Locale } from "./translate.ts";

const STORAGE = "xdev-hive.locale";

/** Saved choice; otherwise Vietnamese (the team's language) until someone picks another. */
export function readLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE);
    if (isLocale(saved)) return saved;
  } catch {
    // Storage blocked (private window).
  }
  return DEFAULT_LOCALE;
}

export function writeLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE, locale);
  } catch {
    // Storage blocked: the choice lasts for this session only.
  }
}
