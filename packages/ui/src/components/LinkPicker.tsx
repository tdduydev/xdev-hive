// Pick a page to link to (roadmap 22j): this space's pages first, then the team's (Chung). Used by both editors.
import { useMemo, useState } from "react";
import { FileText } from "lucide-react";
import { cn } from "cn";
import { keyPrefix } from "@xdev-hive/core";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { useT } from "#ui/i18n/index.tsx";
import { fold } from "#ui/lib/text.ts";

/** Pick a page to link to: this space's first, then the team's (Chung); inserts [[slug]] or [[key]]. */
export function LinkPicker({ from, titles, onPick, onClose }: { from: string; titles: ReadonlyMap<string, string>; onPick: (target: string) => void; onClose: () => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const own = keyPrefix(from);
  const needle = fold(q.trim());
  const rows = useMemo(
    () =>
      [...titles.entries()]
        .filter(([k]) => k !== from && !k.includes("/skills/") && (k.startsWith(own) || k.startsWith("org/")))
        .filter(([k, title]) => !needle || fold(`${title} ${k}`).includes(needle))
        .sort((a, b) => Number(!a[0].startsWith(own)) - Number(!b[0].startsWith(own)) || a[1].localeCompare(b[1]))
        .slice(0, 40),
    [titles, from, own, needle],
  );
  const target = (k: string) => (k.startsWith(own) ? k.slice(own.length) : k);
  return (
    <div className="absolute top-full left-3 z-20 mt-1 flex w-[min(420px,calc(100%-24px))] flex-col gap-1 rounded-lg border border-line-default bg-raised p-2 shadow-e3">
      <Input
        autoFocus
        className="h-8 text-[13px]"
        value={q}
        placeholder={t("docs.linkSearch")}
        aria-label={t("docs.linkSearch")}
        onChange={(e) => {
          setQ(e.target.value);
          setAt(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "ArrowDown") setAt((i) => Math.min(rows.length - 1, i + 1));
          if (e.key === "ArrowUp") setAt((i) => Math.max(0, i - 1));
          if (e.key === "Enter" && rows[at]) onPick(target(rows[at]![0]));
        }}
      />
      <div role="listbox" aria-label={t("docs.linkSearch")} className="flex max-h-64 flex-col overflow-y-auto">
        {rows.map(([k, title], i) => (
          <button
            key={k}
            type="button"
            role="option"
            aria-selected={i === at}
            onMouseEnter={() => setAt(i)}
            onClick={() => onPick(target(k))}
            className={cn("flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left outline-none", i === at && "bg-hover")}
          >
            <FileText className="size-3.5 shrink-0 text-fg-muted" />
            <span className="min-w-0 flex-1 truncate text-[13px] text-fg-strong">{title}</span>
            <span className="shrink-0 font-mono text-[11px] text-fg-muted">{k.startsWith(own) ? target(k) : k}</span>
          </button>
        ))}
        {!rows.length ? <span className="px-2 py-3 text-center text-xs text-fg-muted">{t("docs.noMatch")}</span> : null}
      </div>
      <span className="px-1 text-[11px]/4 text-fg-muted">{t("docs.linkHint")}</span>
    </div>
  );
}
