import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type {
  ChecklistItem,
  GateRun,
  RejectRoute,
  ReviewDetail,
  ReviewStatus,
  ReviewSummary,
  SlaState,
} from "@xdev-hive/contracts";
import { diffBlocks, lineDiff } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Textarea } from "@xdev-hive/ui/textarea";
import { BotIcon } from "lucide-react";
import { type ReactNode, useId, useMemo, useRef, useState } from "react";
import { type Column, DataTable } from "@/components/data-table/data-table.tsx";
import { GateKindBadge } from "@/components/gate-kind-badge.tsx";
import { FilterChips } from "@/components/ui/filter-chips.tsx";
import { Pill } from "@/components/ui/pill.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { type Dict, type Lang, useLang, useT } from "@/lib/i18n.ts";
import { ROLE_LABEL } from "@/lib/review-workflows.ts";
import { useNow } from "@/lib/use-now.ts";
import { cn } from "@/lib/utils.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

export interface ReviewsSearch {
  id?: string;
}

/** `?id=<phiên duyệt>` để thông báo và đề xuất dẫn thẳng tới một tài liệu trong hàng chờ. */
export function validateReviewsSearch(search: Record<string, unknown>): ReviewsSearch {
  return typeof search.id === "string" && /^[0-9a-f-]{36}$/i.test(search.id) ? { id: search.id } : {};
}

type Scope = "mine" | "all";
const STATUSES: ReviewStatus[] = ["in_review", "changes_requested", "approved", "cancelled"];
const SLA_STATES: SlaState[] = ["overdue", "due-soon", "on-time", "none"];
const HOUR = 3_600_000;

