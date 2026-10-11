import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { Project } from "@xdev-hive/contracts";
import { type ReactNode, useId } from "react";
import { CreateTaskButton } from "../components/create-task-dialog.tsx";
import { Icon } from "../components/icons.tsx";
import { Alert } from "../components/ui/alert.tsx";
import { buttonClass } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { FilterChips } from "../components/ui/filter-chips.tsx";
import { Input } from "../components/ui/input.tsx";
import { Pill } from "../components/ui/pill.tsx";
import { StatTile } from "../components/ui/stat-tile.tsx";
import { Table, Td, Th } from "../components/ui/table.tsx";
import { apiErrorMessage } from "../lib/api-errors.ts";
import { formatUsd } from "../lib/format.ts";
import { cliLabel, prLabel } from "../lib/run-view.ts";
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
} from "../lib/task-board.ts";
import { useNow } from "../lib/use-now.ts";
import { useOrg } from "../shell/org-context.ts";
import { PageBody, PageHeader } from "../shell/page-header.tsx";

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
    <p aria-busy="true" className="text-muted">
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
  return (
    <Board
      crumb={org.name}
      projectId={undefined}
      creatable={(projects.data ?? []).filter((p) => p.state === "active")}
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
          <Alert>
            {projects.isError
              ? apiErrorMessage(projects.error)
              : `Không tìm thấy dự án ${projectKey}, hoặc bạn không ở trong đội sở hữu dự án.`}
          </Alert>
          <Link to="/tasks" className="text-accent hover:text-accent-hover">
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
          className={buttonClass({ variant: "default" })}
        >
          <Icon name="gear" />
          Cấu hình
        </Link>
      }
      creatable={project.state === "active" ? [project] : []}
      search={search}
      onSearch={(next) => navigate({ search: (prev) => validateTasksSearch({ ...prev, ...next }), replace: true })}
    />
  );
}

function ProjectCrumb({ project }: { project: Project }) {
  return (
    <>
      <Link to="/projects" className="text-accent hover:text-accent-hover">
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
}: {
  crumb: ReactNode;
  /** Nút thêm ở đầu trang, trước "Tạo việc". */
  actions?: ReactNode;
  /** undefined là việc của mọi dự án. */
  projectId: string | undefined;
  /** Dự án tạo việc được (đang hoạt động). */
  creatable: Project[];
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
  else if (tasks.isError || runs.isError) body = <Alert>{apiErrorMessage(tasks.error ?? runs.error)}</Alert>;
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
          <EmptyBoard canCreate={creatable.length > 0} />
        ) : shown.length === 0 ? (
          <Card className="px-6 py-8 text-center text-muted">Không có việc nào khớp bộ lọc.</Card>
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
        <span className="w-60 max-w-full">
          <Input
            id={searchId}
            type="search"
            placeholder="Tìm theo mã hoặc tiêu đề"
            defaultValue={query}
            onChange={(e) => setSearch({ q: e.currentTarget.value })}
          />
        </span>
        {actions}
        <CreateTaskButton projects={creatable} />
      </PageHeader>
      <PageBody>{body}</PageBody>
    </>
  );
}

function EmptyBoard({ canCreate }: { canCreate: boolean }) {
  return (
    <Card className="grid justify-items-center gap-2 px-6 py-10 text-center">
      <span className="mb-1 grid size-10 place-items-center rounded-lg bg-sel text-sel-fg">
        <Icon name="columns" className="size-5" />
      </span>
      <h2 className="text-lg font-semibold text-ink">Chưa có việc nào</h2>
      <p className="max-w-md text-muted">
        {canCreate
          ? "Bấm “Tạo việc” để giao việc đầu tiên cho agent, hoặc gắn nhãn cho issue trên GitHub/GitLab nếu dự án bật nhận việc từ issue."
          : "Chưa có dự án nào đang hoạt động mà bạn thấy được. Nhờ quản trị đội tạo dự án hoặc thêm bạn vào đội."}
      </p>
    </Card>
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
                      className="font-mono text-sm text-accent hover:text-accent-hover"
                      aria-label={`${task.key}: mở run gần nhất`}
                    >
                      {task.key}
                    </Link>
                  ) : (
                    <span className="font-mono text-sm text-muted">{task.key}</span>
                  )}
                  <span className="font-medium text-ink">{task.title}</span>
                </span>
              </Td>
              <Td className="whitespace-nowrap">
                <Pill tone={badge.tone} dot>
                  {badge.label}
                </Pill>
              </Td>
              <Td className="whitespace-nowrap">
                <span className="text-ink">{cliLabel(run?.cli ?? task.preferredCli)}</span>{" "}
                {run?.machineName && <span className="font-mono text-sm text-muted">{run.machineName}</span>}
              </Td>
              <Td className="whitespace-nowrap text-muted">{runActivity(run, now)}</Td>
              <Td className="text-right whitespace-nowrap text-ink tabular-nums">
                {run ? formatUsd(run.cost.costUsd) : "—"}
              </Td>
              <Td className="whitespace-nowrap font-mono text-sm">
                {run?.prUrl ? (
                  <a href={run.prUrl} target="_blank" rel="noreferrer" className="text-accent hover:text-accent-hover">
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
