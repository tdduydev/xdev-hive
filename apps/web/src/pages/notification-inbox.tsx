import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert } from "../components/ui/alert.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { Pill } from "../components/ui/pill.tsx";
import { EmptyState, LoadFailure, LoadingState } from "../components/ui/query-state.tsx";
import { apiErrorMessage } from "../lib/api-errors.ts";
import { formatDay } from "../lib/format.ts";
import { externalUrl } from "../lib/merge-queue.ts";
import { useOrg } from "../shell/org-context.ts";

export function Inbox() {
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
    <section aria-label="Hộp thư cá nhân" className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-foreground">
          Hộp thư cá nhân {count.data && <Pill>{count.data.count} chưa đọc</Pill>}
        </h2>
        <Button
          variant="outline"
          disabled={read.isPending || !count.data?.count}
          onClick={() => read.mutate(undefined)}
        >
          Đánh dấu tất cả đã đọc
        </Button>
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)} />
        Chỉ hiện chưa đọc
      </label>
      {count.isError && <LoadFailure error={count.error} retry={count.refetch} />}
      {read.isError && <Alert>{apiErrorMessage(read.error)}</Alert>}
      {inbox.isPending ? (
        <LoadingState label="Đang tải thông báo…" />
      ) : inbox.isError && !inbox.data ? (
        <LoadFailure error={inbox.error} retry={inbox.refetch} />
      ) : items.length === 0 ? (
        <EmptyState
          title={unreadOnly ? "Không có thông báo chưa đọc" : "Chưa có thông báo"}
          description="Thông báo dành cho bạn trong tổ chức này sẽ xuất hiện ở đây."
        />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-border">
            {items.map((item) => {
              const url = externalUrl(item.link);
              return (
                <li
                  key={item.id}
                  className={`grid min-w-0 gap-3 p-4 app:grid-cols-[minmax(0,1fr)_auto] ${item.readAt ? "" : "bg-accent"}`}
                >
                  <div className="grid min-w-0 gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="break-words font-semibold text-foreground">{item.title}</h3>
                      <Pill tone={item.readAt ? "neutral" : "sel"}>{item.readAt ? "Đã đọc" : "Chưa đọc"}</Pill>
                    </div>
                    <p className="whitespace-pre-wrap break-words">{item.body}</p>
                    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                      <time dateTime={item.createdAt}>{formatDay(item.createdAt)}</time>
                      {url && (
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary underline underline-offset-2"
                        >
                          Mở chi tiết<span className="sr-only"> (mở tab mới)</span>
                        </a>
                      )}
                    </div>
                  </div>
                  {!item.readAt && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={read.isPending}
                      onClick={() => read.mutate([item.id])}
                      aria-label={`Đánh dấu đã đọc: ${item.title}`}
                    >
                      Đánh dấu đã đọc
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {inbox.isError && inbox.data && (
        <LoadFailure
          error={inbox.error}
          retry={() => (inbox.isFetchNextPageError ? inbox.fetchNextPage() : inbox.refetch())}
        />
      )}
      {inbox.hasNextPage && (
        <Button variant="outline" disabled={inbox.isFetching} onClick={() => inbox.fetchNextPage()}>
          {inbox.isFetchingNextPage ? "Đang tải thêm…" : "Tải thêm thông báo"}
        </Button>
      )}
    </section>
  );
}
