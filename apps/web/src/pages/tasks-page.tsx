import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { Project } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { buttonVariants } from "@xdev-hive/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@xdev-hive/ui/empty";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, Td, Th } from "@xdev-hive/ui/table";
import { KanbanSquareIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useId } from "react";
import { CreateTaskButton } from "@/components/create-task-dialog.tsx";
import { Icon } from "@/components/icons.tsx";
import { ProvisionSteps } from "@/components/provision-steps.tsx";
import { Card } from "@/components/ui/card.tsx";
import { FilterChips } from "@/components/ui/filter-chips.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group.tsx";
import { StatTile } from "@/components/ui/stat-tile.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { formatUsd } from "@/lib/format.ts";
import { useLang } from "@/lib/i18n.ts";
import { teamRoleLookup } from "@/lib/projects.ts";
import { createTaskBlockedReason, showsProvision } from "@/lib/provision.ts";
import { cliLabel, prLabel } from "@/lib/run-view.ts";
import {
  BOARD_FILTERS,
  type BoardFilter,
  type BoardRow,
  boardRows,
  boardStats,
  filterCounts,
  filterRows,
  isBoardFilter,
  runActivity,
} from "@/lib/task-board.ts";
import { useNow } from "@/lib/use-now.ts";
import { useMe } from "@/shell/me-context.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

export interface TasksSearch {
  /** Nhóm lọc; không có là "Tất cả". */
  status?: BoardFilter;
  /** Chữ trong ô tìm. */
  q?: string;
}

export function validateTasksSearch(search: Record<string, unknown>): TasksSearch {
  return {
    ...(isBoardFilter(search.status) && search.status !== "all" ? { status: search.status } : {}),
    ...(typeof search.q === "string" && search.q ? { q: search.q } : {}),
  };
}

/** Bảng việc tự làm mới sau chừng này; chi tiết một run thì nhận trực tiếp qua SSE ở /runs/$id. */
const REFRESH_MS = 30_000;

function Loading() {
  return (
    <p aria-busy="true" className="text-muted-foreground">
      Đang tải…
    </p>
  );
}

/** /tasks: việc của mọi dự án mình thấy được. */
export function TasksPage() {
  const { org, api } = useOrg();
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const search = useSearch({ from: "/session/app/in-org/tasks" });
  const navigate = useNavigate({ from: "/tasks" });
  const lang = useLang();
  const creatable = (projects.data ?? []).filter((p) => p.state === "active");
  return (
    <Board
      crumb={org.name}
      projectId={undefined}
      creatable={creatable}
      blockedReason={projects.isSuccess ? createTaskBlockedReason(undefined, creatable.length, lang) : null}
      search={search}
      onSearch={(next) => navigate({ search: (prev) => validateTasksSearch({ ...prev, ...next }), replace: true })}
    />
  );
}

/** /projects/$key: bảng việc lọc theo một dự án. */
export function ProjectTasksPage() {
  const { org, api } = useOrg();
  const { key: projectKey } = useParams({ from: "/session/app/in-org/projects/$key" });
  const search = useSearch({ from: "/session/app/in-org/projects/$key" });
  const navigate = useNavigate({ from: "/projects/$key" });
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const members = useQuery(api.orgMembers.list.queryOptions({ input: {} }));
  const me = useMe();
  const lang = useLang();
  const project = projects.data?.find((p) => p.key === projectKey);
  if (projects.isPending) {
    return (
      <>
        <PageHeader crumb={org.name} title="Bảng việc" />
        <PageBody>
          <Loading />
        </PageBody>
      </>
    );
  }
  if (projects.isError || !project) {
    return (
      <>
        <PageHeader crumb={org.name} title="Bảng việc" />
        <PageBody>
          <Alert variant="destructive">
            {projects.isError
              ? apiErrorMessage(projects.error)
              : `Không tìm thấy dự án ${projectKey}, hoặc bạn không ở trong đội sở hữu dự án.`}
          </Alert>
          <Link to="/tasks" className="text-primary hover:text-primary/90">
            Về bảng việc chung
          </Link>
        </PageBody>
      </>
    );
  }
  return (
    <Board
      crumb={<ProjectCrumb project={project} />}
      projectId={project.id}
      actions={
        <Link
          to="/projects/$key/settings"
          params={{ key: project.key }}
          className={buttonVariants({ variant: "outline" })}
        >
          <Icon name="gear" />
          Cấu hình
        </Link>
      }
      creatable={project.state === "active" ? [project] : []}
      blockedReason={createTaskBlockedReason(project.state, project.state === "active" ? 1 : 0, lang)}
      notice={
        showsProvision(project.state) && (
          <ProvisionSteps
            project={project}
            canRetry={teamRoleLookup(org.role, members.data, me.id)(project.teamId) === "admin"}
          />
        )
      }
      search={search}
      onSearch={(next) => navigate({ search: (prev) => validateTasksSearch({ ...prev, ...next }), replace: true })}
    />
  );
}

