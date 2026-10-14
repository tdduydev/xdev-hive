import { type QueryKey, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, type LinkProps } from "@tanstack/react-router";
import type { KnowledgeAuthor, ScopeView } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@xdev-hive/ui/dialog";
import { Pill } from "@xdev-hive/ui/pill";
import type { ReactNode } from "react";
import type { ServerPaging } from "@/components/data-table/data-table.tsx";
import { Card } from "@/components/ui/card.tsx";
import { LoadFailure, LoadingState, SectionsSkeleton } from "@/components/ui/query-state.tsx";
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

/** Số dòng mỗi lần đọc khi tìm một dòng theo id: giới hạn trên của danh sách ở hub. */
const SCAN_PAGE = 200;

/**
 * Hub chưa có lời gọi đọc một đề xuất hay một memory theo id. Đi từ bảng sang thì dòng đã nằm trong cache của danh
 * sách nên trang hiện ngay; link dán tay thì đọc lần lượt từng trang (mỗi nguồn một trạng thái) tới khi gặp. `null` là
 * không có, hoặc người xem không thấy được.
 */
export function useRowById<Row extends { id: string }>(
  listKey: QueryKey,
  id: string,
  sources: readonly ((page: { offset: number; limit: number }) => Promise<Row[]>)[],
) {
  const cache = useQueryClient();
  return useQuery({
    queryKey: [...listKey, "by-id", id],
    queryFn: async () => {
      for (const source of sources) {
        for (let offset = 0; offset <= 100_000; offset += SCAN_PAGE) {
          const rows = await source({ offset, limit: SCAN_PAGE });
          const row = rows.find((item) => item.id === id);
          if (row) return row;
          if (rows.length < SCAN_PAGE) break;
        }
      }
      return null;
    },
    initialData: () => {
      for (const [, data] of cache.getQueriesData<unknown>({ queryKey: listKey })) {
        const row = Array.isArray(data) ? (data as Row[]).find((item) => item?.id === id) : undefined;
        if (row) return row;
      }
      return undefined;
    },
  });
}

/** Trang chi tiết khi chưa có dòng: khung chờ, lỗi tải, hoặc không tìm thấy kèm link về danh sách. */
export function DetailFallback({
  query,
  title,
  back,
}: {
  query: { isPending: boolean; error: unknown; refetch: () => unknown };
  title: string;
  back: NonNullable<LinkProps["to"]>;
}) {
  const t = useT(text);
  return (
    <>
      <PageHeader title={title} width="wide" />
      <PageBody width="wide">
        {query.isPending ? (
          <SectionsSkeleton label={t.loading} />
        ) : query.error ? (
          <LoadFailure error={query.error} retry={query.refetch} />
        ) : (
          <>
            <Alert variant="destructive">{t.notFound}</Alert>
            <Link to={back} className="w-fit text-primary hover:text-primary/90">
              {t.backToList}
            </Link>
          </>
        )}
      </PageBody>
    </>
  );
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

/** Khối chi tiết của trang Tài liệu. */
export function DetailCard({ children, className }: { children: ReactNode; className?: string }) {
  return <Card className={cx("min-w-0 gap-3 border border-border p-4", className)}>{children}</Card>;
}

/**
 * Chi tiết một dòng không có trang riêng (skill mặc định, đề xuất học được của agent), trong hộp thoại cuộn trong thân
 * với nút quyết định luôn thấy. Đề xuất, skill và memory có trang riêng (Decision 2).
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
