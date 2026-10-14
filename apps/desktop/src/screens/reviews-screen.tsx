import { QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type CodeReviewLinkRenderer,
  CodeReviewPane,
  codeReviewText,
  type DecisionSubmit,
  formatSla,
  shortSha,
} from "@xdev-hive/code-review";
import type { CodeReviewDetail, CodeReviewSummary } from "@xdev-hive/contracts";
import { DocEditorProvider, ReviewPane, SlaBadge, useReviewFormat } from "@xdev-hive/doc-editor";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, TableBody, TableHeader, TableRow, Td, Th } from "@xdev-hive/ui/table";
import { cn } from "cn";
import { ArrowLeftIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { api, queryClient, useDesktopDocEnv } from "@/lib/hub-query.tsx";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { screenParam } from "@/lib/nav.ts";
import { errorText, invoke } from "@/lib/tauri.ts";

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
  tabsLabel: string;
  tabDocs: string;
  tabCode: string;
  codeLead: string;
  codeEmpty: string;
  colPr: string;
  colChanges: string;
  openPr: (title: string) => string;
  loadFailed: string;
  retry: string;
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
    tabsLabel: "Loại phiên duyệt",
    tabDocs: "Tài liệu",
    tabCode: "Code",
    codeLead: "PR đang chờ bạn duyệt ở checkpoint người duyệt. Mở một PR để xem diff, kết quả kiểm và quyết định.",
    codeEmpty: "Không có PR nào chờ bạn duyệt.",
    colPr: "PR",
    colChanges: "Thay đổi",
    openPr: (title) => `Duyệt PR ${title}`,
    loadFailed: "Không tải được PR.",
    retry: "Thử lại",
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
    tabsLabel: "Review type",
    tabDocs: "Docs",
    tabCode: "Code",
    codeLead: "Pull requests waiting for you at a human checkpoint. Open one to see the diff, checks and decide.",
    codeEmpty: "No pull request is waiting for your review.",
    colPr: "PR",
    colChanges: "Changes",
    openPr: (title) => `Review PR ${title}`,
    loadFailed: "Could not load the PR.",
    retry: "Retry",
  },
};

type Route = { tab: "docs" | "code"; id?: string | undefined };

/** `#/reviews`, `#/reviews/<id>` (tài liệu), `#/reviews/code`, `#/reviews/code/<id>` (PR). `code` không trùng id nào vì id là uuid. */
function parseRoute(param: string): Route {
  if (param === "code") return { tab: "code" };
  if (param.startsWith("code/")) return { tab: "code", id: param.slice(5) || undefined };
  return param ? { tab: "docs", id: param } : { tab: "docs" };
}

