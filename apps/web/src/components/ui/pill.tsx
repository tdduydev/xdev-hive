import type { ComponentProps } from "react";
import { cx } from "../../lib/cx.ts";

const tones = {
  neutral: "border-line-strong bg-subtle text-muted",
  ok: "border-transparent bg-ok-bg text-ok",
  warn: "border-transparent bg-warn-bg text-warn",
  bad: "border-transparent bg-bad-bg text-bad",
  sel: "border-transparent bg-sel text-sel-fg",
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
