// Landing page. Follows the sidebar scope: every project at a glance, the team-wide (shared) data, or one project.
import { Fragment, type ComponentType, type ReactNode } from "react";
import { Bot, ChevronRight, FileText, FolderGit2, GitPullRequestArrow, Layers, ListTodo, Server, Sparkles, Users } from "lucide-react";
import { cn } from "cn";
import type { DesktopSettings, DocSummary, Memory, MemoryKind, PolicyRepoPart, Proposal, Task, TaskStatus } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Skeleton } from "@xdev-hive/ui/components/ui/skeleton";
import { Badge, Empty, ErrorNote, OwnerBadge, Page, PageHeader, STATUS_TONE, StatusDot } from "../components/common.tsx";
import { formatTime, useHive, useQuery, type QueryState } from "../hooks.ts";
import { ALL, SHARED, docOwner, projectScope, scopeLabel } from "../lib/scope.ts";
import { ROLE_LABEL, RUN_LABEL } from "./Board.tsx";

type Icon = ComponentType<{ className?: string }>;
type OpenStatus = Exclude<TaskStatus, "done">;

/** Open statuses, most urgent first. */
const OPEN: OpenStatus[] = ["doing", "blocked", "review", "todo"];
const TASK_LABEL: Record<TaskStatus, string> = {
  todo: "chưa làm",
  doing: "đang làm",
  review: "chờ review",
  done: "xong",
  blocked: "bị chặn",
};
const KIND_LABEL: Record<MemoryKind, string> = {
  decision: "Quyết định",
  convention: "Quy ước",
  gotcha: "Lưu ý",
  context: "Bối cảnh",
};
const PART_LABEL: Record<PolicyRepoPart, string> = {
  agents: "Cấu hình agent",
  "codegraph-mcp": "codegraph (MCP)",
  "codegraph-index": "Index codegraph",
  superpowers: "superpowers",
};
/** memory.list returns at most this many rows. */
const MEMORY_LIMIT = 500;
/** tasks.list returns at most this many rows. */
const TASK_LIMIT = 500;

const isOpen = (t: Task): t is Task & { status: OpenStatus } => t.status !== "done";
const byUrgency = (a: Task, b: Task) => OPEN.indexOf(a.status as OpenStatus) - OPEN.indexOf(b.status as OpenStatus);
/** Still waiting for its first answer (a later reload keeps the old data on screen). */
const waiting = (q: QueryState<unknown>) => q.data === undefined && !q.error;
/** Owner of a doc: null when shared by every project. */
const docOwnerOf = (d: DocSummary) => (d.scope === "org" ? null : d.project);

