import { Monitor, Moon, Sun } from "lucide-react";
import { useState } from "react";
import { readTheme, setTheme, type ThemeChoice } from "../lib/theme.ts";
import { cn } from "../lib/utils.ts";

const OPTIONS: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "Theo hệ thống", icon: Monitor },
  { value: "light", label: "Sáng", icon: Sun },
  { value: "dark", label: "Tối", icon: Moon },
];

/** Chọn giao diện sáng, tối hoặc theo hệ điều hành. */
export function ThemeToggle({ className }: { className?: string }) {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  return (
    <fieldset className={cn("m-0 inline-flex min-w-0 rounded-md border border-border p-0.5", className)}>
      <legend className="sr-only">Giao diện</legend>
      {OPTIONS.map(({ value, label, icon: IconComponent }) => (
        <button
          key={value}
          type="button"
          aria-label={label}
          aria-pressed={choice === value}
          title={label}
          onClick={() => {
            setTheme(value);
            setChoice(value);
          }}
          className={cn(
            "inline-flex size-6 cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors",
            "hover:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground",
          )}
        >
          <IconComponent className="size-3.5" aria-hidden="true" />
        </button>
      ))}
    </fieldset>
  );
}
