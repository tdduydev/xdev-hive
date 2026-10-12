import type { ReactNode } from "react";
import { type Dict, setLang, useLang, useT } from "../../lib/i18n.ts";
import { Brand } from "../icons.tsx";
import { Button } from "../ui/button.tsx";

const text: Dict<{ language: string }> = { vi: { language: "Ngôn ngữ" }, en: { language: "Language" } };

export function OutsideLayout({
  children,
  header,
  centered = false,
}: {
  children: ReactNode;
  header?: ReactNode;
  centered?: boolean;
}) {
  const t = useT(text);
  const lang = useLang();
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground bg-[radial-gradient(var(--border)_1px,transparent_1px)] bg-size-[20px_20px]">
      <header
        className={`flex min-h-14 items-center gap-2 px-4 py-2 sm:px-6 ${header ? "border-b border-border bg-background" : ""}`}
      >
        {header && <Brand className="h-9.5" />}
        <fieldset aria-label={t.language} className="ml-auto flex rounded-lg bg-muted p-0.5">
          {(["vi", "en"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant="ghost"
              aria-pressed={lang === value}
              onClick={() => setLang(value)}
              className={lang === value ? "bg-card font-mono shadow-sm" : "font-mono text-muted-foreground"}
            >
              {value.toUpperCase()}
            </Button>
          ))}
        </fieldset>
        {header}
      </header>
      <main
        className={`flex flex-1 justify-center px-4 ${centered ? "items-center pt-6 pb-24" : "items-start py-10 sm:py-14"}`}
      >
        {children}
      </main>
    </div>
  );
}