function ProjectCrumb({ project }: { project: Project }) {
  return (
    <>
      <Link to="/projects" className="text-primary hover:text-primary/90">
        Dự án
      </Link>{" "}
      / {project.name} / <span className="font-mono">{project.key}</span>
    </>
  );
}

function Board({
  crumb,
  projectId,
  creatable,
  search,
  onSearch: setSearch,
  actions,
  blockedReason,
  notice,
}: {
  crumb: ReactNode;
  /** Nút thêm ở đầu trang, trước "Tạo việc". */
  actions?: ReactNode;
  /** undefined là việc của mọi dự án. */
  projectId: string | undefined;
  /** Dự án tạo việc được (đang hoạt động). */
  creatable: Project[];
  /** Vì sao chưa tạo được việc, hiện cạnh nút "Tạo việc" khi nút bị khoá. */
  blockedReason?: string | null;
  /** Thẻ đầu trang, trước số liệu (vd. các bước khởi tạo của dự án chưa hoạt động). */
  notice?: ReactNode;
  search: TasksSearch;
  onSearch: (next: TasksSearch) => void;
}) {
  const { api } = useOrg();
  const filter = search.status ?? "all";
  const query = search.q ?? "";
  const input = projectId ? { projectId } : {};
  const tasks = useQuery(api.tasks.list.queryOptions({ input, refetchInterval: REFRESH_MS }));
  const runs = useQuery(api.runs.latest.queryOptions({ input, refetchInterval: REFRESH_MS }));
  const now = useNow(REFRESH_MS);
  const searchId = useId();

  let body: ReactNode;
  if (tasks.isPending || runs.isPending) body = <Loading />;
  else if (tasks.isError || runs.isError)
    body = <Alert variant="destructive">{apiErrorMessage(tasks.error ?? runs.error)}</Alert>;
  else {
    const rows = boardRows(tasks.data, runs.data);
    const counts = filterCounts(rows);
    const shown = filterRows(rows, filter, query);
    body = (
      <>
        <section aria-label="Số liệu" className="grid grid-cols-2 gap-3 app:grid-cols-4">
          {boardStats(rows, now).map((s) => (
            <StatTile key={s.label} label={s.label} value={s.value} hint={s.hint} />
          ))}
        </section>
        <FilterChips
          label="Lọc theo trạng thái"
          chips={BOARD_FILTERS.map((f) => ({ ...f, count: counts[f.key] }))}
          value={filter}
          onChange={(status) => setSearch({ status })}
        />
        {rows.length === 0 ? (
          <EmptyBoard canCreate={creatable.length > 0} blockedReason={projectId ? blockedReason : null} />
        ) : shown.length === 0 ? (
          <Card className="px-6 py-8 text-center text-muted-foreground">Không có việc nào khớp bộ lọc.</Card>
        ) : (
          <TaskTable rows={shown} now={now} />
        )}
      </>
    );
  }

  return (
    <>
      <PageHeader crumb={crumb} title="Bảng việc">
        <label htmlFor={searchId} className="sr-only">
          Tìm việc
        </label>
        <InputGroup className="w-64 max-w-full">
          <InputGroupAddon>
            <SearchIcon aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            id={searchId}
            type="search"
            placeholder="Tìm theo mã hoặc tiêu đề"
            defaultValue={query}
            onChange={(e) => setSearch({ q: e.currentTarget.value })}
          />
        </InputGroup>
        {actions}
        <CreateTaskButton projects={creatable} disabledReason={blockedReason} />
      </PageHeader>
      <PageBody>
        {notice}
        {body}
      </PageBody>
    </>
  );
}

