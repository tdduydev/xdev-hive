import { cx } from "@/lib/cx.ts";

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
    <div className={cx("grid min-w-0 gap-1 rounded-xl bg-card px-4 py-3.5 ring-1 ring-foreground/10", className)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {/* Xuống dòng thay vì cắt "…": ô nửa màn điện thoại không đủ chỗ cho "32,76 USD", và title không chạm được. */}
      <span className="font-heading text-stat font-semibold break-words text-foreground tabular-nums">{value}</span>
      {hint && <span className="text-xs break-words text-muted-foreground">{hint}</span>}
    </div>
  );
}
