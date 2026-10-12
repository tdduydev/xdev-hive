import type { ComponentProps } from "react";
import { cx } from "../../lib/cx.ts";

const tones = {
  neutral: "border-input bg-muted text-muted-foreground",
  ok: "border-transparent bg-success-soft text-success",
  warn: "border-transparent bg-warning-soft text-warning",
  bad: "border-transparent bg-destructive-soft text-destructive",
  sel: "border-transparent bg-accent text-accent-foreground",
};

export interface PillProps extends ComponentProps<"span"> {
  tone?: keyof typeof tones;
  /** Cỡ chữ nhỏ hơn, dùng cho nhãn mốc ở sidebar. */
  small?: boolean;
  /** Chấm tròn trước chữ, cho nhãn trạng thái (bảng việc, run). */
  dot?: boolean;
}

export function Pill({ tone = "neutral", small = false, dot = false, className, children, ...props }: PillProps) {
  return (
    <span
      className={cx(
        "inline-flex h-5.5 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.25 font-medium",
        small ? "text-2xs" : "text-xs",
        tones[tone],
        className,
      )}
      {...props}
    >
      {dot && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />}
      {children}
    </span>
  );
}
