import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { DocEditorProvider, ReviewPane, SlaBadge, useReviewFormat } from "@xdev-hive/doc-editor";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Table, TableBody, TableHeader, TableRow, Td, Th } from "@xdev-hive/ui/table";
import { ArrowLeftIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { api, queryClient, useDesktopDocEnv } from "@/lib/hub-query.tsx";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { screenParam } from "@/lib/nav.ts";
import { errorText } from "@/lib/tauri.ts";

const text: Dict<{
  lead: string;
  loading: string;
  empty: string;
  colDoc: string;
  colGate: string;
  colSla: string;
  colUpdated: string;
  open: (title: string) => string;
  back: string;
}> = {
  vi: {
    lead: "Tài liệu đang chờ bạn duyệt ở checkpoint hiện tại. Mở một tài liệu để xem thay đổi, checklist và quyết định.",
    loading: "Đang tải…",
    empty: "Không có tài liệu nào chờ bạn duyệt.",
    colDoc: "Tài liệu",
    colGate: "Checkpoint",
    colSla: "SLA",
    colUpdated: "Cập nhật",
    open: (title) => `Duyệt ${title}`,
    back: "Chờ tôi duyệt",
  },
  en: {
    lead: "Docs waiting for your review at their current checkpoint. Open one to see changes, checklist and decide.",
    loading: "Loading…",
    empty: "Nothing is waiting for your review.",
    colDoc: "Doc",
    colGate: "Checkpoint",
    colSla: "SLA",
    colUpdated: "Updated",
    open: (title) => `Review ${title}`,
    back: "Awaiting my review",
  },
};

const go = (id?: string) => {
  location.hash = id ? `#/reviews/${encodeURIComponent(id)}` : "#/reviews";
};

function subscribe(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

/** Đồng hồ cho SLA: một phút cập nhật một lần là đủ cho "còn 3 giờ". */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * Màn Chờ tôi duyệt (spec 008 US11, FR-024): phiên duyệt đang chờ người gọi (`reviews.list` phạm vi `mine`), và
 * `#/reviews/<id>` mở khung duyệt dùng chung với web (packages/doc-editor `ReviewPane`): thay đổi, checklist, duyệt hoặc
 * trả lại kèm góp ý và hướng trả lại. Hub ghi quyết định và báo người viết như khi duyệt trên web.
 */
export function ReviewsScreen() {
  const id = useSyncExternalStore(subscribe, () => screenParam(location.hash));
  const now = useNow();
  return (
    <QueryClientProvider client={queryClient}>
      <DocEditorProvider env={useDesktopDocEnv()}>
        {id ? <ReviewDetail key={id} id={id} now={now} /> : <ReviewQueue now={now} />}
      </DocEditorProvider>
    </QueryClientProvider>
  );
}

function ReviewQueue({ now }: { now: number }) {
  const t = useT(text);
  const fmt = useReviewFormat(useLang());
  const list = useQuery({
    ...api.reviews.list.queryOptions({ input: { scope: "mine", limit: 100 } }),
    refetchInterval: 60_000,
  });
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <p className="text-[13px] text-muted-foreground">{t.lead}</p>
      {list.error && <Alert variant="destructive">{errorText(list.error)}</Alert>}
      <div className="overflow-hidden rounded-xl border bg-card text-card-foreground">
        {!list.data ? (
          <p className="px-4 py-3 text-[13px] text-muted-foreground">{list.error ? "—" : t.loading}</p>
        ) : list.data.items.length === 0 ? (
          <p className="px-4 py-3 text-[13px] text-muted-foreground">{t.empty}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <Th>{t.colDoc}</Th>
                <Th>{t.colGate}</Th>
                <Th>{t.colSla}</Th>
                <Th>{t.colUpdated}</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.items.map((row) => (
                <TableRow key={row.id}>
                  <Td className="max-w-96">
                    <button
                      type="button"
                      aria-label={t.open(row.docTitle)}
                      className="flex w-full min-w-0 cursor-pointer flex-col text-left"
                      onClick={() => go(row.id)}
                    >
                      <span className="truncate text-[13px] font-medium">{row.docTitle}</span>
                      <span className="truncate font-mono text-xs text-muted-foreground">{row.docKey}</span>
                    </button>
                  </Td>
                  <Td className="text-[13px]">
                    {row.gate ? (
                      <span className="flex flex-col">
                        <span>{row.gate.name}</span>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {row.gate.index + 1}/{row.gate.total} · {row.workflowName}
                        </span>
                      </span>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td>
                    <SlaBadge gate={row.gate} now={now} />
                  </Td>
                  <Td className="text-xs whitespace-nowrap text-muted-foreground">{fmt.ago(row.updatedAt, now)}</Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

function ReviewDetail({ id, now }: { id: string; now: number }) {
  const t = useT(text);
  return (
    <div className="flex w-full flex-col gap-4">
      <div>
        <Button variant="ghost" size="sm" onClick={() => go()}>
          <ArrowLeftIcon aria-hidden="true" />
          {t.back}
        </Button>
      </div>
      {/* ReviewPane tự làm mới hàng chờ sau khi quyết; khung vẫn mở để người duyệt thấy kết quả. */}
      <ReviewPane id={id} now={now} onDecided={() => undefined} />
    </div>
  );
}
