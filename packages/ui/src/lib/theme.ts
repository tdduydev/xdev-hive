import { useCallback, useEffect, useSyncExternalStore } from "react";

/** Light, dark, or whatever the OS uses. The choice is per device (localStorage), like the language. */
export type ThemePref = "system" | "light" | "dark";
export const THEME_PREFS: readonly ThemePref[] = ["system", "light", "dark"];

const KEY = "hive-theme";
const listeners = new Set<() => void>();

function darkQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
}

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // Storage blocked: follow the OS.
  }
  return "system";
}

export function resolveTheme(pref: ThemePref, osDark: boolean): "light" | "dark" {
  return pref === "system" ? (osDark ? "dark" : "light") : pref;
}

/** The design's tokens key off data-theme on <html>; color-scheme makes native controls and scrollbars follow. */
function apply(): void {
  if (typeof document === "undefined") return;
  const theme = resolveTheme(readThemePref(), darkQuery()?.matches ?? false);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

export function setThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    // Not saved; still applied for this session.
  }
  apply();
  for (const l of listeners) l();
}

// Applied as soon as the UI package loads, so the first paint already has the right theme.
apply();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Keeps <html> in step with the saved choice and the OS setting; returns the choice and a setter. */
export function useTheme(): { pref: ThemePref; theme: "light" | "dark"; setPref: (p: ThemePref) => void } {
  const pref = useSyncExternalStore(subscribe, readThemePref, () => "system" as ThemePref);
  const osDark = useSyncExternalStore(
    (cb) => {
      const mq = darkQuery();
      mq?.addEventListener("change", cb);
      return () => mq?.removeEventListener("change", cb);
    },
    () => darkQuery()?.matches ?? false,
    () => false,
  );
  useEffect(apply, [pref, osDark]);
  const setPref = useCallback((p: ThemePref) => setThemePref(p), []);
  return { pref, theme: resolveTheme(pref, osDark), setPref };
}

/** Flips between light and dark (leaving "system" for an explicit choice). */
export function toggleTheme(current: "light" | "dark"): void {
  setThemePref(current === "dark" ? "light" : "dark");
}

/** Kept for the screens that only need <html> to follow the theme. */
export function useSystemTheme(): void {
  useTheme();
}
