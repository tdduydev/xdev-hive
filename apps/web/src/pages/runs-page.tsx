import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type Project, RUN_STATUS_GROUPS, type RunListItem, type RunState } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Pill } from "@xdev-hive/ui/pill";
import { useState } from "react";
import { type ActiveFilter, type Column, DataTable } from "@/components/data-table/data-table.tsx";
import type { Facet } from "@/components/data-table/model.ts";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { formatDayTime, formatUsd } from "@/lib/format.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { RUN_FILTERS, type RunsSearch, searchInput, validateRunsSearch } from "@/lib/run-list.ts";
import { CLI_LABEL, canCancel, prLabel, RUN_STATE_LABEL, runStateTone, shortId } from "@/lib/run-view.ts";
import { useNow } from "@/lib/use-now.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const REFRESH_MS = 30_000;
const text: Dict<{
  title: string;
  lead: string;
  search: string;
  task: string;
  status: string;
  project: string;
  machine: string;
  started: string;
  duration: string;
  cost: string;
  type: string;
  loading: string;
  more: string;
  loaded: string;
  loadedScope: string;
  running: string;
  waiting: string;
  cancel: string;
  cancelTitle: string;
  cancelDescription: string;
  keep: string;
  cancelling: string;
  empty: string;
  emptyLead: string;
  board: string;
  anyCli: string;
  unassigned: string;
  crossReview: string;
  kinds: Record<RunListItem["kind"], string>;
  states: Record<RunState, string>;
  groups: Record<string, string>;
  missingProject: (key: string) => string;
  open: (row: RunListItem) => string;
}> = {
  vi: {
    title: "Lượt chạy",
    lead: "Mọi lần agent nhận việc, trên mọi máy của tổ chức.",
    search: "Tìm theo mã run, việc, tiêu đề…",
    task: "Việc",
    status: "Trạng thái",
    project: "Dự án",
    machine: "Máy",
    started: "Bắt đầu",
    duration: "Thời lượng",
    cost: "Chi phí",
    type: "Loại run",
    loading: "Đang tải…",
    more: "Xem thêm",
    loaded: "run đã tải",
    loadedScope: "Tìm, lọc và sắp xếp trong các run đã tải. Xem thêm để tải các run cũ hơn.",
    running: "đang chạy",
    waiting: "chờ người",
    cancel: "Huỷ run",
    cancelTitle: "Huỷ các run đã chọn?",
    cancelDescription:
      "Máy đang chạy sẽ dừng agent và gỡ worktree. Việc quay về trạng thái chưa giao; giao lại sẽ tạo run mới.",
    keep: "Không huỷ",
    cancelling: "Đang huỷ…",
    empty: "Chưa có lượt chạy nào",
    emptyLead: "Mỗi lần giao việc cho agent là một lượt chạy. Giao việc từ",
    board: "Bảng việc",
    anyCli: "CLI bất kỳ",
    unassigned: "Chưa có máy",
    crossReview: "review chéo",
    kinds: {
      code: "Viết code",
      review: "Review chéo",
      plan: "Kế hoạch",
      leader: "Leader",
      doccheck: "Kiểm tài liệu",
      docassist: "Trợ lý tài liệu",
    },
    states: RUN_STATE_LABEL,
    groups: Object.fromEntries(RUN_FILTERS.map((filter) => [filter.key, filter.label])),
    missingProject: (key) => `Không tìm thấy dự án ${key}, hoặc bạn không ở trong đội sở hữu dự án.`,
    open: (row) => `Mở run ${shortId(row.id)} của ${row.taskKey}`,
  },
  en: {
    title: "Runs",
    lead: "Every time an agent picks up a task, on every machine in the organization.",
    search: "Search run, task or title…",
    task: "Task",
    status: "Status",
    project: "Project",
    machine: "Machine",
    started: "Started",
    duration: "Duration",
    cost: "Cost",
    type: "Run type",
    loading: "Loading…",
    more: "Load more",
    loaded: "runs loaded",
    loadedScope: "Search, filter and sort the loaded runs. Load more to include older runs.",
    running: "running",
    waiting: "need you",
    cancel: "Cancel runs",
    cancelTitle: "Cancel the selected runs?",
    cancelDescription:
      "The machine will stop the agent and remove the worktree. Tasks become unassigned; assigning them again creates new runs.",
    keep: "Keep running",
    cancelling: "Cancelling…",
    empty: "No runs yet",
    emptyLead: "Each task assigned to an agent creates a run. Assign work from the",
    board: "Board",
    anyCli: "Any CLI",
    unassigned: "Unassigned",
    crossReview: "cross-review",
    kinds: {
      code: "Coding",
      review: "Cross-review",
      plan: "Plan",
      leader: "Leader",
      doccheck: "Doc check",
      docassist: "Doc assistant",
    },
    states: {
      queued: "Queued",
      planning: "Planning",
      awaiting_plan: "Plan awaiting review",
      leased: "Leased",
      preparing: "Preparing",
      running: "Running",
      awaiting_input: "Awaiting input",
      verifying: "Verifying",
      succeeded: "Succeeded",
      no_changes: "No changes",
      needs_review: "Needs review",
      failed: "Failed",
      lost: "Machine lost",
      cancelling: "Cancelling",
      cancelled: "Cancelled",
    },
    groups: {
      all: "All",
      active: "Running",
      waiting: "Needs review",
      succeeded: "Succeeded",
      failed: "Failed",
      cancelled: "Cancelled",
    },
    missingProject: (key) => `Project ${key} was not found, or you are not in its team.`,
    open: (row) => `Open run ${shortId(row.id)} for ${row.taskKey}`,
  },
};

