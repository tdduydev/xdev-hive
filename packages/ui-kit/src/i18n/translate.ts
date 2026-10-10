// Interface languages. vi is the source catalogue: its keys are the keys of every language, and
// TypeScript makes each locale translate all of them.
//
// Adding a language: copy locales/en.ts to locales/<code>.ts, translate the strings, and add one line
// to LOCALES below. Plural strings are { one, other } (add zero/two/few/many if the language uses them).
import type { Leaf, Plural, Vars } from "./types.ts";
import { en } from "./locales/en.ts";
import { vi, type Catalog, type MessageKey } from "./locales/vi.ts";

export type { MessageKey } from "./locales/vi.ts";

export const LOCALES = {
  vi: { name: "Tiếng Việt", intl: "vi-VN", messages: vi },
  en: { name: "English", intl: "en-US", messages: en },
} satisfies Record<string, { name: string; intl: string; messages: Catalog }>;

export type Locale = keyof typeof LOCALES;
export const DEFAULT_LOCALE: Locale = "vi";

export const isLocale = (v: unknown): v is Locale => typeof v === "string" && Object.hasOwn(LOCALES, v);

let active: Locale = DEFAULT_LOCALE;

export const activeLocale = (): Locale => active;
export const activeIntl = (): string => LOCALES[active].intl;
export function setActiveLocale(locale: Locale): void {
  active = locale;
}

function lookup(messages: Catalog, key: string): Leaf | undefined {
  let node: unknown = messages;
  for (const part of key.split(".")) node = (node as Record<string, unknown> | undefined)?.[part];
  return typeof node === "string" || (typeof node === "object" && node !== null && "other" in node) ? (node as Leaf) : undefined;
}

/** Is this a key of the catalogue? For keys that come from elsewhere (error answers of the hub). */
export const hasKey = (key: string): boolean => lookup(vi, key) !== undefined;

/** The text for a key in a locale (default: the active one); falls back to vi, then to the key itself. */
export function translate(key: MessageKey, vars?: Vars, locale: Locale = active): string {
  const leaf = lookup(LOCALES[locale].messages, key) ?? lookup(vi, key);
  if (leaf === undefined) return key;
  const text =
    typeof leaf === "string"
      ? leaf
      : ((leaf as Plural)[new Intl.PluralRules(LOCALES[locale].intl).select(Number(vars?.count ?? 0))] ?? leaf.other);
  return vars ? text.replace(/\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : match)) : text;
}
