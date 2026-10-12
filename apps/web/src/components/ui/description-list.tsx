import type { ReactNode } from "react";
import { cx } from "@/lib/cx.ts";

export interface DescriptionItem {
  term: string;
  detail: ReactNode;
  /** Chữ mono cho tên máy, mã, nhánh. */
  mono?: boolean;
}

/** Bảng nhãn–giá trị hai cột trong card chi tiết. `alignEnd` đẩy giá trị sang phải cho cột số. */
export function DescriptionList({ items, alignEnd = false }: { items: DescriptionItem[]; alignEnd?: boolean }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      {items.map((item) => (
        <div key={item.term} className="contents">
          <dt className="text-muted-foreground">{item.term}</dt>
          <dd
            className={cx(
              "min-w-0 break-words text-foreground tabular-nums",
              item.mono && "font-mono text-xs",
              alignEnd && "text-right",
            )}
          >
            {item.detail}
          </dd>
        </div>
      ))}
    </dl>
  );
}
