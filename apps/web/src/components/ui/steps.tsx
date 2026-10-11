import { cx } from "../../lib/cx.ts";

export type StepStatus = "done" | "current" | "stopped" | "next";

export interface Step {
  label: string;
  status: StepStatus;
  /** Giờ hoặc thời gian đã chạy, hiện mờ sau nhãn. */
  time?: string;
}

const STATUS_TEXT: Record<StepStatus, string> = {
  done: "đã xong",
  current: "đang ở bước này",
  stopped: "dừng ở bước này",
  next: "chưa tới",
};

const STYLE: Record<StepStatus, string> = {
  done: "border-transparent bg-ok-bg text-ok",
  current: "border-sel-line bg-sel font-semibold text-sel-fg",
  stopped: "border-transparent bg-bad-bg font-semibold text-bad",
  next: "border-dashed border-line-strong bg-surface text-muted",
};

/** Các bước nối tiếp nhau (pha của run). Trạng thái từng bước được đọc ra cho trình đọc màn hình, không chỉ bằng màu. */
export function Steps({ label, steps }: { label: string; steps: Step[] }) {
  return (
    <ol aria-label={label} className="flex flex-wrap gap-1.5">
      {steps.map((step) => (
        <li
          key={step.label}
          aria-current={step.status === "current" ? "step" : undefined}
          className={cx(
            "inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 text-label",
            STYLE[step.status],
          )}
        >
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
          {step.label}
          <span className="sr-only">: {STATUS_TEXT[step.status]}</span>
          {step.time && <span className="text-xs text-muted tabular-nums">{step.time}</span>}
        </li>
      ))}
    </ol>
  );
}
