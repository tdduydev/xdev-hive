import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { CostExplore, Project } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Table, Td, Th } from "@xdev-hive/ui/table";
import { CoinsIcon, FolderKanbanIcon } from "lucide-react";
import { useId, useState } from "react";
import { type Column, DataTable } from "@/components/data-table/data-table.tsx";
import { PageSection } from "@/components/page/page-section.tsx";
import { SegmentedControl } from "@/components/page/segmented-control.tsx";
import { SettingsSection } from "@/components/page/settings.tsx";
import { StatCard, StatGrid } from "@/components/page/stat-card.tsx";
import { UnsavedChangesGuard } from "@/components/page/unsaved-guard.tsx";
import { Card } from "@/components/ui/card.tsx";
import { DescriptionList } from "@/components/ui/description-list.tsx";
import { Field, FieldError, FieldLabel } from "@/components/ui/field.tsx";
import { EmptyState, LoadFailure, SectionsSkeleton, TableSkeleton } from "@/components/ui/query-state.tsx";
import { formError } from "@/lib/api-errors.ts";
import { cx } from "@/lib/cx.ts";
import { formatCacheHit, formatDayTime, formatInt, formatPercent, formatUsd } from "@/lib/format.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

type Period = 7 | 14 | 30;
type GroupBy = "cli" | "machine" | "task" | "account";

const PERIODS: readonly Period[] = [7, 14, 30];
const GROUPS: readonly GroupBy[] = ["cli", "machine", "task", "account"];

