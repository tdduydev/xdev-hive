import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { Deploy, DeployBoard, DeployListInput, DeployState, System } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, TableBody, TableHeader, TableRow, Td, Th } from "@xdev-hive/ui/table";
import { LockIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { EmptyState, LoadFailure, LoadingState, TableSkeleton } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import {
  DEPLOY_METHOD_LABEL,
  DEPLOY_ORIGIN_LABEL,
  DEPLOY_STATE_LABEL,
  DEPLOY_STATE_TONE,
} from "@/lib/delivery-text.ts";
import { formatAgo, formatDayTime } from "@/lib/format.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { useTeamPermissions } from "@/lib/permissions.ts";
import { useNow } from "@/lib/use-now.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";
import { DeployDialog, type DeployDialogTarget } from "./deploy-dialog.tsx";
import { deployActor, HealthPill, VersionLines } from "./deploy-view.tsx";

const text: Dict<{
  title: string;
  lead: (system: string) => string;
  crumb: string;
  running: string;
  runningHint: string;
  history: string;
  noSystem: string;
  noSystemHint: string;
  noEnvs: string;
  noEnvsLead: string;
  noProjects: string;
  noProjectsLead: string;
  project: string;
  noTarget: string;
  never: string;
  deploy: string;
  deployTo: (project: string, env: string) => string;
  locked: string;
  lockedBy: (reason: string) => string;
  active: string;
  filters: string;
  allProjects: string;
  allEnvs: string;
  allStates: string;
  allOrigins: string;
  filterProject: string;
  filterEnv: string;
  filterState: string;
  filterOrigin: string;
  colTime: string;
  colEnv: string;
  colVersion: string;
  colState: string;
  colBy: string;
  colRunner: string;
  runnerLegacy: string;
  historyEmpty: string;
  historyEmptyHint: string;
  historyEmptyFiltered: string;
  historyEmptyFilteredHint: string;
  more: string;
  loadingMore: string;
}> = {
  vi: {
    title: "Triển khai",
    lead: (system) => `Bản đang chạy của ${system} theo từng dự án và môi trường.`,
    crumb: "Hệ thống",
    running: "Đang chạy",
    runningHint: "Bản thành công gần nhất ở mỗi đích; lần đang đi hiện kèm.",
    history: "Lịch sử",
    noSystem: "Không tìm thấy hệ thống này",
    noSystemHint: "Hệ thống có thể đã bị xoá hoặc bạn không thuộc đội của nó.",
    noEnvs: "Hệ thống chưa có môi trường",
    noEnvsLead: "Quản trị thêm môi trường (dev, staging, prod…) ở trang Môi trường rồi quay lại đây.",
    noProjects: "Hệ thống chưa có dự án",
    noProjectsLead: "Thêm dự án vào hệ thống để có đích triển khai.",
    project: "Dự án",
    noTarget: "Chưa có đích",
    never: "Chưa triển khai",
    deploy: "Triển khai",
    deployTo: (project, env) => `Triển khai ${project} lên ${env}`,
    locked: "Khoá",
    lockedBy: (reason) => `Môi trường đang khoá: ${reason}`,
    active: "Đang đi",
    filters: "Lọc lịch sử",
    allProjects: "Mọi dự án",
    allEnvs: "Mọi môi trường",
    allStates: "Mọi trạng thái",
    allOrigins: "Mọi nguồn",
    filterProject: "Dự án",
    filterEnv: "Môi trường",
    filterState: "Trạng thái",
    filterOrigin: "Nguồn",
    colTime: "Giờ",
    colEnv: "Môi trường",
    colVersion: "Phiên bản",
    colState: "Trạng thái",
    colBy: "Người",
    colRunner: "Máy chạy",
    runnerLegacy: "Hub",
    historyEmpty: "Chưa có lần triển khai nào",
    historyEmptyHint: "Bấm Triển khai ở một ô của bảng để chạy lần đầu.",
    historyEmptyFiltered: "Không có lần triển khai khớp bộ lọc",
    historyEmptyFilteredHint: "Bỏ bớt bộ lọc để xem thêm.",
    more: "Tải thêm",
    loadingMore: "Đang tải…",
  },
  en: {
    title: "Deployments",
    lead: (system) => `What is running in ${system}, by project and environment.`,
    crumb: "System",
    running: "Running now",
    runningHint: "The latest successful deployment of each target, with any in-flight one.",
    history: "History",
    noSystem: "System not found",
    noSystemHint: "It may have been deleted, or you are not on its team.",
    noEnvs: "This system has no environments",
    noEnvsLead: "Add environments (dev, staging, prod…) on the Environments page, then come back.",
    noProjects: "This system has no projects",
    noProjectsLead: "Add a project to the system to get deploy targets.",
    project: "Project",
    noTarget: "No target",
    never: "Never deployed",
    deploy: "Deploy",
    deployTo: (project, env) => `Deploy ${project} to ${env}`,
    locked: "Locked",
    lockedBy: (reason) => `Environment locked: ${reason}`,
    active: "In flight",
    filters: "Filter history",
    allProjects: "All projects",
    allEnvs: "All environments",
    allStates: "All states",
    allOrigins: "All sources",
    filterProject: "Project",
    filterEnv: "Environment",
    filterState: "State",
    filterOrigin: "Source",
    colTime: "Time",
    colEnv: "Environment",
    colVersion: "Version",
    colState: "State",
    colBy: "By",
    colRunner: "Runner",
    runnerLegacy: "Hub",
    historyEmpty: "No deployments yet",
    historyEmptyHint: "Press Deploy on a board cell to run the first one.",
    historyEmptyFiltered: "No deployments match the filters",
    historyEmptyFilteredHint: "Clear a filter to see more.",
    more: "Load more",
    loadingMore: "Loading…",
  },
};

const STATES = Object.keys(DEPLOY_STATE_LABEL) as DeployState[];

/** Bảng triển khai của một hệ thống (FR-020, FR-021): bản đang chạy theo dự án × môi trường, nút Triển khai, lịch sử. */
export function DeployBoardPage() {
  const t = useT(text);
  const { api } = useOrg();
  const { systemId } = useParams({ from: "/session/app/in-org/systems/$systemId/deploys" });
  const systems = useQuery(api.systems.list.queryOptions({ input: {} }));
  if (systems.isPending) {
    return (
      <>
        <PageHeader title={t.title} />
        <PageBody>
          <LoadingState />
        </PageBody>
      </>
    );
  }
  if (systems.isError) {
    return (
      <>
        <PageHeader title={t.title} />
        <PageBody>
          <LoadFailure error={systems.error} retry={() => void systems.refetch()} />
        </PageBody>
      </>
    );
  }
  const system = systems.data.find((s) => s.id === systemId);
  if (!system) {
    return (
      <>
        <PageHeader title={t.title} />
        <PageBody>
          <EmptyState title={t.noSystem} description={t.noSystemHint} />
        </PageBody>
      </>
    );
  }
  return <SystemBoard system={system} />;
}

function SystemBoard({ system }: { system: System }) {
  const t = useT(text);
  const { api } = useOrg();
  const canRun = useTeamPermissions(system.teamId)("deploy.run");
  const board = useQuery(api.deploys.board.queryOptions({ input: { systemId: system.id } }));
  const [target, setTarget] = useState<DeployDialogTarget | null>(null);
  return (
    <>
      <PageHeader crumb={`${t.crumb} ${system.name}`} title={t.title} description={t.lead(system.name)} />
      <PageBody>
        <section aria-labelledby="deploy-running" className="grid min-w-0 gap-2.5">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h2 id="deploy-running" className="text-base font-semibold text-foreground">
              {t.running}
            </h2>
            <p className="text-xs text-muted-foreground">{t.runningHint}</p>
          </div>
          {board.isPending && <TableSkeleton rows={3} columns={4} />}
          {board.isError && <LoadFailure error={board.error} retry={() => void board.refetch()} />}
          {board.data && <BoardTable board={board.data} canRun={canRun} onDeploy={setTarget} />}
        </section>
        <History systemId={system.id} board={board.data} />
      </PageBody>
      <DeployDialog target={target} onDone={() => setTarget(null)} />
    </>
  );
}

function BoardTable({
  board,
  canRun,
  onDeploy,
}: {
  board: DeployBoard;
  canRun: boolean;
  onDeploy: (target: DeployDialogTarget) => void;
}) {
  const t = useT(text);
  const now = useNow(60_000);
  if (board.environments.length === 0) return <EmptyState title={t.noEnvs} description={t.noEnvsLead} />;
  if (board.rows.length === 0) return <EmptyState title={t.noProjects} description={t.noProjectsLead} />;
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
      {/* Bảng rộng hơn khung thì cuộn ngang trong chính nó, không kéo cả trang (Table đã bọc overflow-x-auto). */}
      <Table className="min-w-[50rem]">
        <TableHeader>
          <TableRow>
            <Th variant="plain" scope="col" className="sticky left-0 z-10 bg-card">
              {t.project}
            </Th>
            {board.environments.map((env) => (
              <Th variant="plain" scope="col" key={env.id}>
                <span className="inline-flex items-center gap-2">
                  {env.name}
                  {env.lock && (
                    <Pill tone="warn" title={t.lockedBy(env.lock.reason)}>
                      <LockIcon aria-hidden="true" className="size-3" />
                      {t.locked}
                      <span className="sr-only">: {env.lock.reason}</span>
                    </Pill>
                  )}
                </span>
              </Th>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {board.rows.map((row) => (
            <TableRow key={row.projectId}>
              <Td className="sticky left-0 z-10 bg-card align-top font-medium">
                <span className="block max-w-40 break-words">{row.projectName}</span>
              </Td>
              {board.environments.map((env) => {
                const cell = row.cells.find((c) => c.environmentId === env.id);
                return (
                  <Td key={env.id} className="min-w-52 align-top">
                    {cell && (
                      <BoardCellView
                        cell={cell}
                        now={now}
                        canRun={canRun}
                        onDeploy={() => {
                          if (cell.targetId)
                            onDeploy({ id: cell.targetId, projectName: row.projectName, environmentName: env.name });
                        }}
                        label={t.deployTo(row.projectName, env.name)}
                      />
                    )}
                  </Td>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function BoardCellView({
  cell,
  now,
  canRun,
  onDeploy,
  label,
}: {
  cell: DeployBoard["rows"][number]["cells"][number];
  now: number;
  canRun: boolean;
  onDeploy: () => void;
  label: string;
}) {
  const t = useT(text);
  if (!cell.targetId) return <span className="text-muted-foreground">{t.noTarget}</span>;
  const { current, active } = cell;
  return (
    <div className="grid min-w-0 gap-1.5 text-sm">
      {active && (
        <Link
          to="/deploys/$id"
          params={{ id: active.id }}
          className="inline-flex w-fit max-w-full items-center gap-1.5 text-primary hover:text-primary/90"
        >
          <Pill tone={DEPLOY_STATE_TONE[active.state]} dot>
            {DEPLOY_STATE_LABEL[active.state]}
          </Pill>
          <span className="truncate text-xs">{deployActor(active)}</span>
        </Link>
      )}
      {current ? (
        <>
          <Link
            to="/deploys/$id"
            params={{ id: current.id }}
            className="block min-w-0 rounded-sm hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <VersionLines version={current.version} />
          </Link>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <time dateTime={current.finishedAt ?? current.createdAt} title={formatDayTime(current.createdAt)}>
              {formatAgo(current.finishedAt ?? current.createdAt, now)}
            </time>
            <span>{deployActor(current)}</span>
          </div>
          <HealthPill health={current.health} />
        </>
      ) : (
        !active && <span className="text-muted-foreground">{t.never}</span>
      )}
      {canRun && (
        <Button variant="outline" size="sm" className="w-fit" onClick={onDeploy} aria-label={label}>
          {t.deploy}
        </Button>
      )}
    </div>
  );
}

function History({ systemId, board }: { systemId: string; board: DeployBoard | undefined }) {
  const t = useT(text);
  const { api } = useOrg();
  const now = useNow(60_000);
  const ids = useId();
  const [projectId, setProjectId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [state, setState] = useState<DeployState | "">("");
  const [origin, setOrigin] = useState<"" | "hive" | "external">("");
  const filtered = !!(projectId || environmentId || state || origin);
  const list = useInfiniteQuery(
    api.deploys.list.infiniteOptions({
      input: (cursor: string | undefined): DeployListInput => ({
        systemId,
        ...(projectId ? { projectId } : {}),
        ...(environmentId ? { environmentId } : {}),
        ...(state ? { state } : {}),
        ...(origin ? { origin } : {}),
        limit: 30,
        ...(cursor ? { cursor } : {}),
      }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    }),
  );
  const items: Deploy[] = [
    ...new Map((list.data?.pages.flatMap((page) => page.items) ?? []).map((d) => [d.id, d])).values(),
  ];
  const envName = new Map(board?.environments.map((e) => [e.id, e.name]));
  const projectName = new Map(board?.rows.map((r) => [r.projectId, r.projectName]));
  return (
    <section aria-labelledby="deploy-history" className="grid min-w-0 gap-2.5">
      <h2 id="deploy-history" className="text-base font-semibold text-foreground">
        {t.history}
      </h2>
      <fieldset
        aria-label={t.filters}
        className="m-0 grid min-w-0 grid-cols-1 gap-2 border-0 p-0 sm:grid-cols-2 lg:grid-cols-4"
      >
        <FilterSelect id={`${ids}-project`} label={t.filterProject} value={projectId} onChange={setProjectId}>
          <option value="">{t.allProjects}</option>
          {board?.rows.map((r) => (
            <option key={r.projectId} value={r.projectId}>
              {r.projectName}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect id={`${ids}-env`} label={t.filterEnv} value={environmentId} onChange={setEnvironmentId}>
          <option value="">{t.allEnvs}</option>
          {board?.environments.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          id={`${ids}-state`}
          label={t.filterState}
          value={state}
          onChange={(v) => setState(v as DeployState | "")}
        >
          <option value="">{t.allStates}</option>
          {STATES.map((s) => (
            <option key={s} value={s}>
              {DEPLOY_STATE_LABEL[s]}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          id={`${ids}-origin`}
          label={t.filterOrigin}
          value={origin}
          onChange={(v) => setOrigin(v as "" | "hive" | "external")}
        >
          <option value="">{t.allOrigins}</option>
          <option value="hive">{DEPLOY_ORIGIN_LABEL.hive}</option>
          <option value="external">{DEPLOY_ORIGIN_LABEL.external}</option>
        </FilterSelect>
      </fieldset>
      {list.isPending && <TableSkeleton rows={4} columns={7} />}
      {list.isError && <LoadFailure error={list.error} retry={() => void list.refetch()} />}
      {list.data && items.length === 0 && (
        <EmptyState
          compact
          title={filtered ? t.historyEmptyFiltered : t.historyEmpty}
          description={filtered ? t.historyEmptyFilteredHint : t.historyEmptyHint}
        />
      )}
      {items.length > 0 && (
        <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
          <Table className="min-w-[44rem]">
            <TableHeader>
              <TableRow>
                <Th variant="plain" scope="col">
                  {t.colTime}
                </Th>
                <Th variant="plain" scope="col">
                  {t.project}
                </Th>
                <Th variant="plain" scope="col">
                  {t.colEnv}
                </Th>
                <Th variant="plain" scope="col">
                  {t.colVersion}
                </Th>
                <Th variant="plain" scope="col">
                  {t.colState}
                </Th>
                <Th variant="plain" scope="col">
                  {t.colBy}
                </Th>
                <Th variant="plain" scope="col">
                  {t.colRunner}
                </Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((d) => (
                <TableRow key={d.id}>
                  <Td className="align-top whitespace-nowrap">
                    <Link
                      to="/deploys/$id"
                      params={{ id: d.id }}
                      className="text-primary hover:text-primary/90"
                      title={formatDayTime(d.createdAt)}
                    >
                      {formatAgo(d.createdAt, now)}
                    </Link>
                  </Td>
                  <Td className="align-top">{projectName.get(d.projectId) ?? "—"}</Td>
                  <Td className="align-top">
                    {envName.get(d.environmentId) ?? "—"}
                    <span className="block text-xs text-muted-foreground">{DEPLOY_METHOD_LABEL[d.method]}</span>
                  </Td>
                  <Td className="max-w-56 align-top">
                    <VersionLines version={d.version} />
                  </Td>
                  <Td className="align-top">
                    <Pill tone={DEPLOY_STATE_TONE[d.state]} dot>
                      {DEPLOY_STATE_LABEL[d.state]}
                    </Pill>
                  </Td>
                  <Td className="align-top">{deployActor(d)}</Td>
                  <Td className="align-top">
                    {d.runner === null
                      ? "—"
                      : d.runner.mode === "legacy"
                        ? t.runnerLegacy
                        : (d.runner.machine?.name ?? "—")}
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {list.hasNextPage && (
        <Button
          variant="outline"
          className="w-fit"
          onClick={() => void list.fetchNextPage()}
          disabled={list.isFetchingNextPage}
        >
          {list.isFetchingNextPage ? t.loadingMore : t.more}
        </Button>
      )}
      {list.isFetchNextPageError && <Alert variant="destructive">{apiErrorMessage(list.error)}</Alert>}
    </section>
  );
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </NativeSelect>
    </div>
  );
}