function countBy<T>(items: T[] | undefined, owner: (item: T) => string | null): Map<string, number> | undefined {
  if (!items) return undefined;
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = owner(item) ?? "";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function OverviewPage() {
  const { scope } = useHive();
  if (scope.kind === "shared") return <SharedOverview />;
  if (scope.kind === "project") return <ProjectOverview key={scope.project} project={scope.project} />;
  return <AllOverview />;
}

// ── all projects ───────────────────────────────────────────────────────────

function AllOverview() {
  const { client, projects, setScope } = useHive();
  const desktop = client.desktop;
  const docs = useQuery(() => client.call("docs.list", {}), [client]);
  const memory = useQuery(() => client.call("memory.list", { limit: MEMORY_LIMIT }), [client]);
  const tasks = useQuery(() => client.call("tasks.list", {}), [client]);
  const proposals = useQuery(() => client.call("proposals.list", { status: "pending" }), [client]);
  const settings = useQuery(async () => (desktop ? desktop.settings() : null), [desktop]);

  const docCount = countBy(docs.data, docOwnerOf);
  const memoryCount = countBy(memory.data, (m) => m.project);
  const proposalCount = countBy(proposals.data, (p) => docOwner(p.docKey));
  const openTasks = new Map<string, Record<OpenStatus, number>>();
  for (const t of tasks.data ?? []) {
    if (!isOpen(t)) continue;
    const row = openTasks.get(t.project) ?? { doing: 0, blocked: 0, review: 0, todo: 0 };
    row[t.status] += 1;
    openTasks.set(t.project, row);
  }
  const repos = new Map((settings.data?.projects ?? []).map((p) => [p.name, p.repo]));

  // The shell's list loads on its own; add what this page already sees so a new project never waits for it.
  const names = new Set(projects);
  for (const d of docs.data ?? []) if (d.scope === "project" && d.project) names.add(d.project);
  for (const t of tasks.data ?? []) names.add(t.project);
  for (const m of memory.data ?? []) if (m.project) names.add(m.project);
  for (const name of repos.keys()) names.add(name);
  const list = [...names].sort();

  const loading = [docs, memory, tasks, proposals, settings].some(waiting);
  const errors = [...new Set([docs.error, memory.error, tasks.error, proposals.error, settings.error].filter(Boolean))];
  const capped = (memory.data?.length ?? 0) >= MEMORY_LIMIT || (tasks.data?.length ?? 0) >= TASK_LIMIT;
  const value = (counts: Map<string, number> | undefined, key: string) => (counts ? (counts.get(key) ?? 0) : undefined);

  return (
    <Page>
      <PageHeader
        title="Tổng quan"
        subtitle="Mỗi dự án có tài liệu, memory và task riêng; phần Chung áp dụng cho mọi dự án. Chọn một thẻ để làm việc trong phạm vi đó (đổi lại ở thanh bên)."
      />
      {errors.length ? <ErrorNote error={errors.join("\n")} /> : null}

      <ClickCard
        onOpen={() => setScope(SHARED)}
        label="Xem dữ liệu chung"
        className="border-brand/30 bg-brand-soft/50 hover:border-brand/50 hover:bg-brand-soft/70"
        icon={Users}
        iconClassName="text-brand-soft-foreground"
        title={scopeLabel(SHARED)}
        titleClassName="text-brand-soft-foreground"
        description="Tài liệu và memory dùng cho mọi dự án: agent ở dự án nào cũng đọc được."
      >
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Count label="tài liệu chung" value={value(docCount, "")} loading={waiting(docs)} />
          <Count label="memory chung" value={value(memoryCount, "")} loading={waiting(memory)} />
          <Count label="đề xuất chờ duyệt" value={value(proposalCount, "")} loading={waiting(proposals)} warnIfAny />
        </dl>
      </ClickCard>

      <section className="flex flex-col gap-3">
        <h2 className="flex items-baseline gap-2 text-sm font-semibold">
          Dự án
          {list.length ? <span className="font-normal text-muted-foreground tabular-nums">{list.length}</span> : null}
        </h2>
        {list.length === 0 && loading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-40 rounded-xl" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <NoProjects desktop={!!desktop} />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((p) => {
              const open = openTasks.get(p);
              return (
                <ClickCard
                  key={p}
                  onOpen={() => setScope(projectScope(p))}
                  label={`Xem dự án ${p}`}
                  icon={FolderGit2}
                  title={p}
                  titleClassName="font-mono text-sm"
                  description={repos.get(p) ? <span className="font-mono text-xs break-all">{repos.get(p)}</span> : undefined}
                >
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                    <Count label="tài liệu riêng" value={value(docCount, p)} loading={waiting(docs)} />
                    <Count label="memory riêng" value={value(memoryCount, p)} loading={waiting(memory)} />
                    <Count
                      label="task mở"
                      value={tasks.data ? OPEN.reduce((n, s) => n + (open?.[s] ?? 0), 0) : undefined}
                      loading={waiting(tasks)}
                    />
                    <Count label="đề xuất chờ duyệt" value={value(proposalCount, p)} loading={waiting(proposals)} warnIfAny />
                  </dl>
                  {open ? (
                    <div className="flex flex-wrap gap-1.5">
                      {OPEN.filter((s) => open[s] > 0).map((s) => (
                        <Badge key={s} tone={STATUS_TONE[s]}>
                          {open[s]} {TASK_LABEL[s]}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </ClickCard>
              );
            })}
          </div>
        )}
        {capped ? <p className="text-xs text-muted-foreground">Số liệu tính trên {MEMORY_LIMIT} memory và {TASK_LIMIT} task cập nhật gần nhất.</p> : null}
      </section>
    </Page>
  );
}

function NoProjects({ desktop }: { desktop: boolean }) {
  const { me } = useHive();
  // A hub account sees only the projects an admin granted it.
  if (me.access) {
    return (
      <Empty>
        <div className="flex flex-col items-center gap-2">
          <p className="font-medium text-foreground">Bạn chưa được cấp dự án nào.</p>
          <p className="max-w-md">Hiện bạn chỉ thấy dữ liệu Chung của team. Nhờ admin cấp quyền các dự án bạn cần.</p>
        </div>
      </Empty>
    );
  }
  return (
    <Empty>
      <div className="flex flex-col items-center gap-3">
        <p className="font-medium text-foreground">Chưa có dự án nào.</p>
        <p className="max-w-md">
          {desktop
            ? "Thêm repo ở Dự án & cài đặt, hoặc tạo tài liệu/task cho một dự án. Dự án sẽ hiện ở đây."
            : "Tạo tài liệu/task cho một dự án, hoặc thêm repo ở Dự án & cài đặt trong app desktop. Dự án sẽ hiện ở đây."}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {desktop ? (
            <Button asChild size="sm">
              <a href="#/projects">Dự án &amp; cài đặt</a>
            </Button>
          ) : null}
          <Button asChild variant="outline" size="sm">
            <a href="#/docs">Tài liệu</a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href="#/tasks">Task</a>
          </Button>
        </div>
      </div>
    </Empty>
  );
}

/**
 * A card that opens a scope. The title button stretches over the whole card, so the card is one keyboard stop.
 * The header is a plain div: CardHeader is a size container, which would clip the stretched button to itself.
 */
function ClickCard(props: {
  onOpen: () => void;
  label: string;
  icon: Icon;
  iconClassName?: string;
  title: string;
  titleClassName?: string;
  description?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <Card
      className={cn(
        "relative min-w-0 gap-4 py-5 transition-colors hover:border-foreground/20 has-[button:focus-visible]:ring-[3px] has-[button:focus-visible]:ring-ring/50",
        props.className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1.5 px-5">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className={cn("size-4 shrink-0 text-muted-foreground", props.iconClassName)} />
          <button
            type="button"
            onClick={props.onOpen}
            aria-label={props.label}
            className={cn(
              "min-w-0 cursor-pointer text-left leading-snug font-semibold wrap-anywhere outline-none after:absolute after:inset-0 after:rounded-xl",
              props.titleClassName,
            )}
          >
            {props.title}
          </button>
          <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" />
        </div>
        {props.description ? <div className="text-sm text-muted-foreground">{props.description}</div> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-3 px-5">{props.children}</div>
    </Card>
  );
}

function Count({ label, value, loading, warnIfAny }: { label: string; value: number | undefined; loading: boolean; warnIfAny?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col-reverse gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("text-xl font-semibold tabular-nums", warnIfAny && !!value && "text-warning")}>
        {loading ? <Skeleton className="h-7 w-10" /> : (value ?? "—")}
      </dd>
    </div>
  );
}

// ── shared (team-wide) ─────────────────────────────────────────────────────

function SharedOverview() {
  const { client, setScope } = useHive();
  const docs = useQuery(() => client.call("docs.list", { scope: "org" }), [client]);
  const memory = useQuery(() => client.call("memory.list", { project: null, limit: MEMORY_LIMIT }), [client]);
  const proposals = useQuery(() => client.call("proposals.list", { status: "pending" }), [client]);
  const shared = proposals.data?.filter((p) => docOwner(p.docKey) === null);
  const inAgents = docs.data?.filter((d) => d.includeInAgents).length ?? 0;
  const pendingMemory = memory.data?.filter((m) => m.status === "pending").length ?? 0;

  return (
    <Page>
      <PageHeader
        title={scopeLabel(SHARED)}
        subtitle="Tài liệu và memory ở đây áp dụng cho mọi dự án: agent ở dự án nào cũng đọc được, sửa ở đây là sửa cho cả team."
        actions={<AllProjectsButton onClick={() => setScope(ALL)} />}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          icon={FileText}
          label="Tài liệu chung"
          q={docs}
          parts={[{ value: docs.data?.length }]}
          detail={inAgents ? `${inAgents} đưa vào AGENTS.md` : undefined}
        />
        <StatCard
          icon={Sparkles}
          label="Memory chung"
          q={memory}
          parts={[{ value: memory.data?.length }]}
          detail={pendingMemory ? `${pendingMemory} chờ duyệt` : undefined}
        />
        <StatCard icon={GitPullRequestArrow} label="Đề xuất chờ duyệt" q={proposals} parts={[{ value: shared?.length }]} warnIfAny />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section icon={FileText} title="Tài liệu chung" action={<LinkButton href="#/docs">Tài liệu</LinkButton>}>
          <Load q={docs}>
            {(list) => <DocList docs={list} max={12} empty="Chưa có tài liệu chung." />}
          </Load>
        </Section>
        <Section icon={Sparkles} title="Memory chung gần đây" action={<LinkButton href="#/memory">Memory</LinkButton>}>
          <Load q={memory}>{(list) => <MemoryList items={list} max={10} empty="Chưa có memory chung." showOwner={false} />}</Load>
        </Section>
        <Section
          icon={GitPullRequestArrow}
          title="Đề xuất chờ duyệt"
          description="Đề xuất sửa tài liệu chung."
          action={<LinkButton href="#/proposals">Đề xuất</LinkButton>}
          className="lg:col-span-2"
        >
          <Load q={proposals}>{() => <ProposalList items={shared ?? []} max={8} empty="Không có đề xuất nào đang chờ." />}</Load>
        </Section>
      </div>
    </Page>
  );
}

// ── one project ────────────────────────────────────────────────────────────

function ProjectOverview({ project: p }: { project: string }) {
  const { client, me, setScope } = useHive();
  const desktop = client.desktop;
  const hubAdmin = me.mode === "hub" && me.role === "admin";
  // docs.list with a project returns its docs plus every shared (org) doc; memory likewise with includeShared.
  const docs = useQuery(() => client.call("docs.list", { project: p }), [client, p]);
  const memory = useQuery(() => client.call("memory.list", { project: p, includeShared: true, limit: MEMORY_LIMIT }), [client, p]);
  const tasks = useQuery(() => client.call("tasks.list", { project: p }), [client, p]);
  const proposals = useQuery(() => client.call("proposals.list", { status: "pending" }), [client]);
  const runs = useQuery(async () => (desktop ? desktop.runs({ project: p, limit: 5 }) : null), [desktop, p]);
  const settings = useQuery(async () => (desktop ? desktop.settings() : null), [desktop]);
  const machines = useQuery(async () => (hubAdmin ? client.call("admin.machines", {}) : null), [client, hubAdmin]);
  const policy = useQuery(async () => (hubAdmin ? client.call("policy.get", {}) : null), [client, hubAdmin]);

  const ownDocs = docs.data?.filter((d) => d.scope === "project" && d.project === p);
  const sharedDocs = docs.data?.filter((d) => d.scope === "org");
  const ownMemory = memory.data?.filter((m) => m.project === p).length;
  const sharedMemory = memory.data?.filter((m) => m.project === null).length;
  const open = tasks.data?.filter(isOpen).sort(byUrgency);
  const ownProposals = proposals.data?.filter((x) => docOwner(x.docKey) === p);
  const sharedProposals = proposals.data?.filter((x) => docOwner(x.docKey) === null).length ?? 0;
  const statusLine = open
    ? OPEN.map((s) => [s, open.filter((t) => t.status === s).length] as const)
        .filter(([, n]) => n > 0)
        .map(([s, n]) => `${n} ${TASK_LABEL[s]}`)
        .join(" · ")
    : "";

  return (
    // A project key has no spaces: let a long one wrap at 375px.
    <Page className="[&_h1]:wrap-anywhere">
      <PageHeader
        title={p}
        subtitle={`Dữ liệu riêng của ${p} cộng với dữ liệu chung áp dụng cho mọi dự án.`}
        actions={<AllProjectsButton onClick={() => setScope(ALL)} />}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={FileText}
          label="Tài liệu"
          q={docs}
          parts={[
            { value: ownDocs?.length, unit: "riêng" },
            { value: sharedDocs?.length, unit: "chung" },
          ]}
        />
        <StatCard
          icon={Sparkles}
          label="Memory"
          q={memory}
          parts={[
            { value: ownMemory, unit: "riêng" },
            { value: sharedMemory, unit: "chung" },
          ]}
        />
        <StatCard icon={ListTodo} label="Task mở" q={tasks} parts={[{ value: open?.length }]} detail={statusLine || undefined} />
        <StatCard
          icon={GitPullRequestArrow}
          label="Đề xuất chờ duyệt"
          q={proposals}
          parts={[{ value: ownProposals?.length }]}
          detail={sharedProposals ? `+ ${sharedProposals} trên tài liệu chung` : undefined}
          warnIfAny
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section icon={ListTodo} title="Task đang mở" action={<LinkButton href="#/tasks">Task</LinkButton>}>
          <Load q={tasks}>
            {() => (
              <Rows items={open ?? []} max={8} empty="Không có task nào đang mở." more={(n) => `${n} task mở khác`} href="#/tasks">
                {(t) => (
                  <li key={t.id} className={ROW}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={STATUS_TONE[t.status]}>{TASK_LABEL[t.status]}</Badge>
                      <span className="min-w-0 font-mono text-xs break-all text-muted-foreground">{t.id}</span>
                    </div>
                    <p className="text-sm break-words">{t.title}</p>
                    <p className="text-xs break-all text-muted-foreground">
                      {t.owner ?? "chưa ai nhận"} · {formatTime(t.updatedAt)}
                    </p>
                  </li>
                )}
              </Rows>
            )}
          </Load>
        </Section>

        <Section icon={FileText} title="Tài liệu" description="Tài liệu riêng của dự án." action={<LinkButton href="#/docs">Tài liệu</LinkButton>}>
          <Load q={docs}>
            {() => (
              <>
                <DocList docs={ownDocs ?? []} max={8} empty="Chưa có tài liệu riêng cho dự án này." />
                <a
                  href="#/docs"
                  className="flex flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  <OwnerBadge owner={null} />
                  {sharedDocs?.length ? `${sharedDocs.length} tài liệu chung cũng áp dụng` : "Chưa có tài liệu chung"}
                  <ChevronRight className="ml-auto size-4" />
                </a>
              </>
            )}
          </Load>
        </Section>

        <Section
          icon={Sparkles}
          title="Memory gần đây"
          description="Của dự án này và memory chung."
          action={<LinkButton href="#/memory">Memory</LinkButton>}
        >
          <Load q={memory}>{(list) => <MemoryList items={list} max={8} empty="Chưa có memory nào." />}</Load>
        </Section>

        {desktop ? (
          <Section icon={Bot} title="Lượt chạy gần đây" description="Agent chạy trên máy này." action={<LinkButton href="#/board">Board</LinkButton>}>
            <Load q={runs}>
              {(list) => (
                <Rows items={list ?? []} max={5} empty="Chưa có lượt chạy agent nào cho dự án này.">
                  {(r) => (
                    <li key={r.id} className={ROW}>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={STATUS_TONE[r.status]}>{RUN_LABEL[r.status]}</Badge>
                        <span className="min-w-0 font-mono text-xs break-all text-muted-foreground">{r.taskId}</span>
                      </div>
                      <p className="text-sm break-words">{r.taskTitle}</p>
                      <p className="text-xs break-all text-muted-foreground">
                        {ROLE_LABEL[r.role]} · {r.profileId ?? "chưa chọn gói"} · {formatTime(r.createdAt)}
                      </p>
                    </li>
                  )}
                </Rows>
              )}
            </Load>
          </Section>
        ) : null}

        {hubAdmin ? (
          <Section
            icon={Server}
            title="Máy có dự án này"
            description="Theo kết quả kiểm tra cài đặt mỗi máy gửi lên."
            action={<LinkButton href="#/admin">Quản trị</LinkButton>}
          >
            <Load q={machines}>
              {(list) => {
                const withProject = (list ?? []).flatMap((m) => {
                  const entry = m.setup?.projects.find((x) => x.project === p);
                  return entry ? [{ machine: m, entry }] : [];
                });
                return (
                  <Rows items={withProject} max={8} empty="Chưa máy nào báo có repo của dự án này.">
                    {({ machine: m, entry }) => {
                      const missing = entry.items.filter((i) => i.state !== "installed").length;
                      return (
                        <li key={m.id} className={ROW}>
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusDot tone={m.online ? "ok" : "neutral"} />
                            <span className="min-w-0 font-mono text-sm break-all">{m.machine}</span>
                            {missing ? <Badge tone="warn">{missing} mục chưa cài</Badge> : <Badge tone="ok">đã cài đủ</Badge>}
                          </div>
                          <p className="font-mono text-xs break-all text-muted-foreground">{entry.repo}</p>
                          <p className="text-xs text-muted-foreground">
                            {m.online ? "Đang hoạt động" : "Mất kết nối"} · heartbeat {formatTime(m.lastSeen)}
                          </p>
                        </li>
                      );
                    }}
                  </Rows>
                );
              }}
            </Load>
            <div className="flex flex-col gap-2 border-t pt-3">
              <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Chính sách yêu cầu</span>
              <Load q={policy} rows={1}>
                {(data) => {
                  const parts = data?.projects[p] ?? [];
                  return parts.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {parts.map((part) => (
                        <Badge key={part}>{PART_LABEL[part]}</Badge>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">Chính sách chưa yêu cầu phần nào cho dự án này.</p>
                  );
                }}
              </Load>
            </div>
          </Section>
        ) : null}

        {desktop ? <RepoSection project={p} q={settings} /> : null}
      </div>
    </Page>
  );
}

function RepoSection({ project, q }: { project: string; q: QueryState<DesktopSettings | null> }) {
  const repo = q.data?.projects.find((x) => x.name === project)?.repo;
  return (
    <Section
      icon={FolderGit2}
      title="Repo trên máy này"
      action={repo ? <LinkButton href="#/projects">Cài đặt</LinkButton> : undefined}
    >
      <Load q={q} rows={1}>
        {() =>
          repo ? (
            <code className="rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-all">{repo}</code>
          ) : (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted-foreground">Chưa thêm repo trên máy này.</p>
              <Button asChild size="sm">
                <a href="#/projects">Thêm repo</a>
              </Button>
            </div>
          )
        }
      </Load>
    </Section>
  );
}

// ── building blocks ────────────────────────────────────────────────────────

const ROW = "flex min-w-0 flex-col gap-1 py-2.5 first:pt-0 last:pb-0";

function AllProjectsButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <Layers />
      Tất cả dự án
    </Button>
  );
}

function LinkButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button asChild variant="outline" size="sm">
      <a href={href}>
        {children}
        <ChevronRight />
      </a>
    </Button>
  );
}

function Section(props: { icon: Icon; title: string; description?: string; action?: ReactNode; className?: string; children: ReactNode }) {
  const Icon = props.icon;
  return (
    <Card className={cn("min-w-0 gap-4", props.className)}>
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          {props.title}
        </CardTitle>
        {props.description ? <CardDescription>{props.description}</CardDescription> : null}
        {props.action ? <CardAction>{props.action}</CardAction> : null}
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">{props.children}</CardContent>
    </Card>
  );
}

/** A section body: skeleton rows while loading, the error on its own, otherwise the content. */
function Load<T>({ q, rows = 3, children }: { q: QueryState<T>; rows?: number; children: (data: T) => ReactNode }) {
  if (q.error) return <ErrorNote error={q.error} />;
  if (q.data === undefined) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        ))}
      </div>
    );
  }
  return <>{children(q.data)}</>;
}

