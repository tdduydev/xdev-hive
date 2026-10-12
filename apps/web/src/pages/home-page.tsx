import { useQuery } from "@tanstack/react-query";
import { Link, type LinkProps } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  FolderPlusIcon,
  KanbanSquareIcon,
  type LucideIcon,
  MailIcon,
  MessagesSquareIcon,
  MonitorIcon,
  PlayIcon,
  UserPlusIcon,
} from "lucide-react";
import { Alert } from "../components/ui/alert.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/ui/empty.tsx";
import { Pill } from "../components/ui/pill.tsx";
import { LoadingState } from "../components/ui/query-state.tsx";
import { StatTile } from "../components/ui/stat-tile.tsx";
import { apiErrorMessage } from "../lib/api-errors.ts";
import { ORG_ROLE_LABEL } from "../lib/roles.ts";
import { type BoardRow, boardRows, boardStats } from "../lib/task-board.ts";
import { useNow } from "../lib/use-now.ts";
import { useMe } from "../shell/me-context.ts";
import { type CurrentOrg, useOrgs } from "../shell/org-context.ts";
import { PageBody, PageHeader } from "../shell/page-header.tsx";

const REFRESH_MS = 30_000;

/** Trang chủ: số liệu và việc cần mình xử lý trong tổ chức đang chọn, hoặc hướng dẫn khi chưa thuộc tổ chức nào. */
export function HomePage() {
  const me = useMe();
  const { current } = useOrgs();
  return (
    <>
      <PageHeader
        crumb={current ? `${current.org.name} · ${ORG_ROLE_LABEL[current.org.role]}` : undefined}
        title={`Chào ${me.name}`}
      />
      <PageBody>
        {current ? (
          <OrgOverview current={current} />
        ) : (
          <Empty className="border border-dashed border-border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MailIcon aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle role="heading" aria-level={2}>
                Chưa thuộc tổ chức nào
              </EmptyTitle>
              <EmptyDescription>
                Nhờ quản trị tổ chức gửi lời mời tới <span className="font-medium text-foreground">{me.email}</span>.
                Khi đã vào tổ chức, dự án và việc của đội sẽ hiện ở đây.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </PageBody>
    </>
  );
}

function OrgOverview({ current }: { current: CurrentOrg }) {
  const { api } = current;
  const tasks = useQuery(api.tasks.list.queryOptions({ input: {}, refetchInterval: REFRESH_MS }));
  const runs = useQuery(api.runs.latest.queryOptions({ input: {}, refetchInterval: REFRESH_MS }));
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const now = useNow(REFRESH_MS);

  if (tasks.isPending || runs.isPending) return <LoadingState />;
  if (tasks.isError || runs.isError) {
    return <Alert variant="destructive">{apiErrorMessage(tasks.error ?? runs.error)}</Alert>;
  }
  const rows = boardRows(tasks.data, runs.data);
  const attention = rows.filter((r) => r.task.status === "awaiting_plan" || r.badge.group === "review").slice(0, 8);
  const noProjects = projects.isSuccess && projects.data.length === 0;

  return (
    <>
      <section aria-label="Số liệu" className="grid grid-cols-2 gap-3 app:grid-cols-4">
        {boardStats(rows, now).map((s) => (
          <StatTile key={s.label} label={s.label} value={s.value} hint={s.hint} />
        ))}
      </section>
      <div className="grid gap-4 app:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {noProjects ? <GettingStarted /> : <Attention rows={attention} />}
        <QuickLinks />
      </div>
    </>
  );
}

function Attention({ rows }: { rows: BoardRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Cần bạn xử lý
        </CardTitle>
        <CardDescription>Kế hoạch chờ duyệt và việc đã xong phần agent, chờ review hoặc merge.</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-muted-foreground">Không có việc nào đang chờ bạn.</p>
        ) : (
          <ul className="grid divide-y divide-border">
            {rows.map(({ task, run, badge }) => (
              <li key={task.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0">
                <span className="font-mono text-xs text-muted-foreground">{task.key}</span>
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">{task.title}</span>
                <Pill tone={badge.tone} dot>
                  {badge.label}
                </Pill>
                {task.status === "awaiting_plan" ? (
                  <Link
                    to="/tasks/$key/plan"
                    params={{ key: task.key }}
                    className="text-xs text-primary hover:underline"
                  >
                    Duyệt kế hoạch
                  </Link>
                ) : run ? (
                  <Link to="/runs/$id" params={{ id: run.id }} className="text-xs text-primary hover:underline">
                    Xem run
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const STEPS: { icon: LucideIcon; title: string; text: string; to: NonNullable<LinkProps["to"]> }[] = [
  {
    icon: FolderPlusIcon,
    title: "Tạo dự án",
    text: "Nối repo GitHub hoặc GitLab; hub tạo nhánh bảo vệ, webhook và file hướng dẫn cho agent.",
    to: "/projects",
  },
  {
    icon: MonitorIcon,
    title: "Thêm máy",
    text: "Cài worker bằng một lệnh trên máy đã đăng nhập Claude Code, Codex hoặc Gemini CLI.",
    to: "/machines" as NonNullable<LinkProps["to"]>,
  },
  {
    icon: UserPlusIcon,
    title: "Mời thành viên",
    text: "Mời người vào tổ chức và đội để cùng giao việc, review và merge.",
    to: "/admin/members",
  },
];

function GettingStarted() {
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Bắt đầu
        </CardTitle>
        <CardDescription>Tổ chức chưa có dự án. Ba bước để giao việc đầu tiên cho agent.</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="grid gap-3">
          {STEPS.map(({ icon: IconComponent, title, text, to }, index) => (
            <li key={title}>
              <Link
                to={to}
                className="flex items-start gap-3 rounded-lg p-2.5 ring-1 ring-foreground/10 transition-colors hover:bg-muted"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-accent text-accent-foreground">
                  <IconComponent className="size-4" aria-hidden="true" />
                </span>
                <span className="grid gap-0.5">
                  <span className="font-medium text-foreground">
                    {index + 1}. {title}
                  </span>
                  <span className="text-xs text-muted-foreground">{text}</span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

const LINKS: { icon: LucideIcon; label: string; to: NonNullable<LinkProps["to"]> }[] = [
  { icon: KanbanSquareIcon, label: "Bảng việc", to: "/tasks" },
  { icon: PlayIcon, label: "Lượt chạy", to: "/runs" },
  { icon: MessagesSquareIcon, label: "Leader", to: "/leader" },
  { icon: MonitorIcon, label: "Máy", to: "/machines" as NonNullable<LinkProps["to"]> },
];

function QuickLinks() {
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Đi nhanh
        </CardTitle>
      </CardHeader>
      <CardContent>
        <nav aria-label="Đi nhanh" className="grid gap-1">
          {LINKS.map(({ icon: IconComponent, label, to }) => (
            <Link
              key={label}
              to={to}
              className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-muted"
            >
              <IconComponent className="size-4 text-muted-foreground" aria-hidden="true" />
              {label}
              <ArrowRightIcon
                className="ml-auto size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                aria-hidden="true"
              />
            </Link>
          ))}
        </nav>
      </CardContent>
    </Card>
  );
}
