import { type Dict, type Lang, setLang, useLang, useT } from "../lib/i18n.ts";
import { cn } from "../lib/utils.ts";

const text: Dict<{ group: string }> = { vi: { group: "Ngôn ngữ" }, en: { group: "Language" } };

/** Chọn ngôn ngữ giao diện VI/EN như Topbar.dc.html. */
export function LangToggle({ className }: { className?: string }) {
  const lang = useLang();
  const t = useT(text);
  return (
    <fieldset className={cn("m-0 inline-flex min-w-0 rounded-md bg-muted p-0.5", className)}>
      <legend className="sr-only">{t.group}</legend>
      {(["vi", "en"] as const satisfies readonly Lang[]).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={lang === value}
          onClick={() => setLang(value)}
          className={cn(
            "h-6 min-w-8 cursor-pointer rounded-sm px-1.5 font-mono text-xs font-medium text-muted-foreground",
            "aria-pressed:bg-card aria-pressed:font-semibold aria-pressed:text-foreground aria-pressed:shadow-sm",
          )}
        >
          {value.toUpperCase()}
        </button>
      ))}
    </fieldset>
  );
}
