// One strip of at most 4 numbers at the top of a dashboard page; each number links to the list it counts
// (docs/design/dashboard-2026-10.md §8). Only an abnormal number gets a tone, so a calm page stays calm.
import type { ReactNode } from "react";
import { cn } from "cn";
import { capSummary } from "#ui/lib/summary.ts";

export interface SummaryItem {
  id: string;
  label: string;
  value: ReactNode;
  sub?: string;
  /** Where the number leads: the page or filter that lists what it counts. */
  href: string;
  /** Set only when the number is abnormal. */
  tone?: "warning" | "danger";
}

const TONE = { warning: "text-warning", danger: "text-danger" };

export function SummaryStrip({ items, label }: { items: SummaryItem[]; label: string }) {
  const shown = capSummary(items);
  return (
    <nav aria-label={label} className="grid grid-cols-2 gap-2 md:grid-cols-[repeat(auto-fit,minmax(0,1fr))]">
      {shown.map((i) => (
        <a
          key={i.id}
          href={i.href}
          data-summary={i.id}
          className="flex min-w-0 flex-col gap-1 rounded-xl border border-line-default bg-surface px-3.5 py-3 outline-none hover:border-fg-secondary focus-visible:focus-ring max-md:min-h-11"
        >
          <span className="text-xs text-fg-muted">{i.label}</span>
          <span className={cn("text-[26px]/8 font-bold tabular-nums", i.tone ? TONE[i.tone] : "text-fg-strong")}>{i.value}</span>
          {i.sub ? <span className="truncate text-xs text-fg-muted">{i.sub}</span> : null}
        </a>
      ))}
    </nav>
  );
}
