import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { CostSummary, Project, TeamWithCounts } from "@xdev-hive/contracts";
import { Button, buttonVariants } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { EllipsisIcon, FolderIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { CreateProjectButton } from "@/components/create-project-dialog.tsx";
import { DataTable } from "@/components/data-table/data-table.tsx";
import { Icon } from "@/components/icons.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { EmptyState, LoadFailure, TableSkeleton } from "@/components/ui/query-state.tsx";
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
  emptyNeedGit: string;
  emptyNeedGitMember: string;
  emptyNeedSystem: string;
  connectGit: string;
  addSystem: string;
  createFirst: string;
  colProject: string;
  colTeam: string;
  colStatus: string;
  colRunning: string;
  colCost: string;
  actions: string;
  actionsFor: (name: string) => string;
  board: string;
  mergeQueue: string;
  sandbox: string;
  newTabSr: string;
  costRestricted: string;
  filterStatus: string;
  filterTeam: string;
}> = {
  vi: {
    title: "Dự án",
    lead: "Mỗi dự án nối một repo GitHub hoặc GitLab cho agent làm việc. Bấm một dòng để mở cấu hình dự án.",
    create: "Tạo dự án",
    search: "Tìm tên, key, repo…",
    loading: "Đang tải dự án…",
    emptyTitle: "Chưa có dự án nào",
    emptyCanCreate: "Bấm “Tạo dự án” để nối một repo GitHub/GitLab có sẵn hoặc tạo repo mới cho agent làm việc.",
    emptyCannotCreate: "Bạn chưa ở trong đội nào có dự án. Nhờ quản trị đội tạo dự án hoặc thêm bạn vào đội.",
    emptyNeedGit:
      "Bước đầu: kết nối GitHub hoặc GitLab để hub tạo repo, mở PR và nhận webhook. Sau đó tạo dự án từ repo có sẵn hoặc repo mới.",
    emptyNeedGitMember:
      "Tổ chức chưa kết nối GitHub hoặc GitLab. Nhờ quản trị tổ chức thêm kết nối trước khi tạo dự án.",
    emptyNeedSystem:
      "Dự án thuộc một hệ thống của đội. Thêm hệ thống (ví dụ “Cổng thanh toán”) cho đội ở trang Đội và hệ thống trước.",
    connectGit: "Kết nối GitHub/GitLab",
    addSystem: "Thêm hệ thống",
    createFirst: "Tạo dự án đầu tiên",
    colProject: "Dự án",
    colTeam: "Đội sở hữu",
    colStatus: "Trạng thái",
    colRunning: "Đang chạy",
    colCost: `Chi phí ${COST_DAYS} ngày`,
    actions: "Thao tác",
    actionsFor: (name) => `Thao tác với dự án ${name}`,
    board: "Bảng việc",
    mergeQueue: "Hàng merge",
    sandbox: "Sandbox",
    newTabSr: "(mở ở tab mới)",
    costRestricted: "Chỉ quản trị đội sở hữu xem được chi phí",
    filterStatus: "Trạng thái",
    filterTeam: "Đội",
  },
  en: {
    title: "Projects",
    lead: "Each project links a GitHub or GitLab repo for agents to work in. Click a row to open the project settings.",
    create: "New project",
    search: "Search name, key, repo…",
    loading: "Loading projects…",
    emptyTitle: "No projects yet",
    emptyCanCreate: "Click “New project” to link an existing GitHub/GitLab repo or create a new repo for agents.",
    emptyCannotCreate:
      "You are not in any team with projects. Ask a team admin to create a project or add you to a team.",
    emptyNeedGit:
      "First, connect GitHub or GitLab so the hub can create repos, open PRs and receive webhooks. Then create a project from an existing or new repo.",
    emptyNeedGitMember:
      "The organization has no GitHub or GitLab connection yet. Ask an organization admin to add one before creating projects.",
    emptyNeedSystem:
      "A project belongs to one of a team’s systems. Add a system (e.g. “Payment gateway”) on the Teams & systems page first.",
    connectGit: "Connect GitHub/GitLab",
    addSystem: "Add a system",
    createFirst: "Create the first project",
    colProject: "Project",
    colTeam: "Owning team",
    colStatus: "Status",
    colRunning: "Running",
    colCost: `Cost, ${COST_DAYS} days`,
    actions: "Actions",
    actionsFor: (name) => `Actions for project ${name}`,
    board: "Task board",
    mergeQueue: "Merge queue",
    sandbox: "Sandbox",
    newTabSr: "(opens in a new tab)",
    costRestricted: "Only owning team admins can view cost",
    filterStatus: "Status",
    filterTeam: "Team",
  },
};