function Rows<T>(props: { items: T[]; max: number; empty: string; more?: (n: number) => string; href?: string; children: (item: T) => ReactNode }) {
  if (props.items.length === 0) return <p className="text-sm text-muted-foreground">{props.empty}</p>;
  const rest = props.items.length - props.max;
  return (
    <>
      <ul className="flex flex-col divide-y">{props.items.slice(0, props.max).map(props.children)}</ul>
      {rest > 0 ? (
        props.href ? (
          <a href={props.href} className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            + {props.more ? props.more(rest) : `${rest} mục khác`}
          </a>
        ) : (
          <p className="text-xs text-muted-foreground">+ {props.more ? props.more(rest) : `${rest} mục khác`}</p>
        )
      ) : null}
    </>
  );
}

function DocList({ docs, max, empty }: { docs: DocSummary[]; max: number; empty: string }) {
  return (
    <Rows items={docs} max={max} empty={empty} more={(n) => `${n} tài liệu khác`} href="#/docs">
      {(d) => (
        <li key={d.key} className={ROW}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 text-sm font-medium break-words">{d.title}</span>
            {d.includeInAgents ? <Badge tone="info">đưa vào AGENTS.md</Badge> : null}
          </div>
          <p className="font-mono text-xs break-all text-muted-foreground">{d.key}</p>
          <p className="text-xs text-muted-foreground">
            v{d.version} · {formatTime(d.updatedAt)}
          </p>
        </li>
      )}
    </Rows>
  );
}

