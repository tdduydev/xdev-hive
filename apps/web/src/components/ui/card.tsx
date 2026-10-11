import type { ComponentProps } from "react";
import { cx } from "../../lib/cx.ts";

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cx("rounded-xl border border-line bg-surface", className)} {...props} />;
}
