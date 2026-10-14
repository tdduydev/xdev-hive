import { useNavigate, useSearch } from "@tanstack/react-router";
import type { KnowledgeAuthor, ScopeView } from "@xdev-hive/contracts";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@xdev-hive/ui/dialog";
import { Pill } from "@xdev-hive/ui/pill";
import type { ReactNode } from "react";
import type { ServerPaging } from "@/components/data-table/data-table.tsx";
import { Card } from "@/components/ui/card.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { cx } from "@/lib/cx.ts";
import { formatDay } from "@/lib/format.ts";
import { useLang, useT } from "@/lib/i18n.ts";
import { knowledgeText } from "@/pages/knowledge/text.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const text = knowledgeText;

/** Lớp mỏng cho trang kiến thức không có tab: tiêu đề + mô tả + nút chính, rồi thân trang. */
export function KnowledgeLayout({
  title,
  lead,
  actions,
  children,
}: {
  title: string;
  lead: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <PageHeader title={title} description={lead}>
        {actions}
      </PageHeader>
      <PageBody>{children}</PageBody>
    </>
  );
}

/**
 * Tab của trang nằm ở `?tab=`; tab đầu không có tham số. Các route kiến thức chưa có `validateSearch` riêng nên đọc
 * tham số thô và chỉ nhận giá trị trong `tabs`.
 * TODO(admin-layout): chuyển sang `validateSearch` ở router.tsx / lib/route-search.ts như members và teams.
 */
export function useTabParam<T extends string>(
  tabs: readonly T[],
): readonly [T | undefined, (tab: T | undefined) => void] {
  const search: { tab?: unknown } = useSearch({ strict: false });
  const navigate = useNavigate();
  const current = tabs.find((tab) => tab === search.tab);
  return [
    current,
    // `as never`: route chưa khai báo `tab` nên kiểu của search không nhận, JSON bỏ khoá `undefined` nên tab đầu không có tham số.
    (tab) => void navigate({ to: ".", search: ((prev: object) => ({ ...prev, tab })) as never, replace: true }),
  ] as const;
}

/**
 * Vùng nhỏ bên trong trang (hộp thoại, một khối chi tiết): vòng xoay khi tải, `LoadFailure` khi lỗi. Cả trang hay cả
 * bảng thì truyền `skeleton` để khung giữ chỗ như nội dung.
 */
export function QueryState({
  query,
  skeleton,
}: {
  query: { isPending: boolean; error: unknown; refetch: () => unknown };
  skeleton?: ReactNode;
}) {
  if (query.isPending) return skeleton ?? <LoadingState />;
  if (query.error) return <LoadFailure error={query.error} retry={query.refetch} />;
  return null;
}

/** Khối chi tiết của trang Tài liệu (phần chi tiết dùng chung còn lại; trang khác mở chi tiết bằng `DetailDialog`). */
export function DetailCard({ children, className }: { children: ReactNode; className?: string }) {
  return <Card className={cx("min-w-0 gap-3 border border-border p-4", className)}>{children}</Card>;
}

/**
 * Chi tiết một dòng của danh sách kiến thức, trong hộp thoại cuộn trong thân với nút quyết định luôn thấy.
 * TODO(admin-layout): đề xuất, skill và memory nên có trang riêng (`/knowledge/proposals/$id`…) theo Decision 2; khi
 * router có route đó thì thân của hộp thoại này chuyển nguyên sang `DetailHeader` + `PageBody`.
 */
export function DetailDialog({
  title,
  badges,
  description,
  footer,
  mono = true,
  onClose,
  children,
}: {
  title: string;
  /** Tên skill, đường dẫn tài liệu là mã nên dùng chữ mono; tên thường thì tắt. */
  mono?: boolean;
  /** Hàng huy hiệu (phạm vi, loại, trạng thái) đứng trên tên. */
  badges?: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className={cx(
          "max-h-[90dvh] grid-rows-[auto_minmax(0,1fr)] gap-0 p-0 sm:max-w-2xl lg:max-w-3xl",
          footer ? "grid-rows-[auto_minmax(0,1fr)_auto]" : undefined,
        )}
      >
        <DialogHeader className="gap-1.5 border-b border-border p-4 pr-12">
          {badges && <div className="flex flex-wrap items-center gap-1.5">{badges}</div>}
          <DialogTitle className={cx("text-base leading-snug", mono ? "break-all font-mono" : "break-words")}>
            {title}
          </DialogTitle>
          {description && <DialogDescription className="text-xs">{description}</DialogDescription>}
        </DialogHeader>
        <div className="grid min-h-0 content-start gap-4 overflow-y-auto overscroll-contain p-4">{children}</div>
        {footer && <div className="grid gap-3 border-t border-border bg-muted/50 p-4">{footer}</div>}
      </DialogContent>
    </Dialog>
  );
}

/** Nội dung bảng rỗng: nói cái gì sẽ hiện ở đây; `action` là hành động đầu tiên nếu người xem làm được. Nằm trong khung của bảng nên không tự vẽ viền. */
export function EmptyRows({
  title,
  description,
  action,
}: {
  title: string;
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="grid justify-items-center gap-1 text-center">
      <h2 className="font-medium text-foreground">{title}</h2>
      <p className="max-w-md text-sm text-pretty">{description}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ScopeBadge({ scope }: { scope: ScopeView }) {
  const t = useT(text);
  return (
    <Pill tone={scope.level === "team" ? "ok" : scope.level === "project" ? "neutral" : "sel"}>{t[scope.level]}</Pill>
  );
}

export function authorLabel(author: KnowledgeAuthor) {
  return author.userId ?? (author.runId ? `run ${author.runId}` : "—");
}

/** Ngày của dòng, ngày giờ đầy đủ ở `title`: ISO thô không đọc được. */
export function When({ iso }: { iso: string }) {
  const lang = useLang();
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString(lang)} className="tabular-nums">
      {formatDay(iso)}
    </time>
  );
}

/** Hub phân trang theo `offset` với trang 50 dòng và không trả tổng: còn trang sau khi trang này đầy. */
export const PAGE_SIZE = 50;

export function offsetPaging(
  t: { rows: (from: number, to: number) => string; noRows: string },
  offset: number,
  count: number,
  setOffset: (offset: number) => void,
): ServerPaging {
  return {
    label: count === 0 ? t.noRows : t.rows(offset + 1, offset + count),
    hasPrevious: offset > 0,
    hasNext: count >= PAGE_SIZE,
    onPrevious: () => setOffset(Math.max(0, offset - PAGE_SIZE)),
    onNext: () => setOffset(offset + PAGE_SIZE),
  };
}
