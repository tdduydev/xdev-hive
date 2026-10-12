import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { Project, RunListItem } from "@xdev-hive/contracts";
import { type ReactNode, useId } from "react";
import { Icon } from "../components/icons.tsx";
import { Alert } from "../components/ui/alert.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { FilterChips } from "../components/ui/filter-chips.tsx";
import { Pill } from "../components/ui/pill.tsx";
import { Select } from "../components/ui/select.tsx";
import { Table, Td, Th } from "../components/ui/table.tsx";
import { apiErrorMessage } from "../lib/api-errors.ts";
import { formatDayTime, formatUsd } from "../lib/format.ts";
import { hasFilter, RUN_FILTERS, type RunsSearch, searchInput, validateRunsSearch } from "../lib/run-list.ts";
import { CLI_LABEL, cliLabel, prLabel, RUN_STATE_LABEL, runStateTone, shortId } from "../lib/run-view.ts";
import { runActivity } from "../lib/task-board.ts";
import { useNow } from "../lib/use-now.ts";
import { useOrg } from "../shell/org-context.ts";
import { PageBody, PageHeader } from "../shell/page-header.tsx";

/** Danh sách tự làm mới như bảng việc; chi tiết một run nhận trực tiếp qua SSE ở /runs/$id. */
const REFRESH_MS = 30_000;

/** /runs: mọi run của các đội mình có vai trò, mới nhất trước. */
export function RunsPage() {
  const { org, api } = useOrg();
  const search = useSearch({ from: "/session/app/in-org/runs" });
  const navigate = useNavigate({ from: "/runs" });
  const setSearch = (next: Partial<Record<keyof RunsSearch, string | undefined>>) =>
    navigate({ search: (prev) => validateRunsSearch({ ...prev, ...next }), replace: true });
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const project = search.project ? projects.data?.find((p) => p.key === search.project) : undefined;
  // Lọc theo dự án cần id; chờ danh sách dự án để không tải nhầm run của mọi dự án.
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
  const machines = runs.data?.pages[0]?.machines ?? [];

  let body: ReactNode;
  if (search.project && projects.isSuccess && !project) {
    body = <Alert>Không tìm thấy dự án {search.project}, hoặc bạn không ở trong đội sở hữu dự án.</Alert>;
  } else if (projects.isError && search.project) body = <Alert>{apiErrorMessage(projects.error)}</Alert>;
  else if (runs.isPending) {
    body = (
      <p aria-busy="true" className="text-muted-foreground">
        Đang tải…
      </p>
    );
  } else if (!runs.data) body = <Alert>{apiErrorMessage(runs.error)}</Alert>;
  else {
    const items = runs.data.pages.flatMap((p) => p.items);
    body =
      items.length === 0 ? (
        hasFilter(search) ? (
          <Card className="grid justify-items-center gap-3 px-6 py-8 text-center text-muted-foreground">
            Không có run nào khớp bộ lọc.
            <Button variant="outline" size="sm" onClick={() => navigate({ search: {}, replace: true })}>
              Bỏ lọc
            </Button>
          </Card>
        ) : (
          <EmptyRuns />
        )
      ) : (
        <>
          <RunTable items={items} projects={projects.data ?? []} now={now} />
          {runs.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => runs.fetchNextPage()} disabled={runs.isFetchingNextPage}>
                {runs.isFetchingNextPage ? "Đang tải…" : "Xem thêm"}
              </Button>
            </div>
          )}
          {runs.isFetchNextPageError && <Alert>{apiErrorMessage(runs.error)}</Alert>}
        </>
      );
  }

  return (
    <>
      <PageHeader crumb={org.name} title="Lượt chạy" />
      <PageBody>
        <FilterChips
          label="Lọc theo trạng thái"
          chips={RUN_FILTERS}
          value={search.status ?? "all"}
          onChange={(status) => setSearch({ status: status === "all" ? undefined : status })}
        />
        <Filters search={search} projects={projects.data ?? []} machines={machines} onChange={setSearch} />
        {body}
      </PageBody>
    </>
  );
}

