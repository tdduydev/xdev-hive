import { cx } from "../../lib/cx.ts";

/** Ô số liệu đầu trang: nhãn, con số lớn, một dòng giải thích. */
export function StatTile({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: string;
  hint?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <div className={cx("grid min-w-0 gap-0.5 rounded-xl border border-border bg-card px-4 py-3.5", className)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate font-heading text-stat font-semibold text-foreground tabular-nums">{value}</span>
      {hint && <span className="truncate text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}