export function RunsPage() {
  const t = useT(text);
  const lang = useLang();
  const { org, api } = useOrg();
  const search = useSearch({ from: "/session/app/in-org/runs" });
  const navigate = useNavigate({ from: "/runs" });
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const project = search.project ? projects.data?.find((item) => item.key === search.project) : undefined;
  const waitProject = search.project !== undefined && project === undefined;
  const input = searchInput(search, project?.id);
  const runs = useInfiniteQuery(
    api.runs.search.infiniteOptions({
      input: (cursor: string | undefined) => ({ ...input, ...(cursor ? { cursor } : {}) }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      enabled: !waitProject,
      refetchInterval: REFRESH_MS,
    }),
  );
  const now = useNow(REFRESH_MS);
  const items = [
    ...new Map((runs.data?.pages.flatMap((page) => page.items) ?? []).map((row) => [row.id, row])).values(),
  ];
  const projectOf = new Map((projects.data ?? []).map((item) => [item.id, item]));
  const machineOf = new Map((runs.data?.pages[0]?.machines ?? []).map((machine) => [machine.id, machine.name]));
  const clearScope = (key: keyof RunsSearch) =>
    navigate({ search: (prev) => validateRunsSearch({ ...prev, [key]: undefined }), replace: true });
  const scopeLabels = { status: t.status, project: t.project, cli: "Agent", machine: t.machine };
  const scopeValues = {
    status: t.groups[search.status ?? ""],
    project: project?.name ?? search.project,
    cli: CLI_LABEL[search.cli ?? ""],
    machine: machineOf.get(search.machine ?? "") ?? search.machine,
  };
  const activeFilters: ActiveFilter[] = (Object.keys(scopeLabels) as (keyof RunsSearch)[])
    .filter((key) => search[key])
    .map((key) => ({
      key: `scope-${key}`,
      label: scopeLabels[key],
      values: scopeValues[key] ?? search[key] ?? "",
      clear: () => clearScope(key),
    }));
  const columns: Column<RunListItem>[] = [
    {
      key: "run",
      label: "Run",
      value: (row) => row.id,
      sortable: true,
      cell: (row) => (
        <Link
          to="/runs/$id"
          params={{ id: row.id }}
          className="font-mono text-xs text-primary hover:underline"
          aria-label={t.open(row)}
        >
          {shortId(row.id)}
        </Link>
      ),
    },
    {
      key: "title",
      label: t.task,
      value: (row) => `${row.taskTitle} ${row.taskKey} ${projectOf.get(row.projectId)?.name ?? ""}`,
      sortable: true,
      className: "min-w-64",
      cell: (row) => (
        <div className="grid gap-0.5">
          <span className="font-medium">{row.taskTitle}</span>
          <span className="font-mono text-xs text-muted-foreground">
            {row.taskKey} · {projectOf.get(row.projectId)?.name ?? shortId(row.projectId)}
            {row.kind === "review" ? ` · ${t.crossReview}` : ""}
          </span>
        </div>
      ),
    },
    {
      key: "status",
      label: t.status,
      value: (row) => t.states[row.state],
      cell: (row) => (
        <Pill tone={runStateTone(row.state)} dot>
          {t.states[row.state]}
        </Pill>
      ),
    },
    {
      key: "cli",
      label: "Agent",
      value: (row) => (row.cli ? (CLI_LABEL[row.cli] ?? row.cli) : t.anyCli),
      sortable: true,
    },
    {
      key: "machine",
      label: t.machine,
      value: (row) => row.machineName ?? t.unassigned,
      className: "font-mono text-xs whitespace-nowrap",
    },
    {
      key: "started",
      label: t.started,
      value: (row) => (row.startedAt ? Date.parse(row.startedAt) : null),
      sortable: true,
      className: "whitespace-nowrap text-muted-foreground",
      cell: (row) => (row.startedAt ? formatDayTime(row.startedAt) : "—"),
    },
    {
      key: "duration",
      label: t.duration,
      value: (row) =>
        row.startedAt
          ? Math.max(0, Date.parse(row.finishedAt ?? new Date(now).toISOString()) - Date.parse(row.startedAt))
          : null,
      sortable: true,
      className: "text-right font-mono text-xs whitespace-nowrap",
      cell: (row) =>
        row.startedAt
          ? `${Math.floor(Math.max(0, (row.finishedAt ? Date.parse(row.finishedAt) : now) - Date.parse(row.startedAt)) / 60_000)}m`
          : "—",
    },
    {
      key: "cost",
      label: t.cost,
      value: (row) => row.cost.costUsd,
      sortable: true,
      className: "text-right whitespace-nowrap tabular-nums",
      cell: (row) =>
        lang === "vi"
          ? formatUsd(row.cost.costUsd)
          : row.cost.costUsd === null
            ? "—"
            : `$${row.cost.costUsd.toFixed(2)}`,
    },
    {
      key: "pr",
      label: "PR",
      value: (row) => row.prUrl,
      className: "font-mono text-xs",
      cell: (row) =>
        row.prUrl ? (
          <a
            href={row.prUrl}
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline"
            aria-label={`PR ${row.taskKey} (${lang === "vi" ? "tab mới" : "new tab"})`}
          >
            {prLabel(row.prUrl)}
          </a>
        ) : (
          "—"
        ),
    },
  ];
  const facets: Facet<RunListItem>[] = [
    {
      key: "status",
      label: t.status,
      value: (row) => row.state,
      options: Object.entries(t.states).map(([value, label]) => ({ value, label })),
    },
    {
      key: "project",
      label: t.project,
      value: (row) => row.projectId,
      options: (projects.data ?? []).map((item: Project) => ({ value: item.id, label: item.name })),
    },
    {
      key: "cli",
      label: "Agent",
      value: (row) => row.cli ?? "any",
      options: [
        ...Object.entries(CLI_LABEL).map(([value, label]) => ({ value, label })),
        { value: "any", label: t.anyCli },
      ],
    },
    {
      key: "machine",
      label: t.machine,
      value: (row) => row.machineId ?? "unassigned",
      options: [
        ...[...machineOf].map(([value, label]) => ({ value, label })),
        { value: "unassigned", label: t.unassigned },
      ],
    },
    {
      key: "type",
      label: t.type,
      value: (row) => row.kind,
      options: Object.entries(t.kinds).map(([value, label]) => ({ value, label })),
    },
  ];
  const [cancelRows, setCancelRows] = useState<RunListItem[]>([]);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: async () => {
      const results = await Promise.allSettled(cancelRows.map((row) => api.runs.cancel.call({ id: row.id })));
      const failed = cancelRows.filter((_, index) => results[index]?.status === "rejected");
      setCancelRows(failed);
      setCancelError(
        results
          .flatMap((result, index) =>
            result.status === "rejected" ? [`${cancelRows[index]?.taskKey}: ${apiErrorMessage(result.reason)}`] : [],
          )
          .join("\n") || null,
      );
      await Promise.all(
        [api.runs.key(), api.tasks.key()].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    },
  });
  return (
    <>
      <PageHeader crumb={org.name} title={t.title} />
      <PageBody>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{t.lead}</p>
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
            <span>
              <strong className="font-mono text-foreground">
                {items.filter((row) => row.state === "running").length}
              </strong>{" "}
              {t.running}
            </span>
            <span>
              <strong className="font-mono text-foreground">
                {items.filter((row) => RUN_STATUS_GROUPS.waiting.includes(row.state)).length}
              </strong>{" "}
              {t.waiting}
            </span>
            <span>
              <strong className="font-mono text-foreground">{items.length}</strong> {t.loaded}
            </span>
          </div>
        </div>
        {search.project && projects.isSuccess && !project ? (
          <Alert variant="destructive">
            {t.missingProject(search.project)}
            <Button className="cursor-pointer" variant="ghost" size="sm" onClick={() => clearScope("project")}>
              {t.project} ×
            </Button>
          </Alert>
        ) : projects.isError && search.project ? (
          <Alert variant="destructive">{apiErrorMessage(projects.error)}</Alert>
        ) : runs.isPending ? (
          <p aria-busy="true" className="text-muted-foreground">
            {t.loading}
          </p>
        ) : !runs.data ? (
          <Alert variant="destructive">{apiErrorMessage(runs.error)}</Alert>
        ) : (
          <>
            {runs.hasNextPage && <p className="text-xs text-muted-foreground">{t.loadedScope}</p>}
            <DataTable
              key={JSON.stringify(search)}
              columns={columns}
              rows={items}
              facets={facets}
              caption={t.title}
              placeholder={t.search}
              activeFilters={activeFilters}
              rowLabel={(row) => row.taskKey}
              onRowClick={(row) => navigate({ to: "/runs/$id", params: { id: row.id } })}
              bulk={[
                {
                  key: "cancel",
                  label: t.cancel,
                  disabled: (rows) => rows.some((row) => !canCancel(row.state)),
                  onClick: (rows) => {
                    setCancelError(null);
                    setCancelRows(rows);
                  },
                },
              ]}
              emptyContent={
                <>
                  <h2 className="font-medium text-foreground">{t.empty}</h2>
                  <p>
                    {t.emptyLead}{" "}
                    <Link to="/tasks" className="text-primary hover:underline">
                      {t.board}
                    </Link>
                    .
                  </p>
                </>
              }
            />
            {runs.hasNextPage && (
              <div className="flex justify-center">
                <Button
                  className="cursor-pointer"
                  variant="outline"
                  onClick={() => runs.fetchNextPage()}
                  disabled={runs.isFetchingNextPage}
                >
                  {runs.isFetchingNextPage ? t.loading : t.more}
                </Button>
              </div>
            )}
            {runs.isFetchNextPageError && <Alert variant="destructive">{apiErrorMessage(runs.error)}</Alert>}
          </>
        )}
      </PageBody>
      <Dialog
        open={cancelRows.length > 0}
        onOpenChange={(open) => {
          if (!open && !cancel.isPending) setCancelRows([]);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogTitle>{t.cancelTitle}</DialogTitle>
          <DialogDescription>
            {cancelRows.map((row) => row.taskKey).join(", ")}. {t.cancelDescription}
          </DialogDescription>
          {cancelError && (
            <Alert variant="destructive" className="whitespace-pre-line">
              {cancelError}
            </Alert>
          )}
          <DialogActions>
            <Button
              className="cursor-pointer"
              variant="outline"
              disabled={cancel.isPending}
              onClick={() => setCancelRows([])}
            >
              {t.keep}
            </Button>
            <Button
              className="cursor-pointer"
              variant="destructive-solid"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              {cancel.isPending ? t.cancelling : t.cancel}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </>
  );
}