const go = (route: Route) => {
  const path = route.tab === "code" ? "#/reviews/code" : "#/reviews";
  location.hash = route.id ? `${path}/${encodeURIComponent(route.id)}` : path;
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
 * Màn Chờ tôi duyệt: hai tab. Tài liệu (spec 008 US11, FR-024): `reviews.list` phạm vi `mine`, `#/reviews/<id>` mở khung
 * duyệt dùng chung với web (packages/doc-editor `ReviewPane`). Code (spec 009 US3): `codeReviews.list` phạm vi `mine`,
 * `#/reviews/code/<id>` mở khung PR dùng chung với web (packages/code-review). Hub ghi quyết định và báo người viết
 * như khi duyệt trên web.
 */
export function ReviewsScreen() {
  const route = parseRoute(useSyncExternalStore(subscribe, () => screenParam(location.hash)));
  const now = useNow();
  return (
    <QueryClientProvider client={queryClient}>
      <DocEditorProvider env={useDesktopDocEnv()}>
        {route.id && route.tab === "code" ? (
          <CodeDetail key={route.id} id={route.id} now={now} />
        ) : route.id ? (
          <ReviewDetail key={route.id} id={route.id} now={now} />
        ) : (
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
            <Tabs tab={route.tab} />
            {route.tab === "code" ? <CodeQueue now={now} /> : <ReviewQueue now={now} />}
          </div>
        )}
      </DocEditorProvider>
    </QueryClientProvider>
  );
}

/** Số đếm lấy từ truy vấn sẵn có của từng hàng chờ nên tab không tốn thêm lời gọi hub. */
function Tabs({ tab }: { tab: Route["tab"] }) {
  const t = useT(text);
  const docs = useQuery({
    ...api.reviews.list.queryOptions({ input: { scope: "mine", limit: 100 } }),
    refetchInterval: 60_000,
  });
  const code = useQuery({ ...api.codeReviews.count.queryOptions(), refetchInterval: 60_000 });
  const tabs = [
    { id: "docs", label: t.tabDocs, count: docs.data?.items.length },
    { id: "code", label: t.tabCode, count: code.data?.awaitingMe },
  ] as const;
  return (
    <div role="tablist" aria-label={t.tabsLabel} className="flex gap-3.5 border-b">
      {tabs.map(({ id, label, count }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={tab === id}
          onClick={() => go({ tab: id })}
          className={cn(
            "-mb-px flex h-8.5 cursor-pointer items-center gap-1.5 border-b-2 text-sm",
            tab === id
              ? "border-primary font-semibold text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
          {!!count && (
            <Pill tone={tab === id ? "sel" : "neutral"} small>
              {count}
            </Pill>
          )}
        </button>
      ))}
    </div>
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
    <>
      <p className="text-sm text-muted-foreground">{t.lead}</p>
      {list.error && <Alert variant="destructive">{errorText(list.error)}</Alert>}
      <div className="overflow-hidden rounded-xl border bg-card text-card-foreground">
        {!list.data ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">{list.error ? "—" : t.loading}</p>
        ) : list.data.items.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">{t.empty}</p>
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
                      onClick={() => go({ tab: "docs", id: row.id })}
                    >
                      <span className="truncate text-sm font-medium">{row.docTitle}</span>
                      <span className="truncate font-mono text-xs text-muted-foreground">{row.docKey}</span>
                    </button>
                  </Td>
                  <Td className="text-sm">
                    {row.gate ? (
                      <span className="flex flex-col">
                        <span>{row.gate.name}</span>
                        <span className="font-mono text-xs text-muted-foreground">
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
    </>
  );
}

function ReviewDetail({ id, now }: { id: string; now: number }) {
  const t = useT(text);
  return (
    <div className="flex w-full flex-col gap-4">
      <div>
        <Button variant="ghost" size="sm" onClick={() => go({ tab: "docs" })}>
          <ArrowLeftIcon aria-hidden="true" />
          {t.back}
        </Button>
      </div>
      {/* ReviewPane tự làm mới hàng chờ sau khi quyết; khung vẫn mở để người duyệt thấy kết quả. */}
      <ReviewPane id={id} now={now} onDecided={() => undefined} />
    </div>
  );
}

function CodeQueue({ now }: { now: number }) {
  const t = useT(text);
  const c = codeReviewText[useLang()];
  const list = useQuery({
    ...api.codeReviews.list.queryOptions({ input: { scope: "mine", limit: 100 } }),
    refetchInterval: 60_000,
  });
  return (
    <>
      <p className="text-sm text-muted-foreground">{t.codeLead}</p>
      {list.error && <Alert variant="destructive">{errorText(list.error)}</Alert>}
      <div className="overflow-hidden rounded-xl border bg-card text-card-foreground">
        {!list.data ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">{list.error ? "—" : t.loading}</p>
        ) : list.data.items.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">{t.codeEmpty}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <Th>{t.colPr}</Th>
                <Th>{t.colGate}</Th>
                <Th>{t.colChanges}</Th>
                <Th>{t.colSla}</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.items.map((row) => (
                <CodeRow key={row.id} row={row} now={now} c={c} />
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </>
  );
}

function CodeRow({ row, now, c }: { row: CodeReviewSummary; now: number; c: typeof codeReviewText.vi }) {
  const t = useT(text);
  const title = row.task?.title ?? row.workflow.name;
  return (
    <TableRow>
      <Td className="max-w-96">
        <button
          type="button"
          aria-label={t.openPr(title)}
          className="flex w-full min-w-0 cursor-pointer flex-col text-left"
          onClick={() => go({ tab: "code", id: row.id })}
        >
          <span className="truncate text-sm font-medium">{title}</span>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {row.project.key} · #{row.pr.number} · {shortSha(row.pr.headSha)}
          </span>
        </button>
      </Td>
      <Td className="text-sm">
        {row.gate ? (
          <span className="flex flex-col">
            <span>{row.gate.name}</span>
            <span className="font-mono text-xs text-muted-foreground">
              {row.gate.index + 1}/{row.gate.total} · {row.workflow.name}
            </span>
          </span>
        ) : (
          "—"
        )}
      </Td>
      <Td className="font-mono text-xs whitespace-nowrap tabular-nums">
        <span className="text-success">+{row.addedLines}</span>{" "}
        <span className="text-destructive">−{row.deletedLines}</span>
      </Td>
      <Td className="text-xs whitespace-nowrap">
        {row.gate && row.gate.sla !== "none" ? (
          <Pill
            tone={row.gate.sla === "overdue" ? "bad" : row.gate.sla === "due-soon" ? "warn" : "ok"}
            dot={row.gate.sla !== "on-time"}
          >
            {formatSla(c, row.gate, now)}
          </Pill>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </Td>
    </TableRow>
  );
}

/** Run và task là trang của hub, nên mở trong cửa sổ web của hub như các liên kết khác của app. */
const codeLink: CodeReviewLinkRenderer = ({ to, className, children }) => (
  <button
    type="button"
    className={`cursor-pointer border-0 bg-transparent p-0 text-left ${className ?? ""}`}
    onClick={() => void invoke("open_hub_page", { path: to.kind === "run" ? `/runs/${to.id}` : "/tasks" })}
  >
    {children}
  </button>
);

function CodeDetail({ id, now }: { id: string; now: number }) {
  const t = useT(text);
  const c = codeReviewText[useLang()];
  const client = useQueryClient();
  const query = useQuery({
    ...api.codeReviews.get.queryOptions({ input: { id } }),
    refetchInterval: 60_000,
  });
  const files = useQuery(api.codeReviews.files.queryOptions({ input: { id } }));

  // Quyết định gắn với đầu PR người duyệt đã xem. Bản mới từ lần làm mới nền chỉ báo "PR có commit mới" chứ không
  // thay khung đang xem, nếu không người duyệt sẽ duyệt một diff họ chưa đọc.
  const [viewed, setViewed] = useState<CodeReviewDetail>();
  useEffect(() => {
    if (query.data && !viewed) setViewed(query.data);
  }, [query.data, viewed]);

  const done = (next: CodeReviewDetail) => {
    client.setQueryData(api.codeReviews.get.queryKey({ input: { id } }), next);
    setViewed(next);
    void client.invalidateQueries({ queryKey: api.codeReviews.list.key() });
    void client.invalidateQueries({ queryKey: api.codeReviews.count.key() });
  };
  const decide = useMutation({
    mutationFn: (input: DecisionSubmit) => api.codeReviews.decide.call({ id, ...input }),
    onSuccess: done,
  });
  // Quyết thay checkpoint tự động là việc quản trị (quyền reviews.override), chỉ làm trên web; nút chạy lại kiểm nằm
  // trong cùng khung đó nên cũng không có ở app.
  const enqueue = useMutation({ mutationFn: () => api.codeReviews.enqueue.call({ id }), onSuccess: done });
  const reload = () => {
    if (query.data) setViewed(query.data);
    void files.refetch();
  };

  const failure = [decide, enqueue].find((m) => m.error)?.error;
  return (
    <div className="flex w-full flex-col gap-4">
      <div>
        <Button variant="ghost" size="sm" onClick={() => go({ tab: "code" })}>
          <ArrowLeftIcon aria-hidden="true" />
          {t.back}
        </Button>
      </div>
      {query.error && !viewed ? (
        <Alert variant="destructive" className="flex flex-wrap items-center justify-between gap-2">
          {t.loadFailed} {errorText(query.error)}
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            {t.retry}
          </Button>
        </Alert>
      ) : !viewed ? (
        <p className="text-sm text-muted-foreground">{t.loading}</p>
      ) : (
        <CodeReviewPane
          detail={viewed}
          files={
            files.data
              ? { status: "ready", data: files.data }
              : files.error
                ? { status: "error", message: errorText(files.error), retry: () => void files.refetch() }
                : { status: "loading" }
          }
          latestHeadSha={query.data?.pr.headSha ?? null}
          now={now}
          t={c}
          pending={decide.isPending || enqueue.isPending}
          error={failure ? errorText(failure) : null}
          link={codeLink}
          onDecide={(input) => decide.mutate(input)}
          onEnqueue={() => enqueue.mutate()}
          onReload={reload}
        />
      )}
    </div>
  );
}
