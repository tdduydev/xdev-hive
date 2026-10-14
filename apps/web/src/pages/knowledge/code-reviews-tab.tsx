import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type CodeReviewLinkRenderer,
  CodeReviewPane,
  type CodeReviewText,
  codeReviewText,
  type DecisionSubmit,
  formatScore,
  formatSla,
} from "@xdev-hive/code-review";
import type { CodeReviewDetail, CodeReviewStatus, CodeReviewSummary, SlaState } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { type ReactNode, useId, useState } from "react";
import { type Column, DataTable } from "@/components/data-table/data-table.tsx";
import { GateKindBadge } from "@/components/gate-kind-badge.tsx";
import { FilterChips } from "@/components/ui/filter-chips.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { CODE_STATUSES, codeReviewCountKey, uniqueById } from "@/lib/code-reviews.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { useNow } from "@/lib/use-now.ts";
import { useOrg } from "@/shell/org-context.ts";

type Scope = "mine" | "all";

const text: Dict<{
  queue: string;
  scope: string;
  mine: string;
  all: string;
  status: string;
  anyStatus: string;
  pr: string;
  project: string;
  gate: string;
  requester: string;
  sla: string;
  aiScore: string;
  changes: string;
  updated: string;
  search: string;
  emptyMine: ReactNode;
  emptyAll: ReactNode;
  pick: string;
  loadMore: string;
  teamRun: string;
  files: (n: number) => string;
  approved: string;
  advanced: string;
  returned: (route: string) => string;
  overridden: string;
  rechecked: string;
  enqueued: string;
  filesFailed: string;
}> = {
  vi: {
    queue: "Hàng chờ review code",
    scope: "Phạm vi",
    mine: "Chờ tôi",
    all: "Tất cả",
    status: "Trạng thái",
    anyStatus: "Mọi trạng thái",
    pr: "PR",
    project: "Dự án",
    gate: "Checkpoint",
    requester: "Giao bởi",
    sla: "Hạn",
    aiScore: "Điểm AI",
    changes: "Thay đổi",
    updated: "Cập nhật",
    search: "Tìm PR, dự án, nhánh…",
    emptyMine: "Không có PR nào đang chờ bạn duyệt.",
    emptyAll: "Chưa có phiên review code nào.",
    pick: "Chọn một PR trong bảng để xem diff và quyết định.",
    loadMore: "Tải thêm",
    teamRun: "run của đội",
    files: (n) => `${n} file`,
    approved: "Đã duyệt. PR sang bước tiếp theo.",
    advanced: "Đã duyệt. PR đã qua mọi checkpoint.",
    returned: (route) => `Đã trả lại: ${route}.`,
    overridden: "Đã quyết thay checkpoint tự động.",
    rechecked: "Đã chạy lại checkpoint.",
    enqueued: "Đã đưa PR vào hàng merge.",
    filesFailed: "Không tải được diff của PR.",
  },
  en: {
    queue: "Code review queue",
    scope: "Scope",
    mine: "Awaiting me",
    all: "All",
    status: "Status",
    anyStatus: "Any status",
    pr: "PR",
    project: "Project",
    gate: "Checkpoint",
    requester: "Requested by",
    sla: "Due",
    aiScore: "AI score",
    changes: "Changes",
    updated: "Updated",
    search: "Search PRs, projects, branches…",
    emptyMine: "No PR is waiting for your review.",
    emptyAll: "No code review sessions yet.",
    pick: "Pick a PR in the table to see its diff and decide.",
    loadMore: "Load more",
    teamRun: "team run",
    files: (n) => `${n} files`,
    approved: "Approved. The PR moves to the next step.",
    advanced: "Approved. The PR passed every checkpoint.",
    returned: (route) => `Returned: ${route}.`,
    overridden: "Automatic checkpoint overridden.",
    rechecked: "Checkpoint re-run.",
    enqueued: "PR added to the merge queue.",
    filesFailed: "Could not load the PR diff.",
  },
};

/** Link của khung review qua router của web. Task chưa có trang riêng nên mở bảng việc lọc theo mã. */
const link: CodeReviewLinkRenderer = ({ to, className, children }) =>
  to.kind === "run" ? (
    <Link to="/runs/$id" params={{ id: to.id }} className={className}>
      {children}
    </Link>
  ) : (
    <Link to="/tasks" search={{ q: to.key }} className={className}>
      {children}
    </Link>
  );

const slaTone = (sla: SlaState) => (sla === "overdue" ? "bad" : sla === "due-soon" ? "warn" : "ok");

