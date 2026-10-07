// "Cần chú ý" for the page's own scope: a level, one sentence and the button, on the same row
// (docs/design/dashboard-2026-10.md §8). It only draws; the items come from the inbox, alerts or hub.info.
import type { ReactNode } from "react";
import { sortAttention } from "#ui/lib/summary.ts";
import { Chip, type ChipKind } from "#ui/components/panes.tsx";

export interface AttentionItem {
  id: string;
  level: "danger" | "warning" | "info";
  levelLabel: string;
  text: ReactNode;
  action?: ReactNode;
}

const KIND: Record<AttentionItem["level"], ChipKind> = { danger: "danger", warning: "warning", info: "info" };

export function AttentionList({ items, label }: { items: AttentionItem[]; label: string }) {
  if (items.length === 0) return null;
  return (
    <ul aria-label={label} className="m-0 flex list-none flex-col gap-1 p-0">
      {sortAttention(items).map((i) => (
        <li key={i.id} data-attention={i.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line-default bg-surface px-3 py-2">
          <Chip kind={KIND[i.level]}>{i.levelLabel}</Chip>
          <span className="min-w-0 flex-1 text-[13px]/5 text-fg-strong [overflow-wrap:anywhere]">{i.text}</span>
          {i.action}
        </li>
      ))}
    </ul>
  );
}
