import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { BellIcon } from "lucide-react";
import { useState } from "react";
import { SegmentedControl } from "@/components/page/segmented-control.tsx";
import { EmptyState, LoadFailure, SectionsSkeleton } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { formatDay } from "@/lib/format.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { externalUrl } from "@/lib/merge-queue.ts";
import { useOrg } from "@/shell/org-context.ts";

const text: Dict<{
  region: string;
  filter: string;
  all: string;
  unreadOnly: string;
  unreadCount: (n: number) => string;
  markAll: string;
  markOne: string;
  markOneFor: (title: string) => string;
  read: string;
  unread: string;
  openDetail: string;
  newTabSr: string;
  loading: string;
  emptyUnread: string;
  empty: string;
  emptyHint: string;
  loadMore: string;
  loadingMore: string;
}> = {
  vi: {
    region: "Hộp thư cá nhân",
    filter: "Lọc thông báo",
    all: "Tất cả",
    unreadOnly: "Chưa đọc",
    unreadCount: (n) => `${n} chưa đọc`,
    markAll: "Đánh dấu tất cả đã đọc",
    markOne: "Đánh dấu đã đọc",
    markOneFor: (title) => `Đánh dấu đã đọc: ${title}`,
    read: "Đã đọc",
    unread: "Chưa đọc",
    openDetail: "Mở chi tiết",
    newTabSr: "(mở tab mới)",
    loading: "Đang tải thông báo…",
    emptyUnread: "Không có thông báo chưa đọc",
    empty: "Chưa có thông báo",
    emptyHint: "Thông báo dành cho bạn trong tổ chức này sẽ xuất hiện ở đây.",
    loadMore: "Tải thêm thông báo",
    loadingMore: "Đang tải thêm…",
  },
  en: {
    region: "Personal inbox",
    filter: "Filter notifications",
    all: "All",
    unreadOnly: "Unread",
    unreadCount: (n) => `${n} unread`,
    markAll: "Mark all as read",
    markOne: "Mark as read",
    markOneFor: (title) => `Mark as read: ${title}`,
    read: "Read",
    unread: "Unread",
    openDetail: "Open details",
    newTabSr: "(opens in a new tab)",
    loading: "Loading notifications…",
    emptyUnread: "No unread notifications",
    empty: "No notifications yet",
    emptyHint: "Notifications for you in this organization will appear here.",
    loadMore: "Load more notifications",
    loadingMore: "Loading more…",
  },
};

export function Inbox() {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const count = useQuery(api.inbox.unreadCount.queryOptions({ refetchInterval: 30_000 }));
  const inbox = useInfiniteQuery(
    api.inbox.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ cursor, limit: 30, unreadOnly }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      refetchInterval: 30_000,
    }),
  );
  const read = useMutation({
    mutationFn: (ids: string[] | undefined) => (ids ? api.inbox.markRead.call({ ids }) : api.inbox.markAllRead.call()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: api.inbox.key() }),
  });
  const items = inbox.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section aria-label={t.region} className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <SegmentedControl
          label={t.filter}
          value={unreadOnly ? "unread" : "all"}
          onChange={(value) => setUnreadOnly(value === "unread")}
          options={[
            { value: "all", label: t.all },
            { value: "unread", label: t.unreadOnly },
          ]}
        />
        {count.data && <span className="text-xs text-muted-foreground">{t.unreadCount(count.data.count)}</span>}
        <Button
          variant="outline"
          className="sm:ml-auto"
          disabled={read.isPending || !count.data?.count}
          onClick={() => read.mutate(undefined)}
        >
          {t.markAll}
        </Button>
      </div>
      {count.isError && <LoadFailure error={count.error} retry={count.refetch} />}
      {read.isError && <Alert variant="destructive">{apiErrorMessage(read.error)}</Alert>}
      {inbox.isPending ? (
        <SectionsSkeleton sections={2} label={t.loading} />
      ) : inbox.isError && !inbox.data ? (
        <LoadFailure error={inbox.error} retry={inbox.refetch} />
      ) : items.length === 0 ? (
        <EmptyState icon={BellIcon} title={unreadOnly ? t.emptyUnread : t.empty} description={t.emptyHint} />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {items.map((item) => {
            const url = externalUrl(item.link);
            return (
              <li
                key={item.id}
                className={`grid min-w-0 gap-3 border-l-2 p-4 sm:grid-cols-[minmax(0,1fr)_auto] ${item.readAt ? "border-l-transparent" : "border-l-primary bg-accent/40"}`}
              >
                <div className="grid min-w-0 gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="break-words font-semibold text-foreground">{item.title}</h3>
                    <Pill tone={item.readAt ? "neutral" : "sel"}>{item.readAt ? t.read : t.unread}</Pill>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-muted-foreground">{item.body}</p>
                  <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                    <time dateTime={item.createdAt}>{formatDay(item.createdAt)}</time>
                    {url && (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary underline underline-offset-2"
                      >
                        {t.openDetail}
                        <span className="sr-only"> {t.newTabSr}</span>
                      </a>
                    )}
                  </div>
                </div>
                {!item.readAt && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="self-start"
                    disabled={read.isPending}
                    onClick={() => read.mutate([item.id])}
                    aria-label={t.markOneFor(item.title)}
                  >
                    {t.markOne}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {inbox.isError && inbox.data && (
        <LoadFailure
          error={inbox.error}
          retry={() => (inbox.isFetchNextPageError ? inbox.fetchNextPage() : inbox.refetch())}
        />
      )}
      {inbox.hasNextPage && (
        <Button variant="outline" disabled={inbox.isFetching} onClick={() => inbox.fetchNextPage()}>
          {inbox.isFetchingNextPage ? t.loadingMore : t.loadMore}
        </Button>
      )}
    </section>
  );
}
