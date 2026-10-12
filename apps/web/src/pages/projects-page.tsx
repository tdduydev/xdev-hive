import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { CostSummary, Project, TeamWithCounts } from "@xdev-hive/contracts";
import type { ReactNode } from "react";
import { CreateProjectButton } from "../components/create-project-dialog.tsx";
import { Icon } from "../components/icons.tsx";
import { Alert } from "../components/ui/alert.tsx";
import { buttonVariants } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { Pill } from "../components/ui/pill.tsx";
import { Table, Td, Th } from "../components/ui/table.tsx";
import { apiErrorMessage } from "../lib/api-errors.ts";
import { formatUsd } from "../lib/format.ts";
import {
  activeRunCounts,
  COST_DAYS,
  PROJECT_STATE,
  recentDays,
  repoPath,
  SCM_LABEL,
  teamRoleLookup,
} from "../lib/projects.ts";
import { isOrgAdmin } from "../lib/roles.ts";
import { teamColor, teamInitials } from "../lib/teams.ts";
import { useMe } from "../shell/me-context.ts";
import { useOrg } from "../shell/org-context.ts";
import { PageBody, PageHeader } from "../shell/page-header.tsx";

/** Số việc đang chạy đổi theo run; làm mới như bảng việc. */
const REFRESH_MS = 30_000;

function Loading() {
  return (
    <p aria-busy="true" className="text-muted-foreground">
      Đang tải…
    </p>
  );
}

/** /projects: dự án của mọi đội mình có vai trò. */
export function ProjectsPage() {
  const me = useMe();
  const { org, api } = useOrg();
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const teams = useQuery(api.teams.list.queryOptions());
  const members = useQuery(api.orgMembers.list.queryOptions());
  const latest = useQuery(api.runs.latest.queryOptions({ input: {}, refetchInterval: REFRESH_MS }));
  const roleOf = teamRoleLookup(org.role, members.data, me.id);
  // costs.summary chỉ cho quản trị đội: chỉ hỏi dự án mình quản trị, dự án khác hiện "—".
  const range = recentDays(Date.now());
  const costable = (projects.data ?? []).filter((p) => roleOf(p.teamId) === "admin");
  const costs = useQueries({
    queries: costable.map((p) =>
      api.costs.summary.queryOptions({ input: { projectId: p.id, ...range, groupBy: "day" }, retry: false }),
    ),
  });
  const costOf = new Map(costable.map((p, i) => [p.id, costs[i]]));
  const canCreate =
    isOrgAdmin(org.role) ||
    (members.data?.find((m) => m.userId === me.id)?.teams ?? []).some((t) => t.role === "admin");

  let body: ReactNode;
  if (projects.isPending) body = <Loading />;
  else if (projects.isError) body = <Alert variant="destructive">{apiErrorMessage(projects.error)}</Alert>;
  else if (projects.data.length === 0) body = <EmptyProjects canCreate={canCreate} />;
  else {
    body = (
      <ProjectTable
        projects={projects.data}
        teams={new Map((teams.data ?? []).map((t) => [t.id, t]))}
        running={latest.data ? activeRunCounts(latest.data) : undefined}
        costOf={costOf}
        canManage={(p) => roleOf(p.teamId) === "admin"}
      />
    );
  }

  return (
    <>
      <PageHeader crumb={org.name} title="Dự án">
        {canCreate && <CreateProjectButton />}
      </PageHeader>
      <PageBody>{body}</PageBody>
    </>
  );
}

function EmptyProjects({ canCreate }: { canCreate: boolean }) {
  return (
    <Card className="grid justify-items-center gap-2 px-6 py-10 text-center">
      <span className="mb-1 grid size-10 place-items-center rounded-lg bg-accent text-accent-foreground">
        <Icon name="folder" className="size-5" />
      </span>
      <h2 className="text-base font-semibold text-foreground">Chưa có dự án nào</h2>
      <p className="max-w-md text-muted-foreground">
        {canCreate
          ? "Bấm “Tạo dự án” để nối một repo GitHub/GitLab có sẵn hoặc tạo repo mới cho agent làm việc."
          : "Bạn chưa ở trong đội nào có dự án. Nhờ quản trị đội tạo dự án hoặc thêm bạn vào đội."}
      </p>
    </Card>
  );
}

