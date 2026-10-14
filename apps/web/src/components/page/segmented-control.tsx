import { cx } from "@/lib/cx.ts";

export interface SegmentOption<V extends string> {
  value: V;
  label: string;
  disabled?: boolean;
}

/**
 * Chọn một trong vài lựa chọn ngắn đứng cạnh nhau (khoảng thời gian, loại quy trình, nhóm theo). Nút bật/tắt có
 * `aria-pressed` thay vì radio vì mỗi nút đổi ngay dữ liệu đang xem, không phải ô của form chờ lưu; mục đang chọn
 * có nền và chữ đậm để không phải nhìn màu mới biết.
 */
export function SegmentedControl<V extends string>({
  label,
  value,
  onChange,
  options,
  size = "default",
}: {
  label: string;
  value: V;
  onChange: (value: V) => void;
  options: readonly SegmentOption<V>[];
  size?: "default" | "sm";
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: nhóm nút bật/tắt, không phải ô form nên không dùng fieldset.
    <div
      role="group"
      aria-label={label}
      className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-lg border border-border bg-muted/50 p-0.5"
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={on}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={cx(
              "shrink-0 cursor-pointer rounded-md px-2.5 whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
              size === "sm" ? "h-6 text-xs" : "h-7 text-sm",
              on
                ? "bg-background font-medium text-foreground shadow-sm ring-1 ring-foreground/10"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