/** Tab Code của "Chờ tôi duyệt" (CodeReview.dc.html): hàng chờ PR, rồi khung diff và quyết định của PR đang chọn. */
export function CodeReviewsTab({
  selectedId,
  onSelect,
}: {
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const { api, org } = useOrg();
  const lang = useLang();
  const t = useT(text);
  const pt = codeReviewText[lang];
  const now = useNow(60_000);
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<Scope>("mine");
  const [status, setStatus] = useState<CodeReviewStatus | "">("");
  const [done, setDone] = useState<string | null>(null);
  const ids = useId();

  const list = useInfiniteQuery(
    api.codeReviews.list.infiniteOptions({
      input: (cursor: string | undefined) => ({
        scope,
        ...(status ? { status } : {}),
        limit: 50,
        ...(cursor ? { cursor } : {}),
      }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    }),
  );
  const items = uniqueById(list.data?.pages.map((page) => page.items) ?? []);
  const activeId = selectedId ?? items[0]?.id;

  const columns: Column<CodeReviewSummary>[] = [
    {
      key: "pr",
      label: t.pr,
      value: (row) =>
        `${row.task?.title ?? row.workflow.name} ${row.task?.key ?? ""} #${row.pr.number} ${row.pr.branch}`,
      sortable: true,
      hideable: false,
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <strong className="font-medium">{row.task?.title ?? row.workflow.name}</strong>
          <span className="font-mono text-xs text-muted-foreground">
            #{row.pr.number} · {row.pr.branch}
          </span>
        </div>
      ),
    },
    {
      key: "project",
      label: t.project,
      value: (row) => row.project.key,
      cell: (row) => <span className="font-mono text-xs">{row.project.key}</span>,
    },
    {
      key: "gate",
      label: t.gate,
      value: (row) => row.gate?.name ?? pt.statusText[row.status],
      cell: (row) =>
        row.gate ? (
          <span className="flex flex-col items-start gap-0.5">
            <span className="flex items-center gap-1.5">
              <GateKindBadge kind={row.gate.kind} />
              <span className="font-mono text-xs text-muted-foreground">
                {row.gate.index + 1}/{row.gate.total}
              </span>
            </span>
            <span className="text-sm">{row.gate.name}</span>
          </span>
        ) : (
          <Pill>{pt.statusText[row.status]}</Pill>
        ),
    },
    {
      key: "requester",
      label: t.requester,
      value: (row) => row.requester?.name ?? t.teamRun,
      cell: (row) => <span className="text-muted-foreground">{row.requester?.name ?? t.teamRun}</span>,
    },
    {
      key: "sla",
      label: t.sla,
      value: (row) => (row.gate?.dueAt ? new Date(row.gate.dueAt).getTime() : null),
      sortable: true,
      cell: (row) =>
        row.gate && row.gate.sla !== "none" ? (
          <Pill tone={slaTone(row.gate.sla)} dot={row.gate.sla !== "on-time"}>
            {formatSla(pt, row.gate, now)}
          </Pill>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "ai",
      label: t.aiScore,
      value: (row) => row.aiScore,
      sortable: true,
      className: "text-right tabular-nums",
      cell: (row) => <span className="font-mono">{formatScore(pt, row.aiScore)}</span>,
    },
    {
      key: "changes",
      label: t.changes,
      value: (row) => row.addedLines + row.deletedLines,
      sortable: true,
      cell: (row) => (
        <span className="font-mono text-xs whitespace-nowrap">
          <span className="text-success">+{row.addedLines}</span>{" "}
          <span className="text-destructive">−{row.deletedLines}</span>{" "}
          <span className="text-muted-foreground">· {t.files(row.changedFiles)}</span>
        </span>
      ),
    },
    {
      key: "updated",
      label: t.updated,
      value: (row) => row.updatedAt,
      sortable: true,
      cell: (row) => (
        <time dateTime={row.updatedAt} className="text-xs whitespace-nowrap text-muted-foreground">
          {new Date(row.updatedAt).toLocaleString(pt.locale)}
        </time>
      ),
    },
  ];

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <FilterChips
          label={t.scope}
          chips={[
            { key: "mine", label: t.mine },
            { key: "all", label: t.all },
          ]}
          value={scope}
          onChange={setScope}
        />
        <label htmlFor={`${ids}-status`} className="flex items-center gap-2 text-sm font-medium">
          {t.status}
          <NativeSelect
            id={`${ids}-status`}
            size="sm"
            className="w-44"
            value={status}
            onChange={(e) => setStatus(e.target.value as CodeReviewStatus | "")}
          >
            <option value="">{t.anyStatus}</option>
            {CODE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {pt.statusText[s]}
              </option>
            ))}
          </NativeSelect>
        </label>
      </div>
      {list.isPending && <LoadingState />}
      {list.isError && <LoadFailure error={list.error} retry={() => list.refetch()} />}
      {list.data && (
        <div className="grid min-w-0 gap-2">
          <DataTable
            columns={columns}
            rows={items}
            pageSize={5}
            caption={t.queue}
            placeholder={t.search}
            facets={[
              { key: "project", label: t.project, value: (row) => row.project.key },
              { key: "gate", label: t.gate, value: (row) => row.gate?.name ?? null },
            ]}
            onRowClick={(row) => {
              setDone(null);
              onSelect(row.id);
            }}
            rowLabel={(row) => row.task?.title ?? row.workflow.name}
            activeId={activeId ?? ""}
            emptyContent={scope === "mine" ? t.emptyMine : t.emptyAll}
          />
          {list.hasNextPage && (
            <Button
              variant="outline"
              size="sm"
              className="justify-self-center"
              disabled={list.isFetchingNextPage}
              onClick={() => list.fetchNextPage()}
            >
              {t.loadMore}
            </Button>
          )}
        </div>
      )}
      {done && (
        <p role="status" className="m-0 text-sm text-success">
          {done}
        </p>
      )}
      {activeId ? (
        <CodeReviewDetailPane
          key={activeId}
          id={activeId}
          now={now}
          pt={pt}
          onDone={(message, id) => {
            setDone(message);
            // Quyết định xong thì PR rời hàng "chờ tôi"; ghim lựa chọn để người duyệt vẫn thấy kết quả.
            onSelect(id);
            void queryClient.invalidateQueries({ queryKey: api.codeReviews.key() });
            void queryClient.invalidateQueries({ queryKey: codeReviewCountKey(org.id) });
          }}
        />
      ) : (
        list.data && items.length > 0 && <p className="text-muted-foreground">{t.pick}</p>
      )}
    </div>
  );
}