function TeamCell({ team }: { team: TeamWithCounts | undefined }) {
  if (!team) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className="grid size-5.5 shrink-0 place-items-center rounded-sm text-2xs font-semibold text-white"
        style={{ backgroundColor: teamColor(team) }}
      >
        {teamInitials(team.name)}
      </span>
      <span className="text-foreground">{team.name}</span>
    </span>
  );
}

function ProjectTable({
  projects,
  teams,
  running,
  costOf,
  canManage,
}: {
  projects: Project[];
  teams: Map<string, TeamWithCounts>;
  /** undefined khi chưa tải được run. */
  running: Map<string, number> | undefined;
  /** Kết quả costs.summary theo dự án; không có là không đủ quyền xem. */
  costOf: Map<string, { data?: CostSummary | undefined; isPending: boolean } | undefined>;
  canManage: (p: Project) => boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <Table className="min-w-215">
        <caption className="sr-only">Danh sách dự án</caption>
        <thead>
          <tr>
            <Th>Dự án</Th>
            <Th>Repo</Th>
            <Th>Đội sở hữu</Th>
            <Th>Trạng thái</Th>
            <Th className="text-right">Đang chạy</Th>
            <Th className="text-right">Chi phí {COST_DAYS} ngày</Th>
            <Th>
              <span className="sr-only">Cấu hình</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => {
            const state = PROJECT_STATE[p.state];
            const cost = costOf.get(p.id);
            return (
              <tr key={p.id}>
                <Td className="min-w-55">
                  <span className="grid leading-tight">
                    <Link
                      to="/projects/$key"
                      params={{ key: p.key }}
                      className="font-medium text-primary hover:text-primary/90"
                    >
                      {p.name}
                    </Link>
                    <span className="font-mono text-xs text-muted-foreground">{p.key}</span>
                  </span>
                </Td>
                <Td className="whitespace-nowrap">
                  <span className="inline-flex items-center gap-2">
                    <Icon name={p.repo.kind} className="size-4 shrink-0 text-muted-foreground" />
                    <span className="sr-only">{SCM_LABEL[p.repo.kind]}: </span>
                    {p.repo.webUrl ? (
                      <a
                        href={p.repo.webUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-xs text-primary hover:text-primary/90"
                      >
                        {repoPath(p)}
                        <span className="sr-only"> (mở ở tab mới)</span>
                      </a>
                    ) : (
                      <span className="font-mono text-xs text-foreground">{repoPath(p)}</span>
                    )}
                  </span>
                </Td>
                <Td className="whitespace-nowrap">
                  <TeamCell team={teams.get(p.teamId)} />
                </Td>
                <Td className="whitespace-nowrap">
                  <Pill tone={state.tone} dot>
                    {state.label}
                  </Pill>
                </Td>
                <Td className="text-right text-foreground tabular-nums">{running ? (running.get(p.id) ?? 0) : "—"}</Td>
                <Td className="text-right whitespace-nowrap text-foreground tabular-nums">
                  {!cost ? (
                    <span title="Chỉ quản trị đội sở hữu xem được chi phí" className="text-muted-foreground">
                      —<span className="sr-only">Chỉ quản trị đội sở hữu xem được chi phí</span>
                    </span>
                  ) : cost.data ? (
                    formatUsd(cost.data.total.costUsd)
                  ) : (
                    <span className="text-muted-foreground">{cost.isPending ? "…" : "—"}</span>
                  )}
                </Td>
                <Td className="text-right whitespace-nowrap">
                  <Link
                    to="/projects/$key/settings"
                    params={{ key: p.key }}
                    className={buttonVariants({ variant: "ghost", size: "sm" })}
                  >
                    <Icon name="gear" className="size-4" />
                    {canManage(p) ? "Cấu hình" : "Xem cấu hình"}
                    <span className="sr-only"> {p.name}</span>
                  </Link>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}