const text: Dict<{
  knowledge: string;
  title: string;
  scope: string;
  mine: string;
  all: string;
  status: string;
  anyStatus: string;
  statusText: Record<ReviewStatus, string>;
  search: string;
  queue: string;
  doc: string;
  type: string;
  workflow: string;
  gate: string;
  by: string;
  aiScore: string;
  lines: string;
  updated: string;
  sla: string;
  slaText: Record<SlaState, string>;
  overdueBy: (h: string) => string;
  left: (h: string) => string;
  slaLeft: (h: string) => string;
  hours: (n: number) => string;
  days: (n: number) => string;
  author: string;
  agent: string;
  person: string;
  emptyMine: string;
  emptyAll: string;
  loadMore: string;
  detail: string;
  steps: string;
  draft: string;
  baseline: (v: number) => string;
  stepState: Record<"done" | "current" | "failed" | "skipped" | "todo", string>;
  newDoc: string;
  reason: string;
  notes: string;
  changes: string;
  changesMeta: (added: number, deleted: number) => string;
  noChanges: string;
  unchanged: (n: number) => string;
  addedLine: string;
  removedLine: string;
  aiCheck: string;
  ruleCheck: string;
  trace: string;
  traceReq: string;
  traceAc: string;
  traceTasks: string;
  noAc: string;
  noTrace: string;
  decision: string;
  note: string;
  ifReturn: string;
  route: (prev: string) => Record<RejectRoute, string>;
  requestChanges: string;
  approve: string;
  sending: string;
  noteRequired: string;
  approvedBy: (names: string) => string;
  assigned: string;
  teamPrefix: string;
  progress: (n: number, quorum: number) => string;
  progressAll: (n: number) => string;
  approvedMsg: string;
  baselinedMsg: (v: number) => string;
  returnedMsg: (route: string) => string;
  notYours: (gate: string) => string;
  finalText: Record<Exclude<ReviewStatus, "in_review">, string>;
  pick: string;
}> = {
  vi: {
    knowledge: "Kiến thức",
    title: "Chờ tôi duyệt",
    scope: "Phạm vi",
    mine: "Chờ tôi duyệt",
    all: "Tất cả",
    status: "Trạng thái",
    anyStatus: "Mọi trạng thái",
    statusText: {
      in_review: "Đang duyệt",
      changes_requested: "Cần sửa",
      approved: "Đã duyệt",
      cancelled: "Đã huỷ",
    },
    search: "Tìm tài liệu, dự án…",
    queue: "Hàng chờ duyệt",
    doc: "Tài liệu",
    type: "Loại",
    workflow: "Quy trình",
    gate: "Checkpoint",
    by: "Người gửi",
    aiScore: "Điểm AI",
    lines: "Dòng đổi",
    updated: "Cập nhật",
    sla: "SLA",
    slaText: { overdue: "Quá hạn", "due-soon": "Sắp hạn", "on-time": "Còn hạn", none: "Không hạn" },
    overdueBy: (h) => `Quá hạn ${h}`,
    left: (h) => `còn ${h}`,
    slaLeft: (h) => `SLA còn ${h}`,
    hours: (n) => `${n} giờ`,
    days: (n) => `${n} ngày`,
    author: "Người viết",
    agent: "AI",
    person: "Người",
    emptyMine: "Không có tài liệu nào chờ bạn duyệt.",
    emptyAll: "Chưa có phiên duyệt nào.",
    loadMore: "Tải thêm",
    detail: "Chi tiết phiên duyệt",
    steps: "Các checkpoint",
    draft: "Soạn",
    baseline: (v) => `Chốt v${v}`,
    stepState: { done: "đã qua", current: "đang chờ", failed: "bị trả lại", skipped: "bỏ qua", todo: "chưa tới" },
    newDoc: "tài liệu mới",
    reason: "Lý do sửa",
    notes: "Góp ý ở các checkpoint",
    changes: "Thay đổi so với bản đã duyệt",
    changesMeta: (a, d) => `+${a} / −${d} dòng`,
    noChanges: "Nội dung không đổi so với bản đã duyệt.",
    unchanged: (n) => `${n} dòng không đổi`,
    addedLine: "Thêm: ",
    removedLine: "Xoá: ",
    aiCheck: "AI tự kiểm",
    ruleCheck: "Quy tắc tự động",
    trace: "Truy vết yêu cầu",
    traceReq: "Yêu cầu",
    traceAc: "Tiêu chí chấp nhận",
    traceTasks: "Việc",
    noAc: "Chưa có tiêu chí",
    noTrace: "Tài liệu chưa có yêu cầu đánh mã R-n.",
    decision: "Quyết định của bạn",
    note: "Góp ý cho người viết",
    ifReturn: "Nếu yêu cầu sửa",
    route: (prev) => ({
      author: "Trả về người viết",
      agent: "Agent sửa theo góp ý, rồi quay lại checkpoint này",
      previous: `Về checkpoint trước${prev ? ` (${prev})` : ""}`,
    }),
    requestChanges: "Yêu cầu sửa",
    approve: "Duyệt",
    sending: "Đang gửi…",
    noteRequired: "Ghi góp ý khi trả lại.",
    approvedBy: (names) => `Đã duyệt ở checkpoint này: ${names}`,
    assigned: "Người duyệt ở checkpoint này",
    teamPrefix: "Đội",
    progress: (n, q) => `Đã duyệt ${n}/${q}`,
    progressAll: (n) => `Đã duyệt ${n} · cần tất cả`,
    approvedMsg: "Đã duyệt. Tài liệu sang checkpoint tiếp theo.",
    baselinedMsg: (v) => `Đã duyệt xong quy trình; hub chốt phiên bản v${v}.`,
    returnedMsg: (route) => `Đã trả lại: ${route}.`,
    notYours: (gate) => `Đang chờ “${gate}”. Bạn không phải người duyệt ở checkpoint này.`,
    finalText: {
      changes_requested: "Đang chờ sửa theo góp ý.",
      approved: "Tài liệu đã qua mọi checkpoint.",
      cancelled: "Phiên duyệt đã huỷ.",
    },
    pick: "Chọn một tài liệu trong bảng để xem thay đổi.",
  },
  en: {
    knowledge: "Knowledge",
    title: "Awaiting my review",
    scope: "Scope",
    mine: "Awaiting me",
    all: "All",
    status: "Status",
    anyStatus: "Any status",
    statusText: {
      in_review: "In review",
      changes_requested: "Changes requested",
      approved: "Approved",
      cancelled: "Cancelled",
    },
    search: "Search doc, project…",
    queue: "Review queue",
    doc: "Doc",
    type: "Type",
    workflow: "Workflow",
    gate: "Checkpoint",
    by: "Submitted by",
    aiScore: "AI score",
    lines: "Changed lines",
    updated: "Updated",
    sla: "SLA",
    slaText: { overdue: "Overdue", "due-soon": "Due soon", "on-time": "On time", none: "No SLA" },
    overdueBy: (h) => `${h} overdue`,
    left: (h) => `${h} left`,
    slaLeft: (h) => `SLA ${h} left`,
    hours: (n) => `${n} h`,
    days: (n) => `${n} d`,
    author: "Author",
    agent: "AI",
    person: "Person",
    emptyMine: "Nothing is waiting for your review.",
    emptyAll: "No reviews yet.",
    loadMore: "Load more",
    detail: "Review details",
    steps: "Checkpoints",
    draft: "Draft",
    baseline: (v) => `Baseline v${v}`,
    stepState: { done: "passed", current: "waiting", failed: "sent back", skipped: "skipped", todo: "not yet" },
    newDoc: "new doc",
    reason: "Reason",
    notes: "Checkpoint feedback",
    changes: "Changes since the approved version",
    changesMeta: (a, d) => `+${a} / −${d} lines`,
    noChanges: "No changes since the approved version.",
    unchanged: (n) => `${n} unchanged lines`,
    addedLine: "Added: ",
    removedLine: "Removed: ",
    aiCheck: "AI pre-check",
    ruleCheck: "Automatic rules",
    trace: "Requirement traceability",
    traceReq: "Requirement",
    traceAc: "Acceptance criteria",
    traceTasks: "Tasks",
    noAc: "No criteria yet",
    noTrace: "The doc has no R-n requirements yet.",
    decision: "Your decision",
    note: "Feedback for the author",
    ifReturn: "If you request changes",
    route: (prev) => ({
      author: "Back to the author",
      agent: "Agent revises, then returns here",
      previous: `Previous checkpoint${prev ? ` (${prev})` : ""}`,
    }),
    requestChanges: "Request changes",
    approve: "Approve",
    sending: "Sending…",
    noteRequired: "Write feedback when sending it back.",
    approvedBy: (names) => `Approved at this checkpoint: ${names}`,
    assigned: "Approvers at this checkpoint",
    teamPrefix: "Team",
    progress: (n, q) => `Approved ${n}/${q}`,
    progressAll: (n) => `Approved ${n} · everyone needed`,
    approvedMsg: "Approved. The doc moves to the next checkpoint.",
    baselinedMsg: (v) => `Workflow complete; the hub baselined v${v}.`,
    returnedMsg: (route) => `Sent back: ${route}.`,
    notYours: (gate) => `Waiting on “${gate}”. You are not an approver at this checkpoint.`,
    finalText: {
      changes_requested: "Waiting for the requested changes.",
      approved: "The doc passed every checkpoint.",
      cancelled: "This review was cancelled.",
    },
    pick: "Pick a doc in the table to see its changes.",
  },
};