/** /projects: dự án của mọi đội mình có vai trò. Bấm dòng mở cấu hình dự án (admin-layout.md § Decisions 2). */
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
  if (projects.isPending) body = <TableSkeleton label={t.loading} columns={6} />;
  else if (projects.isError) body = <LoadFailure error={projects.error} retry={projects.refetch} />;
  else if (projects.data.length === 0)
    body = <EmptyProjects canCreate={canCreate} ownsTeam={(teamId) => roleOf(teamId) === "admin"} />;
  else
    body = (
      <ProjectTable
        projects={projects.data}
        teams={new Map((teams.data ?? []).map((team) => [team.id, team]))}
        running={latest.data ? activeRunCounts(latest.data) : undefined}
        costOf={costOf}
      />
    );

  return (
    <>
      <PageHeader title={t.title} description={t.lead}>
        {canCreate && <CreateProjectButton />}
      </PageHeader>
      <PageBody>{body}</PageBody>
    </>
  );
}

/**
 * Chưa có dự án: chỉ ra bước còn thiếu (kết nối Git, hệ thống của đội) và nút làm bước đó, thay vì để người dùng mở
 * hộp thoại tạo dự án rồi mới biết thiếu gì.
 */
function EmptyProjects({ canCreate, ownsTeam }: { canCreate: boolean; ownsTeam: (teamId: string) => boolean }) {
  const t = useT(text);
  const { org, api } = useOrg();
  const connections = useQuery({ ...api.scmConnections.list.queryOptions(), enabled: canCreate });
  const systems = useQuery({ ...api.systems.list.queryOptions({ input: {} }), enabled: canCreate });
  const needGit = connections.data?.length === 0;
  const needSystem = !needGit && systems.data !== undefined && !systems.data.some((s) => ownsTeam(s.teamId));
  let lead = canCreate ? t.emptyCanCreate : t.emptyCannotCreate;
  let action: ReactNode =
    canCreate && connections.data && systems.data ? <CreateProjectButton label={t.createFirst} /> : null;
  if (canCreate && needGit) {
    const admin = isOrgAdmin(org.role);
    lead = admin ? t.emptyNeedGit : t.emptyNeedGitMember;
    action = admin ? (
      <Link to="/admin/git" className={buttonVariants({ variant: "default" })}>
        <Icon name="github" className="size-4" />
        {t.connectGit}
      </Link>
    ) : null;
  } else if (canCreate && needSystem) {
    lead = t.emptyNeedSystem;
    action = (
      <Link to="/admin/teams" className={buttonVariants({ variant: "default" })}>
        <Icon name="plus" className="size-4" />
        {t.addSystem}
      </Link>
    );
  }
  return <EmptyState icon={FolderIcon} title={t.emptyTitle} description={lead} action={action} />;
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
}: {
  projects: Project[];
  teams: Map<string, TeamWithCounts>;
  running: Map<string, number> | undefined;
  costOf: Map<string, { data?: CostSummary | undefined; isPending: boolean } | undefined>;
}) {
  const t = useT(text);
  const lang = useLang();
  const navigate = useNavigate();
  const teamOptions = useMemo(
    () =>
      [...new Set(projects.map((p) => p.teamId))].flatMap((id) => {
        const team = teams.get(id);
        return team ? [{ value: team.id, label: team.name }] : [];
      }),
    [projects, teams],
  );

  return (
    <DataTable
      rows={projects}
      rowLabel={(p) => p.name}
      caption={t.title}
      placeholder={t.search}
      selectable={false}
      minWidth={720}
      onRowClick={(p) => void navigate({ to: "/projects/$key/settings", params: { key: p.key } })}
      facets={[
        {
          key: "state",
          label: t.filterStatus,
          value: (p) => p.state,
          options: Object.entries(PROJECT_STATE).map(([value, item]) => ({ value, label: item.label[lang] })),
        },
        ...(teamOptions.length > 0
          ? [{ key: "team", label: t.filterTeam, value: (p: Project) => p.teamId, options: teamOptions }]
          : []),
      ]}
      columns={[
        {
          key: "project",
          label: t.colProject,
          value: (p) => `${p.name} ${p.key} ${repoPath(p)}`,
          sortable: true,
          hideable: false,
          pin: "start",
          cell: (p) => (
            <span className="grid min-w-44 leading-tight">
              <Link
                to="/projects/$key"
                params={{ key: p.key }}
                className="truncate font-medium text-primary hover:text-primary/90"
              >
                {p.name}
              </Link>
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <span className="font-mono">{p.key}</span>
                <span aria-hidden="true">·</span>
                <Icon name={p.repo.kind} className="size-3.5 shrink-0" />
                <span className="sr-only">{SCM_LABEL[p.repo.kind]}: </span>
                {p.repo.webUrl ? (
                  <a
                    href={p.repo.webUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate font-mono text-primary hover:text-primary/90"
                  >
                    {repoPath(p)}
                    <span className="sr-only"> {t.newTabSr}</span>
                  </a>
                ) : (
                  <span className="truncate font-mono">{repoPath(p)}</span>
                )}
              </span>
            </span>
          ),
        },
        {
          key: "team",
          label: t.colTeam,
          value: (p) => teams.get(p.teamId)?.name,
          className: "whitespace-nowrap",
          cell: (p) => <TeamCell team={teams.get(p.teamId)} />,
        },
        {
          key: "state",
          label: t.colStatus,
          value: (p) => PROJECT_STATE[p.state].label[lang],
          cell: (p) => (
            <Pill tone={PROJECT_STATE[p.state].tone} dot>
              {PROJECT_STATE[p.state].label[lang]}
            </Pill>
          ),
        },
        {
          key: "running",
          label: t.colRunning,
          value: (p) => running?.get(p.id) ?? 0,
          align: "end",
          cell: (p) => (running ? (running.get(p.id) ?? 0) : "—"),
        },
        {
          key: "cost",
          label: t.colCost,
          value: (p) => costOf.get(p.id)?.data?.total.costUsd,
          sortable: true,
          align: "end",
          className: "whitespace-nowrap",
          cell: (p) => {
            const cost = costOf.get(p.id);
            if (!cost)
              return (
                <span title={t.costRestricted} className="text-muted-foreground">
                  —<span className="sr-only">{t.costRestricted}</span>
                </span>
              );
            if (cost.data) return formatUsd(cost.data.total.costUsd);
            return <span className="text-muted-foreground">{cost.isPending ? "…" : "—"}</span>;
          },
        },
        {
          key: "actions",
          label: t.actions,
          value: () => null,
          hideable: false,
          align: "end",
          pin: "end",
          cell: (p) => (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t.actionsFor(p.name)} />}>
                <EllipsisIcon aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuItem onClick={() => void navigate({ to: "/projects/$key", params: { key: p.key } })}>
                  {t.board}
                </DropdownMenuItem>
                {p.settings?.features?.mergeQueue && (
                  <DropdownMenuItem
                    onClick={() => void navigate({ to: "/projects/$key/merge-queue", params: { key: p.key } })}
                  >
                    {t.mergeQueue}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => void navigate({ to: "/projects/$key/sandbox", params: { key: p.key } })}
                >
                  {t.sandbox}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ),
        },
      ]}
    />
  );
}