const text: Dict<{
  title: string;
  description: string;
  loading: string;
  project: string;
  period: string;
  periodOption: (days: number) => string;
  noProjects: string;
  noProjectsHint: string;
  createProject: string;
  totalCost: string;
  runs: string;
  tokens: string;
  tokensHint: (input: string, output: string) => string;
  cacheHit: string;
  cacheHitHint: string;
  periodHint: (days: number) => string;
  chartTitle: string;
  chartHint: string;
  chartLabel: (days: number) => string;
  chartTable: string;
  chartEmpty: string;
  day: string;
  cost: string;
  detailTitle: string;
  detailHint: string;
  groupBy: string;
  groupOptions: Record<GroupBy, string>;
  groupHead: Record<GroupBy, string>;
  noRuns: string;
  noRunsHint: string;
  tokensCol: string;
  unknown: string;
  defaultLogin: string;
  searchGroup: string;
  exploreTitle: string;
  exploreHint: string;
  exploreRuns: string;
  exploreRunsValue: (runs: string, edited: string) => string;
  exploreTurns: string;
  exploreTokens: string;
  exploreShare: string;
  exploreCost: string;
  stoppedTitle: string;
  stoppedHint: string;
  noStopped: string;
  noStoppedHint: string;
  task: string;
  reason: string;
  used: string;
  ceiling: string;
  stoppedAt: string;
  searchStopped: string;
  reasons: Record<"per_run_usd" | "per_task_usd" | "max_turns", string>;
  turnsValue: (n: string) => string;
  budgetTitle: string;
  budgetHint: string;
  perRun: string;
  perTask: string;
  maxTurns: string;
  turnsSuffix: string;
  unlimited: string;
  saveBudget: string;
  budgetInvalid: string;
}> = {
  vi: {
    title: "Chi phí và token",
    description: "Chi phí, token và ngân sách của từng dự án theo ngày; run vượt trần bị dừng ở đây.",
    loading: "Đang tải…",
    project: "Dự án",
    period: "Khoảng thời gian",
    periodOption: (days) => `${days} ngày`,
    noProjects: "Chưa có dự án để tổng hợp chi phí",
    noProjectsHint: "Chi phí được tổng hợp theo dự án. Tạo dự án và chạy việc đầu tiên thì số liệu hiện ở đây.",
    createProject: "Tạo dự án",
    totalCost: "Tổng chi phí đã báo",
    runs: "Run",
    tokens: "Token",
    tokensHint: (input, output) => `${input} vào · ${output} ra`,
    cacheHit: "Cache trúng",
    cacheHitHint: "Đọc cache ÷ (đọc + ghi cache + token vào)",
    periodHint: (days) => `${days} ngày gần nhất`,
    chartTitle: "Chi phí theo ngày",
    chartHint: "Ngày tính theo UTC. Chỉ CLI có báo cáo USD mới có số.",
    chartLabel: (days) => `Chi phí theo ngày trong ${days} ngày`,
    chartTable: "Xem dạng bảng",
    chartEmpty: "Không có dữ liệu biểu đồ.",
    day: "Ngày",
    cost: "Chi phí",
    detailTitle: "Chi tiết chi phí",
    detailHint: "Nhóm theo CLI, máy, việc hoặc gói.",
    groupBy: "Nhóm theo",
    groupOptions: { cli: "CLI", machine: "Máy", task: "Việc", account: "Gói" },
    groupHead: { cli: "CLI", machine: "Mã máy", task: "Mã việc", account: "Gói" },
    noRuns: "Chưa có run",
    noRunsHint: "Run của dự án trong khoảng thời gian này sẽ hiện ở đây.",
    tokensCol: "Token",
    unknown: "Chưa xác định",
    defaultLogin: "Đăng nhập mặc định",
    searchGroup: "Tìm trong nhóm…",
    exploreTitle: "Khảo sát trước khi sửa",
    exploreHint:
      "Phần agent đọc repo trước lần sửa file đầu tiên, tính trên run code có số đo (Claude). Tỉ lệ chi phí và USD là ước tính.",
    exploreRuns: "Run có số đo",
    exploreRunsValue: (runs, edited) => `${runs} (${edited} đã sửa file)`,
    exploreTurns: "Lượt",
    exploreTokens: "Token",
    exploreShare: "Tỉ lệ chi phí",
    exploreCost: "Chi phí khảo sát",
    stoppedTitle: "Run bị dừng vì vượt ngân sách",
    stoppedHint: "Giá trị đo được và trần tại thời điểm run kết thúc.",
    noStopped: "Chưa có run nào bị dừng",
    noStoppedHint: "Run vượt trần USD hoặc số lượt của dự án sẽ hiện ở đây.",
    task: "Việc",
    reason: "Lý do",
    used: "Đã dùng",
    ceiling: "Trần",
    stoppedAt: "Thời điểm",
    searchStopped: "Tìm việc…",
    reasons: { per_run_usd: "Vượt trần USD/run", per_task_usd: "Vượt trần USD/việc", max_turns: "Vượt số lượt" },
    turnsValue: (n) => `${n} lượt`,
    budgetTitle: "Ngân sách dự án",
    budgetHint: "Run vượt trần thì bị dừng. Để trống ô nào thì ô đó không giới hạn.",
    perRun: "USD mỗi run",
    perTask: "USD mỗi việc",
    maxTurns: "Lượt agent tối đa",
    turnsSuffix: "lượt",
    unlimited: "Không giới hạn",
    saveBudget: "Lưu ngân sách",
    budgetInvalid: "Giá trị ngân sách nằm ngoài giới hạn cho phép.",
  },
  en: {
    title: "Costs & tokens",
    description: "Cost, tokens and budget of each project by day; runs that exceed a ceiling stop here.",
    loading: "Loading…",
    project: "Project",
    period: "Period",
    periodOption: (days) => `${days} days`,
    noProjects: "No project to summarise costs for",
    noProjectsHint: "Costs are summarised per project. Create a project and run a task to see figures here.",
    createProject: "Create project",
    totalCost: "Reported cost",
    runs: "Runs",
    tokens: "Tokens",
    tokensHint: (input, output) => `${input} in · ${output} out`,
    cacheHit: "Cache hit",
    cacheHitHint: "Cache read ÷ (read + cache write + input tokens)",
    periodHint: (days) => `Last ${days} days`,
    chartTitle: "Cost by day",
    chartHint: "Days are in UTC. Only CLIs that report USD have figures.",
    chartLabel: (days) => `Cost by day over ${days} days`,
    chartTable: "Show as table",
    chartEmpty: "No chart data.",
    day: "Day",
    cost: "Cost",
    detailTitle: "Cost breakdown",
    detailHint: "Grouped by CLI, machine, task or plan.",
    groupBy: "Group by",
    groupOptions: { cli: "CLI", machine: "Machine", task: "Task", account: "Plan" },
    groupHead: { cli: "CLI", machine: "Machine ID", task: "Task key", account: "Plan" },
    noRuns: "No runs yet",
    noRunsHint: "Runs of the project in this period will appear here.",
    tokensCol: "Tokens",
    unknown: "Unknown",
    defaultLogin: "Default login",
    searchGroup: "Search groups…",
    exploreTitle: "Exploration before editing",
    exploreHint:
      "What the agent spends reading the repo before its first file edit, over code runs with measurements (Claude). Cost share and USD are estimates.",
    exploreRuns: "Measured runs",
    exploreRunsValue: (runs, edited) => `${runs} (${edited} edited files)`,
    exploreTurns: "Turns",
    exploreTokens: "Tokens",
    exploreShare: "Cost share",
    exploreCost: "Exploration cost",
    stoppedTitle: "Runs stopped by budget",
    stoppedHint: "Measured value and ceiling when the run ended.",
    noStopped: "No run stopped",
    noStoppedHint: "Runs that exceed the project USD or turn ceiling will appear here.",
    task: "Task",
    reason: "Reason",
    used: "Used",
    ceiling: "Ceiling",
    stoppedAt: "Time",
    searchStopped: "Search tasks…",
    reasons: { per_run_usd: "Over USD per run", per_task_usd: "Over USD per task", max_turns: "Over turn limit" },
    turnsValue: (n) => `${n} turns`,
    budgetTitle: "Project budget",
    budgetHint: "Runs that exceed a ceiling are stopped. Leave a field empty for no limit.",
    perRun: "USD per run",
    perTask: "USD per task",
    maxTurns: "Max agent turns",
    turnsSuffix: "turns",
    unlimited: "No limit",
    saveBudget: "Save budget",
    budgetInvalid: "A budget value is outside the allowed range.",
  },
};

function utcDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function datesFor(period: Period) {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (period - 1));
  return { from: utcDate(start), to: utcDate(end) };
}

/** "2026-10-11" thành "11/10" (hoặc "11/10/2026"): ngày của hub là UTC, không qua múi giờ của máy xem. */
function dayLabel(key: string, withYear = false) {
  const [year, month, day] = key.split("-");
  return withYear ? `${day}/${month}/${year}` : `${day}/${month}`;
}

export function CostsPage() {
  const t = useT(text);
  const { api } = useOrg();
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const [projectId, setProjectId] = useState("");
  const [period, setPeriod] = useState<Period>(14);
  const project = projects.data?.find((item) => item.id === projectId) ?? projects.data?.[0];

  return (
    <>
      <PageHeader title={t.title} description={t.description}>
        {projects.data && projects.data.length > 0 && project && (
          <>
            {projects.data.length > 1 && (
              <NativeSelect
                aria-label={t.project}
                value={project.id}
                onChange={(event) => setProjectId(event.target.value)}
                className="w-auto max-w-56"
              >
                {projects.data.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.key}
                  </option>
                ))}
              </NativeSelect>
            )}
            <SegmentedControl
              label={t.period}
              value={String(period)}
              onChange={(value) => setPeriod(Number(value) as Period)}
              options={PERIODS.map((days) => ({ value: String(days), label: t.periodOption(days) }))}
            />
          </>
        )}
      </PageHeader>
      <PageBody>
        {projects.isPending ? (
          <SectionsSkeleton label={t.loading} />
        ) : projects.isError ? (
          <LoadFailure error={projects.error} retry={projects.refetch} />
        ) : projects.data.length === 0 || !project ? (
          <EmptyState
            icon={FolderKanbanIcon}
            title={t.noProjects}
            description={t.noProjectsHint}
            action={
              <Button variant="default" render={<Link to="/projects" />}>
                {t.createProject}
              </Button>
            }
          />
        ) : (
          <CostsOf key={project.id} project={project} period={period} />
        )}
      </PageBody>
    </>
  );
}

