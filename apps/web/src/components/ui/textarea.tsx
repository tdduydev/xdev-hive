import type { ComponentProps } from "react";
import { cx } from "../../lib/cx.ts";

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cx(
        "min-h-19 w-full rounded-md border border-line-strong bg-surface px-2.75 py-2.25 placeholder:text-muted",
        "aria-invalid:border-bad",
        className,
      )}
      {...props}
    />
  );
}
