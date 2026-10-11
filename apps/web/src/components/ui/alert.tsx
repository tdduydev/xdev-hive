import type { ComponentProps } from "react";
import { cx } from "../../lib/cx.ts";

/** Báo lỗi của một thao tác. `role="alert"` để trình đọc màn hình đọc ngay khi hiện. */
export function Alert({ className, ...props }: ComponentProps<"div">) {
  return (
    <div role="alert" className={cx("rounded-lg bg-bad-bg px-3.5 py-2.5 text-label text-bad", className)} {...props} />
  );
}
