import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { CostSummary, Project, TeamWithCounts } from "@xdev-hive/contracts";
import { Button, buttonVariants } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { Table, Td, Th } from "@xdev-hive/ui/table";
import { SearchIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { CreateProjectButton } from "@/components/create-project-dialog.tsx";
import { Icon } from "@/components/icons.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Card } from "@/components/ui/card.tsx";
import { Pill } from "@/components/ui/pill.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { formatUsd } from "@/lib/format.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import {
  activeRunCounts,
  COST_DAYS,
  PROJECT_STATE,
  recentDays,
  repoPath,
  SCM_LABEL,
  teamRoleLookup,
} from "@/lib/projects.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { teamColor, teamInitials } from "@/lib/teams.ts";
import { useMe } from "@/shell/me-context.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const REFRESH_MS = 30_000;

const text: Dict<{
  title: string;
  lead: string;
  create: string;
  search: string;
  loading: string;
  emptyTitle: string;
  emptyCanCreate: string;
  emptyCannotCreate: string;
  noMatch: string;
  clearFilters: string;
  colProject: string;
  colRepo: string;
  colTeam: string;
  colStatus: string;
  colPlan: string;
  colSandbox: string;
  colRunning: string;
  colCost: string;
  config: string;
  viewConfig: string;
  newTabSr: string;
  costRestricted: string;
  filterStatus: string;
  filterTeam: string;
  filterAll: string;
  on: string;
  off: string;
  rowsMatched: (matched: number, total: number) => string;
}> = {
  vi: {
    title: "Dự án",
    lead: "Mỗi dự án nối một repo GitHub hoặc GitLab cho agent làm việc.",
    create: "Tạo dự án",
    search: "Tìm tên, key, repo…",
    loading: "Đang tải…",
    emptyTitle: "Chưa có dự án nào",
    emptyCanCreate: "Bấm “Tạo dự án” để nối một repo GitHub/GitLab có sẵn hoặc tạo repo mới cho agent làm việc.",
    emptyCannotCreate: "Bạn chưa ở trong đội nào có dự án. Nhờ quản trị đội tạo dự án hoặc thêm bạn vào đội.",
    noMatch: "Không có dự án nào khớp bộ lọc.",
    clearFilters: "Xoá bộ lọc",
    colProject: "Dự án",
    colRepo: "Repo",
    colTeam: "Đội sở hữu",
    colStatus: "Trạng thái",
    colPlan: "Plan mode",
    colSandbox: "Sandbox",
    colRunning: "Đang chạy",
    colCost: `Chi phí ${COST_DAYS} ngày`,
    config: "Cấu hình",
    viewConfig: "Xem cấu hình",
    newTabSr: "(mở ở tab mới)",
    costRestricted: "Chỉ quản trị đội sở hữu xem được chi phí",
    filterStatus: "Trạng thái",
    filterTeam: "Đội",
    filterAll: "Tất cả",
    on: "Bật",
    off: "Tắt",
    rowsMatched: (matched, total) => `${matched} / ${total} dòng khớp`,
  },
  en: {
    title: "Projects",
    lead: "Each project links a GitHub or GitLab repo for agents to work in.",
    create: "New project",
    search: "Search name, key, repo…",
    loading: "Loading…",
    emptyTitle: "No projects yet",
    emptyCanCreate: "Click “New project” to link an existing GitHub/GitLab repo or create a new repo for agents.",
    emptyCannotCreate:
      "You are not in any team with projects. Ask a team admin to create a project or add you to a team.",
    noMatch: "No projects match these filters.",
    clearFilters: "Clear filters",
    colProject: "Project",
    colRepo: "Repo",
    colTeam: "Owning team",
    colStatus: "Status",
    colPlan: "Plan mode",
    colSandbox: "Sandbox",
    colRunning: "Running",
    colCost: `Cost, ${COST_DAYS} days`,
    config: "Settings",
    viewConfig: "View settings",
    newTabSr: "(opens in a new tab)",
    costRestricted: "Only owning team admins can view cost",
    filterStatus: "Status",
    filterTeam: "Team",
    filterAll: "All",
    on: "On",
    off: "Off",
    rowsMatched: (matched, total) => `${matched} of ${total} rows match`,
  },
};

/** /projects: dự án của mọi đội mình có vai trò. */
export function ProjectsPage() {
  const me = useMe();
  const { org, api } = useOrg();
  const t = useT(text);
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const teams = useQuery(api.teams.list.queryOptions());
  const members = useQuery(api.orgMembers.list.queryOptions());
  const latest = useQuery(api.runs.latest.queryOptions({ input: {}, refetchInterval: REFRESH_MS }));
  const roleOf = teamRoleLookup(org.role, members.data, me.id);

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
  if (projects.isPending) {
    body = (
      <p aria-busy="true" className="text-muted-foreground">
        {t.loading}
      </p>
    );
  } else if (projects.isError) {
    body = <Alert variant="destructive">{apiErrorMessage(projects.error)}</Alert>;
  } else if (projects.data.length === 0) {
    body = <EmptyProjects canCreate={canCreate} />;
  } else {
    body = (
      <ProjectTable
        projects={projects.data}
        teams={new Map((teams.data ?? []).map((team) => [team.id, team]))}
        running={latest.data ? activeRunCounts(latest.data) : undefined}
        costOf={costOf}
        canManage={(p) => roleOf(p.teamId) === "admin"}
      />
    );
  }

  return (
    <>
      <PageHeader crumb={org.name} title={t.title}>
        {canCreate && <CreateProjectButton />}
      </PageHeader>
      <PageBody>
        <p className="-mt-2 text-sm text-muted-foreground">{t.lead}</p>
        {body}
      </PageBody>
    </>
  );
}

function EmptyProjects({ canCreate }: { canCreate: boolean }) {
  const t = useT(text);
  return (
    <Card className="grid justify-items-center gap-2 px-6 py-10 text-center">
      <span className="mb-1 grid size-10 place-items-center rounded-lg bg-accent text-accent-foreground">
        <Icon name="folder" className="size-5" />
      </span>
      <h2 className="text-base font-semibold text-foreground">{t.emptyTitle}</h2>
      <p className="max-w-md text-muted-foreground">{canCreate ? t.emptyCanCreate : t.emptyCannotCreate}</p>
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
  running: Map<string, number> | undefined;
  costOf: Map<string, { data?: CostSummary | undefined; isPending: boolean } | undefined>;
  canManage: (p: Project) => boolean;
}) {
  const t = useT(text);
  const lang = useLang();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [teamFilter, setTeamFilter] = useState<string>("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter((p) => {
      if (statusFilter !== "all" && p.state !== statusFilter) return false;
      if (teamFilter !== "all" && p.teamId !== teamFilter) return false;
      if (!q) return true;
      const matchName = p.name.toLowerCase().includes(q);
      const matchKey = p.key.toLowerCase().includes(q);
      const matchRepo = repoPath(p).toLowerCase().includes(q);
      return matchName || matchKey || matchRepo;
    });
  }, [projects, query, statusFilter, teamFilter]);

  const uniqueTeams = useMemo(() => {
    const ids = new Set(projects.map((p) => p.teamId));
    return Array.from(ids)
      .map((id) => teams.get(id))
      .filter((tm): tm is TeamWithCounts => Boolean(tm));
  }, [projects, teams]);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 max-w-sm flex-1">
          <Input
            value={query}
            onValueChange={setQuery}
            placeholder={t.search}
            aria-label={t.search}
            className="h-8 pl-8 text-xs"
          />
          <span className="pointer-events-none absolute top-2 left-2.5 text-muted-foreground">
            <SearchIcon className="size-3.5" />
          </span>
        </div>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label={t.filterStatus}
          className="h-8 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="all">
            {t.filterStatus}: {t.filterAll}
          </option>
          {Object.entries(PROJECT_STATE).map(([state, item]) => (
            <option key={state} value={state}>
              {item.label[lang]}
            </option>
          ))}
        </select>

        {uniqueTeams.length > 0 && (
          <select
            value={teamFilter}
            onChange={(e) => setTeamFilter(e.target.value)}
            aria-label={t.filterTeam}
            className="h-8 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="all">
              {t.filterTeam}: {t.filterAll}
            </option>
            {uniqueTeams.map((tm) => (
              <option key={tm.id} value={tm.id}>
                {tm.name}
              </option>
            ))}
          </select>
        )}

        {(query || statusFilter !== "all" || teamFilter !== "all") && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery("");
              setStatusFilter("all");
              setTeamFilter("all");
            }}
          >
            {t.clearFilters}
          </Button>
        )}

        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {t.rowsMatched(filtered.length, projects.length)}
        </span>
      </div>

      <Card className="overflow-hidden">
        {filtered.length === 0 ? (
          <div className="grid justify-items-center gap-2 p-8 text-center text-muted-foreground">
            <p>{t.noMatch}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setQuery("");
                setStatusFilter("all");
                setTeamFilter("all");
              }}
            >
              {t.clearFilters}
            </Button>
          </div>
        ) : (
          <Table className="min-w-215">
            <caption className="sr-only">{t.title}</caption>
            <thead>
              <tr>
                <Th>{t.colProject}</Th>
                <Th>{t.colRepo}</Th>
                <Th>{t.colTeam}</Th>
                <Th>{t.colStatus}</Th>
                <Th className="text-right">{t.colRunning}</Th>
                <Th className="text-right">{t.colCost}</Th>
                <Th>
                  <span className="sr-only">{t.config}</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
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
                            <span className="sr-only"> {t.newTabSr}</span>
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
                        {state.label[lang]}
                      </Pill>
                    </Td>
                    <Td className="text-right text-foreground tabular-nums">
                      {running ? (running.get(p.id) ?? 0) : "—"}
                    </Td>
                    <Td className="text-right whitespace-nowrap text-foreground tabular-nums">
                      {!cost ? (
                        <span title={t.costRestricted} className="text-muted-foreground">
                          —<span className="sr-only">{t.costRestricted}</span>
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
                        {canManage(p) ? t.config : t.viewConfig}
                        <span className="sr-only"> {p.name}</span>
                      </Link>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