type T = (typeof text)["vi"];

function span(ms: number, t: T): string {
  const h = Math.max(1, Math.round(Math.abs(ms) / HOUR));
  return h > 48 ? t.days(Math.round(h / 24)) : t.hours(h);
}

function SlaBadge({ gate, now, long }: { gate: ReviewSummary["gate"]; now: number; long?: boolean }) {
  const t = useT(text);
  if (!gate || gate.sla === "none") return <span className="text-muted-foreground">—</span>;
  const left = gate.dueAt ? new Date(gate.dueAt).getTime() - now : null;
  const label =
    left === null
      ? t.slaText[gate.sla]
      : gate.sla === "overdue"
        ? t.overdueBy(span(left, t))
        : long
          ? t.slaLeft(span(left, t))
          : t.left(span(left, t));
  return (
    <Pill tone={gate.sla === "overdue" ? "bad" : gate.sla === "due-soon" ? "warn" : "ok"} dot={gate.sla !== "on-time"}>
      {label}
    </Pill>
  );
}

function useFormat(lang: Lang) {
  return useMemo(() => {
    const score = new Intl.NumberFormat(lang === "en" ? "en-US" : "vi-VN", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    const rel = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
    return {
      score: (n: number | null) => (n === null ? "—" : score.format(n)),
      ago: (iso: string, now: number) => {
        const sec = (new Date(iso).getTime() - now) / 1000;
        if (Number.isNaN(sec)) return "—";
        if (Math.abs(sec) < 3600) return rel.format(Math.round(sec / 60), "minute");
        if (Math.abs(sec) < 86_400) return rel.format(Math.round(sec / 3600), "hour");
        return rel.format(Math.round(sec / 86_400), "day");
      },
    };
  }, [lang]);
}

/** Hàng chờ duyệt tài liệu (DocReview.dc.html): bảng phiên duyệt, thay đổi so với bản đã duyệt, quyết định. */
export function ReviewsPage() {
  const { org } = useOrg();
  return <ReviewsScreen key={org.id} />;
}

function ReviewsScreen() {
  const { api } = useOrg();
  const t = useT(text);
  const lang = useLang();
  const fmt = useFormat(lang);
  const now = useNow(60_000);
  const search = useSearch({ from: "/session/app/in-org/knowledge/reviews" });
  const navigate = useNavigate({ from: "/knowledge/reviews" });
  const [scope, setScope] = useState<Scope>("mine");
  const [status, setStatus] = useState<ReviewStatus | "">("");
  const ids = useId();
  const list = useInfiniteQuery(
    api.reviews.list.infiniteOptions({
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
  const items = [
    ...new Map((list.data?.pages.flatMap((page) => page.items) ?? []).map((row) => [row.id, row])).values(),
  ];
  const selectedId = search.id ?? items[0]?.id;
  const select = (id: string) => navigate({ search: { id }, replace: true });

  const slaOptions = SLA_STATES.map((s) => ({ value: s, label: t.slaText[s] }));
  const columns: Column<ReviewSummary>[] = [
    {
      key: "doc",
      label: t.doc,
      value: (row) => `${row.docTitle} ${row.docKey}`,
      sortable: true,
      hideable: false,
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <strong className="font-medium">{row.docTitle}</strong>
          <span className="font-mono text-xs text-muted-foreground">{row.docKey}</span>
        </div>
      ),
    },
    {
      key: "type",
      label: t.type,
      value: (row) => row.docType,
      cell: (row) => (
        <span className="inline-flex h-5.5 items-center rounded-full bg-secondary px-2 font-mono text-xs text-secondary-foreground">
          {row.docType}
        </span>
      ),
    },
    { key: "workflow", label: t.workflow, value: (row) => row.workflowName, className: "whitespace-nowrap" },
    {
      key: "gate",
      label: t.gate,
      value: (row) => row.gate?.name ?? t.statusText[row.status],
      cell: (row) =>
        row.gate ? (
          <span className="flex flex-col items-start gap-0.5">
            <span className="flex items-center gap-1.5">
              <GateKindBadge kind={row.gate.kind} />
              <span className="font-mono text-[11px] text-muted-foreground">
                {row.gate.index + 1}/{row.gate.total}
              </span>
            </span>
            <span className="text-[13px]">{row.gate.name}</span>
          </span>
        ) : (
          <StatusPill status={row.status} />
        ),
    },
    {
      key: "by",
      label: t.by,
      value: (row) => row.author.name,
      cell: (row) => (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          {row.author.runId && <BotIcon className="size-3.5" aria-label={t.agent} />}
          {row.author.name}
        </span>
      ),
    },
    {
      key: "sla",
      label: t.sla,
      value: (row) => (row.gate?.dueAt ? new Date(row.gate.dueAt).getTime() : null),
      sortable: true,
      cell: (row) => <SlaBadge gate={row.gate} now={now} />,
    },
    {
      key: "ai",
      label: t.aiScore,
      value: (row) => row.aiScore,
      sortable: true,
      className: "text-right tabular-nums",
      cell: (row) => <span className="font-mono">{fmt.score(row.aiScore)}</span>,
    },
    {
      key: "lines",
      label: t.lines,
      value: (row) => row.addedLines + row.deletedLines,
      sortable: true,
      cell: (row) => (
        <span className="font-mono text-xs whitespace-nowrap">
          <span className="text-success">+{row.addedLines}</span>{" "}
          <span className="text-destructive">−{row.deletedLines}</span>
        </span>
      ),
    },
    {
      key: "updated",
      label: t.updated,
      value: (row) => row.updatedAt,
      sortable: true,
      cell: (row) => (
        <span className="text-xs whitespace-nowrap text-muted-foreground">{fmt.ago(row.updatedAt, now)}</span>
      ),
    },
  ];

  return (
    <>
      <PageHeader crumb={t.knowledge} title={t.title} />
      <PageBody>
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
          <label htmlFor={`${ids}-status`} className="flex items-center gap-2 text-[13px] font-medium">
            {t.status}
            <NativeSelect
              id={`${ids}-status`}
              size="sm"
              className="w-44"
              value={status}
              onChange={(e) => setStatus(e.target.value as ReviewStatus | "")}
            >
              <option value="">{t.anyStatus}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t.statusText[s]}
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
              selectable={false}
              facets={[
                { key: "type", label: t.type, value: (row) => row.docType },
                { key: "gate", label: t.gate, value: (row) => row.gate?.name ?? null },
                { key: "sla", label: t.sla, value: (row) => row.gate?.sla ?? "none", options: slaOptions },
                {
                  key: "author",
                  label: t.by,
                  value: (row) => (row.author.runId ? "ai" : "person"),
                  options: [
                    { value: "ai", label: t.agent },
                    { value: "person", label: t.person },
                  ],
                },
              ]}
              onRowClick={(row) => select(row.id)}
              rowLabel={(row) => row.docTitle}
              activeId={selectedId ?? ""}
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
        {selectedId ? (
          <ReviewPane
            key={selectedId}
            id={selectedId}
            now={now}
            // Quyết định xong thì tài liệu rời hàng "chờ tôi"; ghim lựa chọn để người duyệt vẫn thấy kết quả.
            onDecided={() => select(selectedId)}
          />
        ) : (
          list.data && items.length > 0 && <p className="text-muted-foreground">{t.pick}</p>
        )}
      </PageBody>
    </>
  );
}

function StatusPill({ status }: { status: ReviewStatus }) {
  const t = useT(text);
  return (
    <Pill
      tone={
        status === "approved"
          ? "ok"
          : status === "changes_requested"
            ? "bad"
            : status === "in_review"
              ? "warn"
              : "neutral"
      }
    >
      {t.statusText[status]}
    </Pill>
  );
}

type StepState = "done" | "current" | "failed" | "skipped" | "todo";
const STEP_STYLE: Record<StepState, string> = {
  done: "bg-success-soft text-success",
  current: "bg-warning-soft font-semibold text-warning",
  failed: "bg-destructive-soft font-semibold text-destructive",
  skipped: "border border-dashed border-input text-muted-foreground line-through",
  todo: "border border-border bg-card text-muted-foreground",
};
const STEP_MARK: Record<StepState, string> = { done: "✓", current: "●", failed: "✗", skipped: "↷", todo: "○" };

function stepOf(g: GateRun, d: ReviewDetail): StepState {
  if (g.status === "passed") return "done";
  if (g.status === "failed") return "failed";
  if (g.status === "skipped") return "skipped";
  return d.status === "in_review" && d.gate?.id === g.gateId ? "current" : "todo";
}

function ReviewPane({ id, now, onDecided }: { id: string; now: number; onDecided: () => void }) {
  const { api } = useOrg();
  const t = useT(text);
  const detail = useQuery(api.reviews.get.queryOptions({ input: { id } }));
  if (detail.isPending) return <LoadingState />;
  if (detail.isError) return <LoadFailure error={detail.error} retry={() => detail.refetch()} />;
  const d = detail.data;
  const checked = d.gates.filter(
    (g) => (g.kind === "ai" || g.kind === "rule") && (g.checklist.length || g.score !== null),
  );
  return (
    <section aria-label={t.detail} className="flex flex-wrap items-start gap-4">
      <div className="flex min-w-0 flex-[3_1_560px] flex-col gap-4">
        <ReviewHeader d={d} now={now} />
        <DiffCard d={d} />
      </div>
      <aside className="flex min-w-0 flex-[2_1_380px] flex-col gap-4">
        {checked.map((g) => (
          <ChecklistCard key={g.gateId} gate={g} />
        ))}
        <TraceCard d={d} />
        <DecisionCard d={d} onDecided={onDecided} />
      </aside>
    </section>
  );
}

function Card({
  title,
  meta,
  children,
  label,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  label?: string;
}) {
  return (
    <section aria-label={label ?? title} className="overflow-hidden rounded-xl border bg-card text-card-foreground">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="m-0 text-[14.5px] font-semibold">{title}</h2>
        {meta}
      </div>
      {children}
    </section>
  );
}

function ReviewHeader({ d, now }: { d: ReviewDetail; now: number }) {
  const t = useT(text);
  const steps: { key: string; label: string; phase?: string; state: StepState }[] = [
    { key: "@draft", label: t.draft, state: "done" },
    ...d.gates.map((g) => ({ key: g.gateId, label: g.name, phase: g.phase, state: stepOf(g, d) })),
    { key: "@baseline", label: t.baseline(d.baseVersion + 1), state: d.status === "approved" ? "done" : "todo" },
  ];
  const notes = d.gates.filter((g) => g.note);
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border bg-card px-4 py-3.5 text-card-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex h-5.5 items-center rounded-full bg-secondary px-2 font-mono text-xs text-secondary-foreground">
          {d.docType}
        </span>
        <h2 className="m-0 text-base font-semibold">{d.docTitle}</h2>
        <span className="font-mono text-[12.5px] text-muted-foreground">
          {d.baseVersion ? `v${d.baseVersion}` : t.newDoc} → v{d.baseVersion + 1}
        </span>
        <span className="flex-1" />
        {d.status === "in_review" ? <SlaBadge gate={d.gate} now={now} long /> : <StatusPill status={d.status} />}
      </div>
      <p className="m-0 text-xs text-muted-foreground">
        <span className="font-mono">{d.docKey}</span> · {d.workflowName} · {t.author}: {d.author.name}
      </p>
      <ol aria-label={t.steps} className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0 text-[12.5px]">
        {steps.map((s, i) => {
          const newPhase = s.phase && s.phase !== steps[i - 1]?.phase;
          return (
            <li
              key={s.key}
              aria-current={s.state === "current" ? "step" : undefined}
              className="inline-flex items-center gap-1.5"
            >
              {i > 0 && (
                <span aria-hidden="true" className="text-muted-foreground">
                  →
                </span>
              )}
              {newPhase && <span className="font-mono text-[11px] text-muted-foreground">{s.phase}</span>}
              <span className={cn("inline-flex h-6 items-center gap-1 rounded-full px-2.5", STEP_STYLE[s.state])}>
                <span aria-hidden="true">{STEP_MARK[s.state]}</span>
                {s.label}
                <span className="sr-only">: {t.stepState[s.state]}</span>
              </span>
            </li>
          );
        })}
      </ol>
      {d.reason && (
        <p className="m-0 text-[13px]">
          <span className="text-muted-foreground">{t.reason}:</span> {d.reason}
        </p>
      )}
      {notes.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-dashed border-input pt-2 text-[13px]">
          <span className="text-xs text-muted-foreground">{t.notes}</span>
          {notes.map((g) => (
            <p key={g.gateId} className="m-0">
              <strong className="font-medium">{g.name}</strong>
              {g.decidedBy && <span className="text-muted-foreground"> · {g.decidedBy}</span>}: {g.note}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function DiffCard({ d }: { d: ReviewDetail }) {
  const t = useT(text);
  const blocks = useMemo(() => diffBlocks(lineDiff(d.baseContent, d.content), 3), [d.baseContent, d.content]);
  const changed = blocks.some((b) => b.kind === "lines");
  return (
    <Card
      title={t.changes}
      meta={<span className="text-[12.5px] text-muted-foreground">{t.changesMeta(d.addedLines, d.deletedLines)}</span>}
    >
      <div className="py-2 text-[13.5px] leading-[1.7]">
        {!changed && <p className="m-0 px-4.5 py-2 text-muted-foreground">{t.noChanges}</p>}
        {changed &&
          blocks.map((b, bi) =>
            b.kind === "gap" ? (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: khối diff không có mã; vị trí là định danh.
                key={bi}
                className="my-1 bg-muted/60 px-4.5 py-0.5 font-mono text-[11.5px] text-muted-foreground"
              >
                ⋯ {t.unchanged(b.count)}
              </div>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: khối diff không có mã; vị trí là định danh.
              <div key={bi}>
                {b.lines.map((l) => (
                  <div
                    key={`${l.oldNo ?? ""}:${l.newNo ?? ""}`}
                    data-diff={l.kind}
                    className={cn(
                      "flex gap-2 border-l-3 px-4 whitespace-pre-wrap break-words",
                      l.kind === "added" && "border-success bg-success-soft text-success",
                      l.kind === "removed" &&
                        "border-destructive bg-destructive-soft text-destructive line-through decoration-destructive/50",
                      l.kind === "same" && "border-transparent",
                    )}
                  >
                    <span aria-hidden="true" className="w-3 flex-none font-mono text-xs leading-[1.9] select-none">
                      {l.kind === "added" ? "+" : l.kind === "removed" ? "−" : ""}
                    </span>
                    <span className="min-w-0 flex-1">
                      {l.kind !== "same" && (
                        <span className="sr-only">{l.kind === "added" ? t.addedLine : t.removedLine}</span>
                      )}
                      {l.text || " "}
                    </span>
                  </div>
                ))}
              </div>
            ),
          )}
      </div>
    </Card>
  );
}

function ChecklistCard({ gate }: { gate: GateRun }) {
  const t = useT(text);
  const lang = useLang();
  const fmt = useFormat(lang);
  return (
    <Card
      title={`${gate.kind === "ai" ? t.aiCheck : t.ruleCheck} · ${gate.name}`}
      meta={
        gate.score !== null && (
          <Pill tone={gate.status === "passed" ? "ok" : gate.status === "failed" ? "bad" : "warn"}>
            {fmt.score(gate.score)} / 10
          </Pill>
        )
      }
    >
      <ul className="m-0 flex list-none flex-col gap-2 px-4 py-2.5 text-[13.5px]">
        {gate.checklist.map((c: ChecklistItem) => (
          <li key={c.label} className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className={cn(
                "inline-flex size-4.5 flex-none items-center justify-center rounded-full text-[11px]",
                c.passed ? "bg-success-soft text-success" : "bg-warning-soft text-warning",
              )}
            >
              {c.passed ? "✓" : "!"}
            </span>
            <span>
              <span className="sr-only">{c.passed ? "✓ " : "! "}</span>
              {c.label}
              {c.note && <span className="block text-xs text-muted-foreground">{c.note}</span>}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function TraceCard({ d }: { d: ReviewDetail }) {
  const t = useT(text);
  const covered = d.trace.filter((r) => r.acceptance.length > 0).length;
  return (
    <Card
      title={t.trace}
      meta={
        d.trace.length > 0 && (
          <span className="font-mono text-[12.5px] text-muted-foreground">
            {covered} / {d.trace.length}
          </span>
        )
      }
    >
      {d.trace.length === 0 ? (
        <p className="m-0 px-4 py-2.5 text-[13px] text-muted-foreground">{t.noTrace}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">{t.traceReq}</th>
                <th className="px-2 py-2 font-medium">{t.traceAc}</th>
                <th className="px-4 py-2 pl-2 font-medium">{t.traceTasks}</th>
              </tr>
            </thead>
            <tbody>
              {d.trace.map((r) => (
                <tr key={r.id} className="border-t align-top">
                  <td className="px-4 py-2">
                    <span className="font-mono font-medium">{r.id}</span>
                    <span className="block text-xs text-muted-foreground">{r.text}</span>
                  </td>
                  <td className="px-2 py-2">
                    {r.acceptance.length ? (
                      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                        {r.acceptance.map((a) => (
                          <li key={a}>☑ {a}</li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-warning">{t.noAc}</span>
                    )}
                  </td>
                  <td className="py-2 pr-4 pl-2">
                    {r.tasks.length ? (
                      <span className="flex flex-col gap-0.5">
                        {r.tasks.map((task) => (
                          <span
                            key={task.key}
                            className="font-mono text-xs whitespace-nowrap"
                            title={`${task.title} · ${task.status}`}
                          >
                            {task.key}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function DecisionCard({ d, onDecided }: { d: ReviewDetail; onDecided: () => void }) {
  const { api } = useOrg();
  const t = useT(text);
  const ids = useId();
  const queryClient = useQueryClient();
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [note, setNote] = useState("");
  // Mặc định theo cấu hình của checkpoint; "về checkpoint trước" chỉ khi có checkpoint người duyệt phía trước.
  const [route, setRoute] = useState<RejectRoute>(() => {
    const configured = d.currentGate?.onReject ?? "author";
    return configured === "previous" && !d.previousGate ? "author" : configured;
  });
  const [noteMissing, setNoteMissing] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const prevName = d.gates.find((g) => g.gateId === d.previousGate)?.name ?? "";
  const routes = t.route(prevName);
  const current = d.gates.find((g) => g.gateId === d.gate?.id);
  const decide = useMutation({
    mutationFn: (decision: "approve" | "changes") =>
      api.reviews.decide.call({
        id: d.id,
        decision,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(decision === "changes" ? { route } : {}),
      }),
    onSuccess: (next, decision) => {
      queryClient.setQueryData(api.reviews.get.queryKey({ input: { id: d.id } }), next);
      void queryClient.invalidateQueries({ queryKey: api.reviews.list.key() });
      onDecided();
      setNote("");
      setDone(
        decision === "changes"
          ? t.returnedMsg(routes[route])
          : next.status === "approved"
            ? t.baselinedMsg(next.baseVersion + 1)
            : t.approvedMsg,
      );
    },
  });

  function requestChanges() {
    if (!note.trim()) {
      setNoteMissing(true);
      noteRef.current?.focus();
      return;
    }
    decide.mutate("changes");
  }

  return (
    <section
      aria-label={t.decision}
      className="flex flex-col gap-2.5 rounded-xl border bg-card px-4 py-3.5 text-card-foreground"
    >
      <h2 className="m-0 text-[14.5px] font-semibold">{t.decision}</h2>
      {done && (
        <p role="status" className="m-0 text-sm text-success">
          {done}
        </p>
      )}
      {d.currentGate?.kind === "human" && d.currentGate.reviewers ? (
        <Assigned reviewers={d.currentGate.reviewers} approvals={current?.approvals ?? []} />
      ) : (
        current &&
        current.approvals.length > 0 && (
          <p className="m-0 text-xs text-muted-foreground">
            {t.approvedBy(current.approvals.map((a) => a.name).join(", "))}
          </p>
        )
      )}
      {d.canDecide ? (
        <>
          <Textarea
            ref={noteRef}
            aria-label={t.note}
            placeholder={t.note}
            maxLength={4000}
            className="min-h-18"
            value={note}
            aria-invalid={noteMissing && !note.trim()}
            aria-describedby={noteMissing ? `${ids}-err` : undefined}
            disabled={decide.isPending}
            onChange={(e) => {
              setNote(e.target.value);
              setNoteMissing(false);
            }}
          />
          {noteMissing && (
            <p id={`${ids}-err`} role="alert" className="m-0 text-xs text-destructive">
              {t.noteRequired}
            </p>
          )}
          <div className="flex flex-col gap-1.5 text-[13px] font-medium">
            <label htmlFor={`${ids}-route`}>{t.ifReturn}</label>
            <NativeSelect
              id={`${ids}-route`}
              value={route}
              disabled={decide.isPending}
              onChange={(e) => setRoute(e.target.value as RejectRoute)}
            >
              <option value="author">{routes.author}</option>
              <option value="agent">{routes.agent}</option>
              {d.previousGate && <option value="previous">{routes.previous}</option>}
            </NativeSelect>
          </div>
          {decide.isError && <Alert variant="destructive">{apiErrorMessage(decide.error)}</Alert>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="destructive" disabled={decide.isPending} onClick={requestChanges}>
              {t.requestChanges}
            </Button>
            <Button disabled={decide.isPending} onClick={() => decide.mutate("approve")}>
              {decide.isPending ? t.sending : t.approve}
            </Button>
          </div>
        </>
      ) : (
        !done && (
          <p className="m-0 text-[13px] text-muted-foreground">
            {d.status === "in_review" ? t.notYours(d.gate?.name ?? "") : t.finalText[d.status]}
          </p>
        )
      )}
    </section>
  );
}

/** Người được chỉ định ở checkpoint đang chờ (vai trò, đội, người) và số người đã duyệt so với số cần. */
function Assigned({
  reviewers,
  approvals,
}: {
  reviewers: NonNullable<NonNullable<ReviewDetail["currentGate"]>["reviewers"]>;
  approvals: GateRun["approvals"];
}) {
  const { api } = useOrg();
  const t = useT(text);
  const lang = useLang();
  const members = useQuery(api.orgMembers.list.queryOptions());
  const teams = useQuery(api.teams.list.queryOptions());
  const memberName = new Map((members.data ?? []).map((m) => [m.userId, m.name]));
  const teamName = new Map((teams.data ?? []).map((team) => [team.id, team.name]));
  const who = [
    ...reviewers.roles.map((role) => ROLE_LABEL[lang][role]),
    ...reviewers.teams.map((id) => `${t.teamPrefix} ${teamName.get(id) ?? id}`),
    ...reviewers.users.map((id) => memberName.get(id) ?? id),
  ];
  const n = approvals.length;
  const progress = reviewers.quorum === 0 ? t.progressAll(n) : t.progress(n, reviewers.quorum);
  return (
    <div className="flex flex-col gap-0.5 text-[13px]">
      <p className="m-0">
        <span className="text-muted-foreground">{t.assigned}: </span>
        {who.join(", ")}
      </p>
      <p className="m-0 text-xs text-muted-foreground">
        {progress}
        {n > 0 && `: ${approvals.map((a) => a.name).join(", ")}`}
      </p>
    </div>
  );
}
