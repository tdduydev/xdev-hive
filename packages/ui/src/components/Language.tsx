import { Languages, Monitor, Moon, Sun } from "lucide-react";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@xdev-hive/ui/components/ui/dropdown-menu";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { isLocale, LOCALES, useI18n, useT } from "#ui/i18n/index.tsx";
import { THEME_PREFS, useTheme, type ThemePref } from "#ui/lib/theme.ts";

const entries = Object.entries(LOCALES) as Array<[keyof typeof LOCALES, (typeof LOCALES)[keyof typeof LOCALES]]>;

/** Compact picker for pages without the account menu (sign-in). */
export function LanguageSelect() {
  const { locale, setLocale } = useI18n();
  const t = useT();
  return (
    <label className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
      <Languages className="size-3.5" aria-hidden="true" />
      <NativeSelect size="sm" value={locale} onChange={(e) => isLocale(e.target.value) && setLocale(e.target.value)} aria-label={t("language.label")}>
        {entries.map(([code, l]) => (
          <NativeSelectOption key={code} value={code}>
            {l.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </label>
  );
}

/** "Language" submenu of the account menu. */
export function LanguageMenu() {
  const { locale, setLocale } = useI18n();
  const t = useT();
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Languages />
        {t("language.label")}
        <span className="ml-auto pl-3 text-xs text-muted-foreground">{LOCALES[locale].name}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup value={locale} onValueChange={(v) => isLocale(v) && setLocale(v)}>
          {entries.map(([code, l]) => (
            <DropdownMenuRadioItem key={code} value={code}>
              {l.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const;

/** "Appearance" submenu of the account menu: light, dark or the OS setting, saved on this device. */
export function ThemeMenu() {
  const { pref, setPref } = useTheme();
  const t = useT();
  const Icon = THEME_ICON[pref];
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Icon />
        {t("theme.label")}
        <span className="ml-auto pl-3 text-xs text-fg-muted">{t(`theme.${pref}`)}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup value={pref} onValueChange={(v) => setPref(v as ThemePref)}>
          {THEME_PREFS.map((p) => (
            <DropdownMenuRadioItem key={p} value={p}>
              {t(`theme.${p}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