function MemoryList({ items, max, empty, showOwner = true }: { items: Memory[]; max: number; empty: string; showOwner?: boolean }) {
  return (
    <Rows items={items} max={max} empty={empty} more={(n) => `${n} memory khác`} href="#/memory">
      {(m) => (
        <li key={m.id} className={ROW}>
          <div className="flex flex-wrap items-center gap-2">
            {showOwner ? <OwnerBadge owner={m.project} /> : null}
            <span className="text-xs text-muted-foreground">{KIND_LABEL[m.kind]}</span>
            {m.status === "pending" ? <Badge tone={STATUS_TONE.pending}>chờ duyệt</Badge> : null}
          </div>
          <p className="line-clamp-3 text-sm break-words whitespace-pre-line">{m.content}</p>
          <p className="text-xs break-all text-muted-foreground">
            {m.author} · {formatTime(m.createdAt)}
          </p>
        </li>
      )}
    </Rows>
  );
}

function ProposalList({ items, max, empty }: { items: Proposal[]; max: number; empty: string }) {
  return (
    <Rows items={items} max={max} empty={empty} more={(n) => `${n} đề xuất khác`} href="#/proposals">
      {(p) => (
        <li key={p.id} className={ROW}>
          <p className="font-mono text-xs break-all text-muted-foreground">{p.docKey}</p>
          <p className="text-sm break-words">{p.reason}</p>
          <p className="text-xs break-all text-muted-foreground">
            {p.author} · {formatTime(p.createdAt)}
          </p>
        </li>
      )}
    </Rows>
  );
}

