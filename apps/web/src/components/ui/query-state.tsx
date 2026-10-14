import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@xdev-hive/ui/empty";
import { Loader2Icon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { cx } from "@/lib/cx.ts";
import { type Dict, useT } from "@/lib/i18n.ts";

const text: Dict<{ loading: string; retry: string }> = {
  vi: { loading: "Đang tải…", retry: "Tải lại" },
  en: { loading: "Loading…", retry: "Retry" },
};

export function LoadingState({ label }: { label?: string }) {
  const t = useT(text);
  return (
    <p role="status" aria-busy="true" className="flex items-center gap-2 text-muted-foreground">
      <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
      {label ?? t.loading}
    </p>
  );
}

/**
 * Khung xương của bảng khi tải lần đầu: giữ đúng chỗ của thanh lọc, đầu bảng và vài dòng để trang không nhảy khi dữ
 * liệu về. Có chữ ẩn cho trình đọc màn hình vì thanh xám không nói gì.
 */
export function TableSkeleton({ rows = 5, columns = 5, label }: { rows?: number; columns?: number; label?: string }) {
  const t = useT(text);
  return (
    <div role="status" aria-busy="true" className="grid gap-2.5">
      <span className="sr-only">{label ?? t.loading}</span>
      <div className="flex gap-2" aria-hidden="true">
        <Skeleton className="h-8 w-full sm:w-64" />
        <Skeleton className="hidden h-8 w-24 sm:block" />
        <Skeleton className="hidden h-8 w-24 sm:block" />
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-card" aria-hidden="true">
        <div className="flex gap-4 border-b border-border bg-muted/40 px-3 py-3">
          {Array.from({ length: columns }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: ô giữ chỗ không có danh tính riêng.
            <Skeleton key={i} className="h-3 flex-1" />
          ))}
        </div>
        {Array.from({ length: rows }, (_, r) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: dòng giữ chỗ không có danh tính riêng.
          <div key={r} className="flex gap-4 border-b border-border px-3 py-3.5 last:border-b-0">
            {Array.from({ length: columns }, (_, c) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: ô giữ chỗ không có danh tính riêng.
              <Skeleton key={c} className={cx("h-4 flex-1", c === 0 && "flex-[2]")} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Khung xương của trang cài đặt/chi tiết: vài khối card cao vừa phải. */
export function SectionsSkeleton({ sections = 3, label }: { sections?: number; label?: string }) {
  const t = useT(text);
  return (
    <div role="status" aria-busy="true" className="grid gap-4">
      <span className="sr-only">{label ?? t.loading}</span>
      {Array.from({ length: sections }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: khối giữ chỗ không có danh tính riêng.
        <div key={i} aria-hidden="true" className="grid gap-3 rounded-xl border border-border bg-card p-5">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-80 max-w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-2/3" />
        </div>
      ))}
    </div>
  );
}

export function LoadFailure({ error, retry }: { error: unknown; retry: () => unknown }) {
  const t = useT(text);
  return (
    <Alert variant="destructive" className="grid justify-items-start gap-2">
      {apiErrorMessage(error)}
      <Button variant="outline" size="sm" onClick={() => retry()}>
        {t.retry}
      </Button>
    </Alert>
  );
}

/**
 * Trạng thái rỗng (admin-layout.md § Trạng thái): nói cái gì sẽ hiện ở đây và đưa hành động đầu tiên. `compact` cho
 * chỗ hẹp như trong card hay tab phụ.
 */
export function EmptyState({
  title,
  description,
  icon: IconComponent,
  action,
  compact = false,
  className,
}: {
  title: string;
  description: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <Empty className={cx("border border-dashed border-border", compact ? "gap-3 p-5" : "py-10", className)}>
      <EmptyHeader>
        {IconComponent && (
          <EmptyMedia variant="icon">
            <IconComponent aria-hidden="true" />
          </EmptyMedia>
        )}
        <EmptyTitle role="heading" aria-level={2}>
          {title}
        </EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}
