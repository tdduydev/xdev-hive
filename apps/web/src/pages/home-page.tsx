import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@xdev-hive/ui/button";
import { GettingStarted } from "@/components/getting-started.tsx";
import { Card } from "@/components/ui/card.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";
import { boardRows } from "@/lib/task-board.ts";
import { useMe } from "@/shell/me-context.ts";
import { type CurrentOrg, useOrgs } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const text: Dict<{
  home: string;
  hello: string;
  noOrg: string;
  invite: string;
  joined: string;
  owner: string;
  admin: string;
  member: string;
  board: string;
  teams: string;
  members: string;
  running: string;
  waiting: string;
  online: string;
  stats: string;
  unavailable: string;
}> = {
  vi: {
    home: "Trang chủ",
    hello: "Chào",
    noOrg: "Chưa thuộc tổ chức nào",
    invite: "Nhờ quản trị tổ chức gửi lời mời tới",
    joined: ". Khi đã vào tổ chức, dự án và việc của đội sẽ hiện ở đây.",
    owner: "Bạn là chủ sở hữu của tổ chức này. Việc của các dự án nằm ở bảng việc.",
    admin: "Bạn là quản trị của tổ chức này. Việc của các dự án nằm ở bảng việc.",
    member: "Bạn là thành viên của tổ chức này. Việc của các dự án nằm ở bảng việc.",
    board: "Bảng việc",
    teams: "Đội và hệ thống",
    members: "Thành viên",
    running: "run đang chạy",
    waiting: "việc chờ bạn",
    online: "máy trực tuyến",
    stats: "Số liệu",
    unavailable: "Không tải được số máy trực tuyến.",
  },
  en: {
    home: "Home",
    hello: "Hi,",
    noOrg: "Not in an organization yet",
    invite: "Ask an organization admin to send an invitation to",
    joined: ". Once you join, your team’s projects and tasks show up here.",
    owner: "You are an owner of this organization. Project tasks live on the board.",
    admin: "You are an admin of this organization. Project tasks live on the board.",
    member: "You are a member of this organization. Project tasks live on the board.",
    board: "Board",
    teams: "Teams & systems",
    members: "Members",
    running: "runs in progress",
    waiting: "tasks waiting on you",
    online: "machines online",
    stats: "Statistics",
    unavailable: "Could not load the online machine count.",
  },
};
const REFRESH_MS = 30_000;

export function HomePage() {
  const t = useT(text);
  const me = useMe();
  const { current } = useOrgs();
  return (
    <>
      <PageHeader crumb={current?.org.name ?? t.home} title={t.home} />
      <PageBody>
        <div className="mx-auto mt-6 grid w-full max-w-xl gap-4 sm:mt-10">
          {current && <GettingStarted current={current} />}
          <Card className="grid gap-5 p-5 sm:p-8">
            <h2 className="font-mono text-sm font-normal text-muted-foreground">
              {t.hello} {me.name}
            </h2>
            {current ? (
              <OrgOverview current={current} />
            ) : (
              <>
                <h2 className="font-heading text-2xl font-semibold">{t.noOrg}</h2>
                <p className="text-muted-foreground">
                  {t.invite} <strong className="break-all font-mono font-medium text-foreground">{me.email}</strong>
                  {t.joined}
                </p>
              </>
            )}
          </Card>
        </div>
      </PageBody>
    </>
  );
}

function OrgOverview({ current }: { current: CurrentOrg }) {
  const t = useT(text);
  const { api, org } = current;
  const tasks = useQuery(api.tasks.list.queryOptions({ input: {}, refetchInterval: REFRESH_MS }));
  const runs = useQuery(api.runs.latest.queryOptions({ input: {}, refetchInterval: REFRESH_MS }));
  const teams = useQuery(api.teams.list.queryOptions());
  const machines = useQueries({
    queries: (teams.data ?? []).map((team) =>
      api.machines.list.queryOptions({ input: { teamId: team.id }, refetchInterval: REFRESH_MS }),
    ),
  });
  const machineLoading = teams.isPending || machines.some((query) => query.isPending);
  const machineError = teams.isError || machines.some((query) => query.isError);
  const online = new Set(
    machines
      .flatMap((query) => query.data ?? [])
      .filter((machine) => machine.status === "online")
      .map((machine) => machine.id),
  ).size;
  const rows = boardRows(tasks.data ?? [], runs.data ?? []);
  // runs.latest chỉ trả run code gần nhất; số liệu này không đại diện toàn bộ lịch sử chạy.
  const active =
    runs.data?.filter((run) => ["leased", "preparing", "running", "verifying", "cancelling"].includes(run.state))
      .length ?? 0;
  const waiting = rows.filter((row) => row.task.status === "awaiting_plan" || row.badge.group === "review").length;
  return (
    <>
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary font-mono text-xl font-semibold text-primary-foreground"
        >
          {org.name.slice(0, 1)}
        </span>
        <h2 className="min-w-0 break-words font-heading text-2xl font-semibold">{org.name}</h2>
      </div>
      <p className="text-muted-foreground">{t[org.role]}</p>
      {tasks.isPending || runs.isPending ? (
        <LoadingState />
      ) : tasks.isError || runs.isError ? (
        <LoadFailure
          error={tasks.error ?? runs.error}
          retry={() => {
            void tasks.refetch();
            void runs.refetch();
          }}
        />
      ) : (
        <section aria-label={t.stats} className="grid grid-cols-3 gap-2.5">
          {[
            { label: t.running, value: String(active) },
            { label: t.waiting, value: String(waiting) },
            { label: t.online, value: machineError ? "—" : machineLoading ? "…" : String(online) },
          ].map((stat) => (
            <div key={stat.label} className="grid gap-0.5 rounded-lg border border-border p-3">
              <span className="font-mono text-2xl font-semibold tabular-nums">{stat.value}</span>
              <span className="text-xs text-muted-foreground">{stat.label}</span>
            </div>
          ))}
        </section>
      )}
      {machineError && (
        <p role="status" className="text-xs text-muted-foreground">
          {t.unavailable}
        </p>
      )}
      <nav aria-label={t.home} className="flex flex-wrap gap-2">
        <Button nativeButton={false} role="link" render={<Link to="/tasks" />}>
          {t.board}
        </Button>
        <Button variant="outline" nativeButton={false} role="link" render={<Link to="/admin/teams" />}>
          {t.teams}
        </Button>
        <Button variant="outline" nativeButton={false} role="link" render={<Link to="/admin/members" />}>
          {t.members}
        </Button>
      </nav>
    </>
  );
}