function CostsOf({ project, period }: { project: Project; period: Period }) {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const [groupBy, setGroupBy] = useState<GroupBy>("cli");
  const range = datesFor(period);
  const summaryInput = { projectId: project.id, ...range };
  // Đổi khoảng thời gian hay cách nhóm thì giữ số cũ trên màn hình tới khi số mới về, không nháy lại khung xương.
  const daily = useQuery({
    ...api.costs.summary.queryOptions({ input: { ...summaryInput, groupBy: "day" } }),
    placeholderData: keepPreviousData,
  });
  const grouped = useQuery({
    ...api.costs.summary.queryOptions({ input: { ...summaryInput, groupBy } }),
    placeholderData: keepPreviousData,
  });
  const stopped = useQuery(api.costs.budgetStopped.queryOptions({ input: { projectId: project.id } }));

  if (daily.isPending) return <SectionsSkeleton label={t.loading} />;
  if (daily.isError) return <LoadFailure error={daily.error} retry={daily.refetch} />;

  const total = daily.data.total;
  const chart = Array.from({ length: period }, (_, index) => {
    const date = new Date(`${range.from}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + index);
    const key = utcDate(date);
    return { key, value: daily.data.groups.find((group) => group.key === key)?.costUsd ?? 0 };
  });

  return (
    <>
      <StatGrid columns={4}>
        <StatCard icon={CoinsIcon} label={t.totalCost} value={formatUsd(total.costUsd)} hint={t.periodHint(period)} />
        <StatCard label={t.runs} value={formatInt(total.runs)} hint={t.periodHint(period)} />
        <StatCard
          label={t.tokens}
          value={formatInt(total.tokensIn + total.tokensOut)}
          hint={t.tokensHint(formatInt(total.tokensIn), formatInt(total.tokensOut))}
        />
        <StatCard
          label={t.cacheHit}
          value={formatCacheHit(total.cacheRead, total.cacheWrite, total.tokensIn)}
          hint={t.cacheHitHint}
        />
      </StatGrid>

      <PageSection title={t.chartTitle} description={t.chartHint}>
        <Card className="grid gap-3 p-4">
          <CostChart points={chart} />
        </Card>
      </PageSection>

      <PageSection
        title={t.detailTitle}
        description={t.detailHint}
        actions={
          <SegmentedControl
            label={t.groupBy}
            value={groupBy}
            onChange={setGroupBy}
            options={GROUPS.map((group) => ({ value: group, label: t.groupOptions[group] }))}
          />
        }
      >
        {grouped.isPending ? (
          <TableSkeleton label={t.loading} columns={5} rows={3} />
        ) : grouped.isError ? (
          <LoadFailure error={grouped.error} retry={grouped.refetch} />
        ) : (
          <GroupTable groups={grouped.data.groups} groupBy={groupBy} />
        )}
      </PageSection>

      {daily.data.explore && <ExploreSection explore={daily.data.explore} />}

      <PageSection title={t.stoppedTitle} description={t.stoppedHint}>
        {stopped.isPending ? (
          <TableSkeleton label={t.loading} columns={5} rows={3} />
        ) : stopped.isError ? (
          <LoadFailure error={stopped.error} retry={stopped.refetch} />
        ) : (
          <StoppedTable runs={stopped.data} />
        )}
      </PageSection>

      <BudgetForm
        project={project}
        onSaved={() => queryClient.invalidateQueries({ queryKey: api.projects.list.key() })}
      />
    </>
  );
}

type Group = {
  id: string;
  key: string | null;
  runs: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
};

function GroupTable({ groups, groupBy }: { groups: ReadonlyArray<Omit<Group, "id">>; groupBy: GroupBy }) {
  const t = useT(text);
  const rows: Group[] = groups.map((group) => ({ ...group, id: group.key ?? "unknown" }));
  const name = (group: Group) => group.key ?? (groupBy === "account" ? t.defaultLogin : t.unknown);
  const columns: Column<Group>[] = [
    {
      key: "name",
      label: t.groupHead[groupBy],
      value: name,
      cell: name,
      sortable: true,
      hideable: false,
      pin: "start",
    },
    { key: "runs", label: t.runs, value: (g) => g.runs, cell: (g) => formatInt(g.runs), sortable: true, align: "end" },
    {
      key: "tokens",
      label: t.tokensCol,
      value: (g) => g.tokensIn + g.tokensOut,
      cell: (g) => formatInt(g.tokensIn + g.tokensOut),
      sortable: true,
      align: "end",
    },
    {
      key: "cache",
      label: t.cacheHit,
      value: (g) => formatCacheHit(g.cacheRead, g.cacheWrite, g.tokensIn),
      cell: (g) => formatCacheHit(g.cacheRead, g.cacheWrite, g.tokensIn),
      align: "end",
    },
    {
      key: "cost",
      label: t.cost,
      value: (g) => g.costUsd,
      cell: (g) => formatUsd(g.costUsd),
      sortable: true,
      align: "end",
    },
  ];
  if (rows.length === 0) return <EmptyState compact icon={CoinsIcon} title={t.noRuns} description={t.noRunsHint} />;
  return (
    <DataTable
      columns={columns}
      rows={rows}
      selectable={false}
      minWidth={560}
      placeholder={t.searchGroup}
      caption={t.detailTitle}
    />
  );
}

type Stopped = {
  id: string;
  runId: string;
  taskKey: string;
  taskTitle: string;
  reason: "per_run_usd" | "per_task_usd" | "max_turns";
  measured: number;
  limit: number;
  stoppedAt: string;
};

function StoppedTable({ runs }: { runs: ReadonlyArray<Omit<Stopped, "id">> }) {
  const t = useT(text);
  if (runs.length === 0)
    return <EmptyState compact icon={CoinsIcon} title={t.noStopped} description={t.noStoppedHint} />;
  const rows: Stopped[] = runs.map((run) => ({ ...run, id: `${run.runId}-${run.reason}` }));
  const amount = (run: Stopped, value: number) =>
    run.reason === "max_turns" ? t.turnsValue(formatInt(value)) : formatUsd(value);
  const columns: Column<Stopped>[] = [
    {
      key: "task",
      label: t.task,
      value: (r) => `${r.taskKey} ${r.taskTitle}`,
      cell: (r) => (
        <>
          <span className="font-mono text-xs">{r.taskKey}</span>
          <span className="block text-xs text-muted-foreground">{r.taskTitle}</span>
        </>
      ),
      hideable: false,
      pin: "start",
    },
    { key: "reason", label: t.reason, value: (r) => t.reasons[r.reason], cell: (r) => t.reasons[r.reason] },
    {
      key: "used",
      label: t.used,
      value: (r) => r.measured,
      cell: (r) => amount(r, r.measured),
      align: "end",
      sortable: true,
    },
    {
      key: "limit",
      label: t.ceiling,
      value: (r) => r.limit,
      cell: (r) => amount(r, r.limit),
      align: "end",
      sortable: true,
    },
    {
      key: "at",
      label: t.stoppedAt,
      value: (r) => r.stoppedAt,
      cell: (r) => <span title={r.stoppedAt}>{formatDayTime(r.stoppedAt)}</span>,
      sortable: true,
      align: "end",
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      selectable={false}
      minWidth={640}
      placeholder={t.searchStopped}
      caption={t.stoppedTitle}
    />
  );
}

/** Phần chi phí run code dành cho đọc repo trước lần sửa đầu tiên; số chia là tỉ lệ trên tổng của các run có số đo. */
function ExploreSection({ explore }: { explore: CostExplore }) {
  const t = useT(text);
  const share = (part: number, total: number) => formatPercent(total > 0 ? part / total : 0);
  return (
    <PageSection title={t.exploreTitle} description={t.exploreHint}>
      <Card className="max-w-xl px-4 py-3.5">
        <DescriptionList
          alignEnd
          items={[
            { term: t.exploreRuns, detail: t.exploreRunsValue(formatInt(explore.runs), formatInt(explore.edited)) },
            {
              term: t.exploreTurns,
              detail: `${formatInt(explore.turns)} · ${share(explore.turns, explore.totalTurns)}`,
            },
            {
              term: t.exploreTokens,
              detail: `${formatInt(explore.tokens)} · ${share(explore.tokens, explore.totalTokens)}`,
            },
            { term: t.exploreShare, detail: formatPercent(explore.costShare) },
            { term: t.exploreCost, detail: formatUsd(explore.costUsd) },
          ]}
        />
      </Card>
    </PageSection>
  );
}

/**
 * Cột theo ngày có trục giá trị và bảng thay thế (theo skill dataviz): thanh một màu vì chỉ có một chuỗi, giá trị
 * đọc được qua trục và `title`, người dùng trình đọc màn hình đọc bảng.
 */
function CostChart({ points }: { points: Array<{ key: string; value: number }> }) {
  const t = useT(text);
  if (!points.length) return <p className="text-muted-foreground">{t.chartEmpty}</p>;
  const max = Math.max(...points.map((point) => point.value), 0.01);
  return (
    <div className="grid gap-2">
      <div role="img" aria-label={t.chartLabel(points.length)} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
        <div className="flex h-44 flex-col justify-between text-right text-xs text-muted-foreground tabular-nums">
          <span>{formatUsd(max)}</span>
          <span>{formatUsd(max / 2)}</span>
          <span>{formatUsd(0)}</span>
        </div>
        <div className="relative h-44 border-b border-border">
          <span aria-hidden="true" className="absolute inset-x-0 top-0 border-t border-dashed border-border" />
          <span aria-hidden="true" className="absolute inset-x-0 top-1/2 border-t border-dashed border-border" />
          <div className="absolute inset-0 flex items-end gap-[3px]">
            {points.map((point) => (
              <div
                key={point.key}
                title={`${dayLabel(point.key, true)}: ${formatUsd(point.value)}`}
                className={cx("min-w-px flex-1 rounded-t-sm", point.value === 0 ? "bg-border" : "bg-primary")}
                style={{ height: point.value === 0 ? "1px" : `max(2px, ${(point.value / max) * 100}%)` }}
              />
            ))}
          </div>
        </div>
        <span />
        <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
          <span>{dayLabel(points[0]?.key ?? "")}</span>
          <span>{dayLabel(points.at(-1)?.key ?? "")}</span>
        </div>
      </div>
      <details className="text-sm">
        <summary className="w-fit cursor-pointer text-muted-foreground hover:text-foreground">{t.chartTable}</summary>
        <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-border">
          <Table>
            <thead>
              <tr>
                <Th variant="plain">{t.day}</Th>
                <Th variant="plain" className="text-right">
                  {t.cost}
                </Th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.key}>
                  <Td>{dayLabel(point.key, true)}</Td>
                  <Td className="text-right tabular-nums">{formatUsd(point.value)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </details>
    </div>
  );
}

interface BudgetDraft {
  perRunUsd: string;
  perTaskUsd: string;
  maxTurns: string;
}

const budgetDraft = (
  budget:
    | {
        perRunUsd?: number | null | undefined;
        perTaskUsd?: number | null | undefined;
        maxTurns?: number | null | undefined;
      }
    | undefined,
): BudgetDraft => ({
  perRunUsd: String(budget?.perRunUsd ?? ""),
  perTaskUsd: String(budget?.perTaskUsd ?? ""),
  maxTurns: String(budget?.maxTurns ?? ""),
});

function BudgetForm({ project, onSaved }: { project: Project; onSaved: () => Promise<unknown> }) {
  const t = useT(text);
  const { api } = useOrg();
  const base = budgetDraft(project.settings.budget);
  const [draft, setDraft] = useState(base);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = (Object.keys(base) as (keyof BudgetDraft)[]).some((key) => draft[key] !== base[key]);
  const update = useMutation({
    mutationFn: (input: {
      settings: { budget: { perRunUsd: number | null; perTaskUsd: number | null; maxTurns: number | null } };
    }) => api.projects.updateSettings.call({ key: project.key, ...input }),
    onSuccess: async (_, input) => {
      setFailure(null);
      setSaved(true);
      // Giữ bản nháp khớp với số hub vừa nhận để "5.0" không bị coi là còn khác "5" sau khi lưu.
      setDraft(budgetDraft(input.settings.budget));
      await onSaved();
    },
    onError: (error) => setFailure(formError(error).message),
  });

  function edit(key: keyof BudgetDraft, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
    setSaved(false);
  }

  function save() {
    const parse = (value: string) => {
      const trimmed = value.trim().replace(",", ".");
      return trimmed ? Number(trimmed) : null;
    };
    const perRunUsd = parse(draft.perRunUsd);
    const perTaskUsd = parse(draft.perTaskUsd);
    const maxTurns = parse(draft.maxTurns);
    if (
      [perRunUsd, perTaskUsd].some(
        (value) => value !== null && (!Number.isFinite(value) || value <= 0 || value > 100_000),
      ) ||
      (maxTurns !== null && (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 10_000))
    ) {
      setFailure(t.budgetInvalid);
      return;
    }
    setFailure(null);
    update.mutate({ settings: { budget: { perRunUsd, perTaskUsd, maxTurns } } });
  }

  return (
    <>
      <UnsavedChangesGuard when={dirty} />
      <SettingsSection
        id="budget"
        title={t.budgetTitle}
        description={t.budgetHint}
        save={{
          dirty,
          saving: update.isPending,
          saved,
          error: failure,
          saveLabel: t.saveBudget,
          onSave: save,
          onDiscard: () => {
            setDraft(base);
            setFailure(null);
          },
        }}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <BudgetField
            label={t.perRun}
            value={draft.perRunUsd}
            onChange={(v) => edit("perRunUsd", v)}
            suffix="USD"
            inputMode="decimal"
            placeholder={t.unlimited}
          />
          <BudgetField
            label={t.perTask}
            value={draft.perTaskUsd}
            onChange={(v) => edit("perTaskUsd", v)}
            suffix="USD"
            inputMode="decimal"
            placeholder={t.unlimited}
          />
          <BudgetField
            label={t.maxTurns}
            value={draft.maxTurns}
            onChange={(v) => edit("maxTurns", v)}
            suffix={t.turnsSuffix}
            inputMode="numeric"
            placeholder={t.unlimited}
          />
        </div>
      </SettingsSection>
    </>
  );
}

// TODO(admin-layout): ô số có hậu tố đơn vị cũng có ở project-settings-page.tsx (TextField); gộp vào components/page khi điều phối cho sửa file dùng chung.
function BudgetField({
  label,
  value,
  onChange,
  suffix,
  inputMode,
  placeholder,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  suffix: string;
  inputMode: "decimal" | "numeric";
  placeholder: string;
  error?: string;
}) {
  const id = useId();
  return (
    <Field invalid={error !== undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="relative flex items-center">
        <Input
          id={id}
          value={value}
          onValueChange={onChange}
          inputMode={inputMode}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className="pr-14 font-mono text-sm"
        />
        <span className="pointer-events-none absolute right-3 font-mono text-xs text-muted-foreground">{suffix}</span>
      </div>
      {error && <FieldError>{error}</FieldError>}
    </Field>
  );
}
