import { cx } from "../../lib/cx.ts";

export interface FilterChip<K extends string> {
  key: K;
  label: string;
  count?: number | undefined;
}

/**
 * Nhóm nút lọc dạng chip, chọn một. Dùng nút bật/tắt (`aria-pressed`) như thiết kế thay vì tab, vì nội dung bên dưới
 * là cùng một bảng được lọc lại chứ không phải panel khác.
 */
export function FilterChips<K extends string>({
  label,
  chips,
  value,
  onChange,
}: {
  /** Tên nhóm cho trình đọc màn hình, vd. "Lọc theo trạng thái". */
  label: string;
  chips: readonly FilterChip<K>[];
  value: K;
  onChange: (key: K) => void;
}) {
  return (
    <fieldset className="flex min-w-0 flex-wrap gap-1.5">
      <legend className="sr-only">{label}</legend>
      {chips.map((chip) => {
        const on = chip.key === value;
        return (
          <button
            key={chip.key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(chip.key)}
            className={cx(
              "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors",
              on
                ? "border-primary/40 bg-accent text-accent-foreground"
                : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {chip.label}
            {chip.count !== undefined && (
              <span className="rounded-sm bg-foreground/5 px-1 font-mono text-2xs tabular-nums">{chip.count}</span>
            )}
          </button>
        );
      })}
    </fieldset>
  );
}