/** Dữ liệu và hành động của một phiên; tách ra để `key` theo id bỏ trạng thái dở dang khi đổi PR. */
function CodeReviewDetailPane({
  id,
  now,
  pt,
  onDone,
}: {
  id: string;
  now: number;
  pt: CodeReviewText;
  onDone: (message: string, id: string) => void;
}) {
  const { api } = useOrg();
  const t = useT(text);
  const queryClient = useQueryClient();
  const detailKey = api.codeReviews.get.queryKey({ input: { id } });
  const detail = useQuery(api.codeReviews.get.queryOptions({ input: { id } }));
  const files = useQuery(api.codeReviews.files.queryOptions({ input: { id } }));

  const reload = () => {
    void detail.refetch();
    void files.refetch();
    void queryClient.invalidateQueries({ queryKey: api.codeReviews.list.key() });
  };
  const settle = (next: CodeReviewDetail, message: string) => {
    queryClient.setQueryData(detailKey, next);
    onDone(message, id);
  };

  const decide = useMutation({
    mutationFn: (input: DecisionSubmit) => api.codeReviews.decide.call({ id, ...input }),
    onSuccess: (next, input) =>
      settle(
        next,
        input.decision === "changes"
          ? t.returned(pt.route[input.route ?? next.route ?? "agent"])
          : next.status === "approved"
            ? t.advanced
            : t.approved,
      ),
  });
  const override = useMutation({
    mutationFn: (input: { headSha: string; passed: boolean; note: string }) =>
      api.codeReviews.override.call({ id, ...input }),
    onSuccess: (next) => settle(next, t.overridden),
  });
  const recheck = useMutation({
    mutationFn: () => api.codeReviews.recheck.call({ id }),
    onSuccess: (next) => settle(next, t.rechecked),
  });
  const enqueue = useMutation({
    mutationFn: () => api.codeReviews.enqueue.call({ id }),
    onSuccess: (next) => settle(next, t.enqueued),
  });

  if (detail.isPending) return <LoadingState />;
  if (detail.isError) return <LoadFailure error={detail.error} retry={() => detail.refetch()} />;

  const failed = decide.error ?? override.error ?? recheck.error ?? enqueue.error;
  return (
    <CodeReviewPane
      detail={detail.data}
      files={
        files.isPending
          ? { status: "loading" }
          : files.isError
            ? {
                status: "error",
                message: `${t.filesFailed} ${apiErrorMessage(files.error)}`,
                retry: () => files.refetch(),
              }
            : { status: "ready", data: files.data }
      }
      latestHeadSha={files.data?.headSha ?? null}
      now={now}
      t={pt}
      pending={decide.isPending || override.isPending || recheck.isPending || enqueue.isPending}
      error={failed ? apiErrorMessage(failed) : null}
      link={link}
      onDecide={(input) => decide.mutate(input)}
      onOverride={(input) => override.mutate(input)}
      onRecheck={() => recheck.mutate()}
      onEnqueue={() => enqueue.mutate()}
      onReload={reload}
    />
  );
}
