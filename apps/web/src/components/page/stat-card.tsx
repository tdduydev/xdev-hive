import { Link, type LinkProps } from "@tanstack/react-router";
import { ArrowDownRight, ArrowRight, ArrowUpRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "@/lib/cx.ts";

export type StatTone = "default" | "success" | "warning" | "destructive";

const TONE: Record<StatTone, string> = {
  default: "bg-muted text-muted-foreground",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  destructive: "bg-destructive-soft text-destructive",
};

export interface StatTrend {
  direction: "up" | "down" | "flat";
  /** Chữ đầy đủ, ví dụ "+12% so với tuần trước": màu và mũi tên không đủ để nói tăng là tốt hay xấu. */
  label: string;
  /** Tăng có tốt không. Chi phí tăng là xấu (`false`), số run thành công tăng là tốt. */
  good?: boolean;
}

/**
 * Thẻ số liệu (admin-layout.md § Thẻ số liệu): nhãn, con số lớn mono, một dòng giải thích hoặc xu hướng. Có `to` thì
 * cả thẻ là link sang trang lọc sẵn; `tone` tô biểu tượng, không tô cả thẻ để lưới thẻ vẫn yên.
 */
export function StatCard({
  label,
  value,
  hint,
  icon: IconComponent,
  tone = "default",
  trend,
  to,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
  tone?: StatTone;
  trend?: StatTrend;
  /** Trang lọc sẵn mở khi bấm thẻ. Route có tham số thì để nơi gọi bọc Link riêng. */
  to?: LinkProps["to"];
  className?: string;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
        {IconComponent && (
          <span className={cx("grid size-7 shrink-0 place-items-center rounded-md", TONE[tone])}>
            <IconComponent aria-hidden="true" className="size-4" />
          </span>
        )}
      </div>
      <span className="truncate font-heading text-stat font-semibold text-foreground tabular-nums">{value}</span>
      {trend ? <Trend trend={trend} /> : hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </>
  );
  const frame = cx(
    "grid min-w-0 content-start gap-1 rounded-xl bg-card px-4 py-3.5 ring-1 ring-foreground/10",
    to &&
      "transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    className,
  );
  return to ? (
    <Link to={to} className={frame}>
      {body}
    </Link>
  ) : (
    <div className={frame}>{body}</div>
  );
}

function Trend({ trend }: { trend: StatTrend }) {
  const ArrowIcon = trend.direction === "up" ? ArrowUpRight : trend.direction === "down" ? ArrowDownRight : ArrowRight;
  const color =
    trend.direction === "flat" || trend.good === undefined
      ? "text-muted-foreground"
      : trend.good === (trend.direction === "up")
        ? "text-success"
        : "text-destructive";
  return (
    <span className={cx("flex items-center gap-1 text-xs", color)}>
      <ArrowIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">{trend.label}</span>
    </span>
  );
}

/** Lưới thẻ số liệu: 1 cột ở 360 px, 2 cột từ 640 px, đủ `columns` cột từ 1024 px. */
export function StatGrid({ columns = 4, children }: { columns?: 2 | 3 | 4 | 5; children: ReactNode }) {
  return (
    <div
      className={cx(
        "grid gap-3 sm:grid-cols-2",
        { 2: "", 3: "lg:grid-cols-3", 4: "lg:grid-cols-4", 5: "lg:grid-cols-5" }[columns],
      )}
    >
      {children}
    </div>
  );
}