function Filters({
  search,
  projects,
  machines,
  onChange,
}: {
  search: RunsSearch;
  projects: Project[];
  machines: { id: string; name: string }[];
  onChange: (next: Partial<Record<keyof RunsSearch, string | undefined>>) => void;
}) {
  const ids = { project: useId(), cli: useId(), machine: useId() };
  // Máy đang lọc nhưng không có trong danh sách (link cũ, máy đã thu hồi) vẫn phải hiện để bỏ chọn được.
  const machineOptions =
    search.machine && !machines.some((m) => m.id === search.machine)
      ? [...machines, { id: search.machine, name: shortId(search.machine) }]
      : machines;
  const box = "grid min-w-0 gap-1 text-xs text-muted-foreground";
  return (
    <fieldset className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3 app:max-w-200">
      <legend className="sr-only">Lọc theo dự án, agent, máy</legend>
      <label htmlFor={ids.project} className={box}>
        Dự án
        <Select
          id={ids.project}
          size="sm"
          value={search.project ?? ""}
          onChange={(e) => onChange({ project: e.currentTarget.value || undefined })}
        >
          <option value="">Mọi dự án</option>
          {search.project && !projects.some((p) => p.key === search.project) && (
            <option value={search.project}>{search.project}</option>
          )}
          {projects.map((p) => (
            <option key={p.id} value={p.key}>
              {p.name} ({p.key})
            </option>
          ))}
        </Select>
      </label>
      <label htmlFor={ids.cli} className={box}>
        Agent
        <Select
          id={ids.cli}
          size="sm"
          value={search.cli ?? ""}
          onChange={(e) => onChange({ cli: e.currentTarget.value || undefined })}
        >
          <option value="">Mọi agent</option>
          {Object.entries(CLI_LABEL).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </Select>
      </label>
      <label htmlFor={ids.machine} className={box}>
        Máy
        <Select
          id={ids.machine}
          size="sm"
          value={search.machine ?? ""}
          onChange={(e) => onChange({ machine: e.currentTarget.value || undefined })}
        >
          <option value="">Mọi máy</option>
          {machineOptions.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
      </label>
    </fieldset>
  );
}

function EmptyRuns() {
  return (
    <Card className="grid justify-items-center gap-2 px-6 py-10 text-center">
      <span className="mb-1 grid size-10 place-items-center rounded-lg bg-accent text-accent-foreground">
        <Icon name="play" className="size-5" />
      </span>
      <h2 className="text-base font-semibold text-foreground">Chưa có lượt chạy nào</h2>
      <p className="max-w-md text-muted-foreground">
        Mỗi lần giao việc cho agent là một lượt chạy. Giao việc từ{" "}
        <Link to="/tasks" className="text-primary hover:text-primary/90">
          Bảng việc
        </Link>
        .
      </p>
    </Card>
  );
}

function RunTable({ items, projects, now }: { items: RunListItem[]; projects: Project[]; now: number }) {
  const projectOf = new Map(projects.map((p) => [p.id, p]));
  return (
    <Card className="overflow-hidden">
      <Table className="min-w-240">
        <caption className="sr-only">Danh sách lượt chạy</caption>
        <thead>
          <tr>
            <Th>Run</Th>
            <Th>Việc</Th>
            <Th>Trạng thái</Th>
            <Th>Agent và máy</Th>
            <Th>Bắt đầu</Th>
            <Th className="text-right">Chi phí</Th>
            <Th>PR</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((run) => {
            const project = projectOf.get(run.projectId);
            return (
              <tr key={run.id}>
                <Td className="whitespace-nowrap">
                  <span className="grid leading-tight">
                    <Link
                      to="/runs/$id"
                      params={{ id: run.id }}
                      className="font-mono text-xs text-primary hover:text-primary/90"
                      aria-label={`Mở run ${shortId(run.id)} của ${run.taskKey}`}
                    >
                      {shortId(run.id)}
                    </Link>
                    {run.kind === "review" && <span className="text-xs text-muted-foreground">review chéo</span>}
                  </span>
                </Td>
                <Td className="min-w-70">
                  <span className="grid leading-tight">
                    <span className="text-xs text-muted-foreground">
                      <span className="font-mono">{run.taskKey}</span>
                      {project && (
                        <>
                          {" · "}
                          <Link
                            to="/projects/$key"
                            params={{ key: project.key }}
                            className="text-primary hover:text-primary/90"
                          >
                            {project.name}
                          </Link>
                        </>
                      )}
                    </span>
                    <span className="font-medium text-foreground">{run.taskTitle}</span>
                  </span>
                </Td>
                <Td className="whitespace-nowrap">
                  <span className="grid justify-items-start gap-0.5">
                    <Pill tone={runStateTone(run.state)} dot>
                      {RUN_STATE_LABEL[run.state]}
                    </Pill>
                    <span className="text-xs text-muted-foreground">{runActivity(run, now)}</span>
                  </span>
                </Td>
                <Td className="whitespace-nowrap">
                  <span className="text-foreground">{cliLabel(run.cli)}</span>{" "}
                  {run.machineName && (
                    <span className="font-mono text-xs text-muted-foreground">{run.machineName}</span>
                  )}
                </Td>
                <Td className="whitespace-nowrap text-muted-foreground tabular-nums">{formatDayTime(run.createdAt)}</Td>
                <Td className="text-right whitespace-nowrap text-foreground tabular-nums">
                  {formatUsd(run.cost.costUsd)}
                </Td>
                <Td className="whitespace-nowrap font-mono text-xs">
                  {run.prUrl ? (
                    <a href={run.prUrl} target="_blank" rel="noreferrer" className="text-primary hover:text-primary/90">
                      {prLabel(run.prUrl)}
                      <span className="sr-only"> (mở PR của {run.taskKey} ở tab mới)</span>
                    </a>
                  ) : (
                    "—"
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}
