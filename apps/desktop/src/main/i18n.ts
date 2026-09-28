// The language of what the main process writes for people (tray, notifications, dialogs, Machine
// setup items, sync notes): the one the interface shows, which the renderer reports (setLocale).
// Text for agents and for the team's data (prompts, handoff notes, MR descriptions) stays as it is.
import { DEFAULT_LOCALE, isLocale, translate, type Locale, type MessageKey } from "@xdev-hive/ui/i18n";

let locale: Locale = DEFAULT_LOCALE;

/** Switches the language; false when it is unknown or already current. */
export function setMainLocale(next: unknown): next is Locale {
  if (!isLocale(next) || next === locale) return false;
  locale = next;
  return true;
}

export const mainLocale = (): Locale => locale;

export const tr = (key: MessageKey, vars?: Record<string, string | number>): string => translate(key, vars, locale);
