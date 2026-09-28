import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Vars } from "./types.ts";
import { readLocale, writeLocale } from "./storage.ts";
import { activeLocale, setActiveLocale, translate, type Locale, type MessageKey } from "./translate.ts";

export { rich } from "./rich.ts";
export { LOCALES, activeIntl, hasKey, isLocale, translate, type Locale, type MessageKey } from "./translate.ts";

export type TFunction = (key: MessageKey, vars?: Vars) => string;

const I18nContext = createContext<{ locale: Locale; setLocale: (locale: Locale) => void } | null>(null);

/**
 * Holds the interface language for everything under it (web root, desktop root). `onChange` hears the
 * language at start and on every change (the desktop app tells its main process: tray, notifications).
 */
export function I18nProvider({ children, onChange }: { children: ReactNode; onChange?: (locale: Locale) => void }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const initial = readLocale();
    setActiveLocale(initial);
    return initial;
  });
  const setLocale = useCallback((next: Locale) => {
    setActiveLocale(next);
    writeLocale(next);
    setLocaleState(next);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    onChange?.(locale);
  }, [locale, onChange]);
  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): { locale: Locale; setLocale: (locale: Locale) => void } {
  return useContext(I18nContext) ?? { locale: activeLocale(), setLocale: setActiveLocale };
}

/** t("nav.docs"), t("password.tooShort", { min: 10 }). Components that show text call this so they re-render on a language change. */
export function useT(): TFunction {
  const { locale } = useI18n();
  return useMemo<TFunction>(() => (key, vars) => translate(key, vars, locale), [locale]);
}