function StatCard(props: {
  icon: Icon;
  label: string;
  q: QueryState<unknown>;
  parts: Array<{ value: number | undefined; unit?: string }>;
  detail?: string;
  warnIfAny?: boolean;
}) {
  const Icon = props.icon;
  const warn = props.warnIfAny && props.parts.some((x) => !!x.value);
  return (
    <Card className={cn("min-w-0 gap-2 py-4", warn && "border-warning/35")}>
      <CardContent className="flex flex-col gap-1.5 px-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon className="size-3.5 shrink-0" />
          {props.label}
        </div>
        {waiting(props.q) ? (
          <Skeleton className="h-8 w-24" />
        ) : props.q.error ? (
          <div className="text-2xl font-semibold text-muted-foreground" title={props.q.error}>
            —
          </div>
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
            {props.parts.map((part, i) => (
              <Fragment key={i}>
                {i > 0 ? <span className="px-0.5 text-muted-foreground">·</span> : null}
                <span className={cn("text-2xl font-semibold tabular-nums", warn && "text-warning")}>{part.value ?? "—"}</span>
                {part.unit ? <span className="text-sm text-muted-foreground">{part.unit}</span> : null}
              </Fragment>
            ))}
          </div>
        )}
        {props.detail && !props.q.error ? <div className="text-xs text-muted-foreground">{props.detail}</div> : null}
      </CardContent>
    </Card>
  );
}
