import type { ComponentProps } from "react";
import { cx } from "../../lib/cx.ts";

/**
 * Ô chọn dùng `<select>` gốc như mockup: bàn phím, trình đọc màn hình và bộ chọn trên điện thoại chạy sẵn.
 * `size="sm"` cho ô chọn nằm trong bảng.
 */
export function Select({
  className,
  size = "md",
  ...props
}: Omit<ComponentProps<"select">, "size"> & { size?: "md" | "sm" }) {
  return (
    <select
      className={cx(
        "w-full cursor-pointer rounded-md border border-line-strong bg-surface px-2.5 text-ink",
        "focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-accent",
        "disabled:cursor-not-allowed disabled:opacity-60",
        size === "sm" ? "h-7.5" : "h-9.5",
        className,
      )}
      {...props}
    />
  );
}
