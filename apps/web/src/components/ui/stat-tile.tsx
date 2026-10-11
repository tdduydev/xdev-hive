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
    <div className={cx("grid min-w-0 gap-0.5 rounded-xl border border-line bg-surface px-4 py-3.5", className)}>
      <span className="text-xs text-muted">{label}</span>
      <span className="truncate font-display text-stat font-semibold text-ink tabular-nums">{value}</span>
      {hint && <span className="truncate text-xs text-muted">{hint}</span>}
    </div>
  );
}