function EmptyBoard({ canCreate, blockedReason }: { canCreate: boolean; blockedReason?: string | null | undefined }) {
  return (
    <Empty className="border border-dashed border-border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <KanbanSquareIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle role="heading" aria-level={2}>
          Chưa có việc nào
        </EmptyTitle>
        <EmptyDescription>
          {canCreate
            ? "Bấm “Tạo việc” để giao việc đầu tiên cho agent, hoặc gắn nhãn cho issue trên GitHub/GitLab nếu dự án bật nhận việc từ issue."
            : (blockedReason ??
              "Chưa có dự án nào đang hoạt động mà bạn thấy được. Nhờ quản trị đội tạo dự án hoặc thêm bạn vào đội.")}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function TaskTable({ rows, now }: { rows: BoardRow[]; now: number }) {
  return (
    <Card className="overflow-hidden">
      <Table className="min-w-215">
        <caption className="sr-only">Danh sách việc</caption>
        <thead>
          <tr>
            <Th>Việc</Th>
            <Th>Trạng thái</Th>
            <Th>Agent và máy</Th>
            <Th>Run gần nhất</Th>
            <Th className="text-right">Chi phí</Th>
            <Th>PR</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ task, run, badge }) => (
            <tr key={task.id}>
              <Td className="min-w-70">
                <span className="grid leading-tight">
                  {run ? (
                    <Link
                      to="/runs/$id"
                      params={{ id: run.id }}
                      className="font-mono text-xs text-primary hover:text-primary/90"
                      aria-label={`${task.key}: mở run gần nhất`}
                    >
                      {task.key}
                    </Link>
                  ) : (
                    <span className="font-mono text-xs text-muted-foreground">{task.key}</span>
                  )}
                  <span className="font-medium text-foreground">{task.title}</span>
                </span>
              </Td>
              <Td className="whitespace-nowrap">
                <span className="grid justify-items-start gap-1">
                  <Pill tone={badge.tone} dot>
                    {badge.label}
                  </Pill>
                  {task.status === "awaiting_plan" && (
                    <Link
                      to="/tasks/$key/plan"
                      params={{ key: task.key }}
                      className="text-xs text-primary hover:text-primary/90"
                      aria-label={`Xem và duyệt kế hoạch của ${task.key}`}
                    >
                      Xem kế hoạch
                    </Link>
                  )}
                </span>
              </Td>
              <Td className="whitespace-nowrap">
                <span className="text-foreground">{cliLabel(run?.cli ?? task.preferredCli)}</span>{" "}
                {run?.machineName && <span className="font-mono text-xs text-muted-foreground">{run.machineName}</span>}
              </Td>
              <Td className="whitespace-nowrap text-muted-foreground">{runActivity(run, now)}</Td>
              <Td className="text-right whitespace-nowrap text-foreground tabular-nums">
                {run ? formatUsd(run.cost.costUsd) : "—"}
              </Td>
              <Td className="whitespace-nowrap font-mono text-xs">
                {run?.prUrl ? (
                  <a href={run.prUrl} target="_blank" rel="noreferrer" className="text-primary hover:text-primary/90">
                    {prLabel(run.prUrl)}
                    <span className="sr-only"> (mở PR của {task.key} ở tab mới)</span>
                  </a>
                ) : (
                  "—"
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
