// Landing page. Follows the sidebar scope: every project at a glance, the team-wide (shared) data, or one project.
import { Fragment, type ComponentType, type ReactNode } from "react";
import { Bot, ChevronRight, FileText, FolderGit2, GitPullRequestArrow, Layers, ListTodo, Server, Sparkles, Users } from "lucide-react";
import { cn } from "cn";
import type { DesktopSettings, DocSummary, Memory, Proposal, Task, TaskStatus } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Skeleton } from "@xdev-hive/ui/components/ui/skeleton";
import { Badge, Empty, ErrorNote, OwnerBadge, Page, PageHeader, STATUS_TONE, StatusDot } from "../components/common.tsx";
import { formatTime, useHive, useQuery, type QueryState } from "../hooks.ts";
import { useT, type TFunction } from "../i18n/index.tsx";
import { ALL, SHARED, docOwner, projectScope, scopeLabel } from "../lib/scope.ts";

type Icon = ComponentType<{ className?: string }>;
type OpenStatus = Exclude<TaskStatus, "done">;

/** Open statuses, most urgent first. */
const OPEN: OpenStatus[] = ["doing", "blocked", "review", "todo"];
/** "3 in progress": a count with the task status in lower case. */
const statusCount = (t: TFunction, n: number, s: TaskStatus) => `${n} ${t(`taskStatus.${s}`).toLocaleLowerCase()}`;
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
  const t = useT();
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
  for (const task of tasks.data ?? []) {
    if (!isOpen(task)) continue;
    const row = openTasks.get(task.project) ?? { doing: 0, blocked: 0, review: 0, todo: 0 };
    row[task.status] += 1;
    openTasks.set(task.project, row);
  }
  const repos = new Map((settings.data?.projects ?? []).map((p) => [p.name, p.repo]));

  // The shell's list loads on its own; add what this page already sees so a new project never waits for it.
  const names = new Set(projects);
  for (const d of docs.data ?? []) if (d.scope === "project" && d.project) names.add(d.project);
  for (const task of tasks.data ?? []) names.add(task.project);
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
        title={t("overview.title")}
        subtitle={t("overview.subtitle")}
      />
      {errors.length ? <ErrorNote error={errors.join("\n")} /> : null}

      <ClickCard
        onOpen={() => setScope(SHARED)}
        label={t("overview.openShared")}
        className="border-brand/30 bg-brand-soft/50 hover:border-brand/50 hover:bg-brand-soft/70"
        icon={Users}
        iconClassName="text-brand-soft-foreground"
        title={scopeLabel(SHARED)}
        titleClassName="text-brand-soft-foreground"
        description={t("overview.sharedCard")}
      >
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Count label={t("overview.sharedDocs")} value={value(docCount, "")} loading={waiting(docs)} />
          <Count label={t("overview.sharedMemory")} value={value(memoryCount, "")} loading={waiting(memory)} />
          <Count label={t("overview.pendingProposals")} value={value(proposalCount, "")} loading={waiting(proposals)} warnIfAny />
        </dl>
      </ClickCard>

      <section className="flex flex-col gap-3">
        <h2 className="flex items-baseline gap-2 text-sm font-semibold">
          {t("overview.projects")}
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
                  label={t("overview.openProject", { project: p })}
                  icon={FolderGit2}
                  title={p}
                  titleClassName="font-mono text-sm"
                  description={repos.get(p) ? <span className="font-mono text-xs break-all">{repos.get(p)}</span> : undefined}
                >
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                    <Count label={t("overview.ownDocs")} value={value(docCount, p)} loading={waiting(docs)} />
                    <Count label={t("overview.ownMemory")} value={value(memoryCount, p)} loading={waiting(memory)} />
                    <Count
                      label={t("overview.openTasks")}
                      value={tasks.data ? OPEN.reduce((n, s) => n + (open?.[s] ?? 0), 0) : undefined}
                      loading={waiting(tasks)}
                    />
                    <Count label={t("overview.pendingProposals")} value={value(proposalCount, p)} loading={waiting(proposals)} warnIfAny />
                  </dl>
                  {open ? (
                    <div className="flex flex-wrap gap-1.5">
                      {OPEN.filter((s) => open[s] > 0).map((s) => (
                        <Badge key={s} tone={STATUS_TONE[s]}>
                          {statusCount(t, open[s], s)}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </ClickCard>
              );
            })}
          </div>
        )}
        {capped ? <p className="text-xs text-muted-foreground">{t("overview.capped", { memory: MEMORY_LIMIT, tasks: TASK_LIMIT })}</p> : null}
      </section>
    </Page>
  );
}

function NoProjects({ desktop }: { desktop: boolean }) {
  const { me } = useHive();
  const t = useT();
  // A hub account sees only the projects an admin granted it.
  if (me.access) {
    return (
      <Empty>
        <div className="flex flex-col items-center gap-2">
          <p className="font-medium text-foreground">{t("overview.noGrantsTitle")}</p>
          <p className="max-w-md">{t("overview.noGrantsBody")}</p>
        </div>
      </Empty>
    );
  }
  return (
    <Empty>
      <div className="flex flex-col items-center gap-3">
        <p className="font-medium text-foreground">{t("scope.noProjects")}</p>
        <p className="max-w-md">
          {desktop
            ? t("overview.noProjectsDesktop")
            : t("overview.noProjectsWeb")}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {desktop ? (
            <Button asChild size="sm">
              <a href="#/projects">{t("nav.projects")}</a>
            </Button>
          ) : null}
          <Button asChild variant="outline" size="sm">
            <a href="#/docs">{t("nav.docs")}</a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href="#/tasks">{t("nav.tasks")}</a>
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
  const t = useT();
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
        subtitle={t("overview.sharedSubtitle")}
        actions={<AllProjectsButton onClick={() => setScope(ALL)} />}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          icon={FileText}
          label={t("overview.sharedDocsTitle")}
          q={docs}
          parts={[{ value: docs.data?.length }]}
          detail={inAgents ? t("overview.inAgents", { count: inAgents }) : undefined}
        />
        <StatCard
          icon={Sparkles}
          label={t("overview.sharedMemoryTitle")}
          q={memory}
          parts={[{ value: memory.data?.length }]}
          detail={pendingMemory ? t("overview.pendingCount", { count: pendingMemory }) : undefined}
        />
        <StatCard icon={GitPullRequestArrow} label={t("overview.pendingProposalsTitle")} q={proposals} parts={[{ value: shared?.length }]} warnIfAny />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section icon={FileText} title={t("overview.sharedDocsTitle")} action={<LinkButton href="#/docs">{t("nav.docs")}</LinkButton>}>
          <Load q={docs}>
            {(list) => <DocList docs={list} max={12} empty={t("overview.noSharedDocs")} />}
          </Load>
        </Section>
        <Section icon={Sparkles} title={t("overview.recentSharedMemory")} action={<LinkButton href="#/memory">{t("nav.memory")}</LinkButton>}>
          <Load q={memory}>{(list) => <MemoryList items={list} max={10} empty={t("overview.noSharedMemory")} showOwner={false} />}</Load>
        </Section>
        <Section
          icon={GitPullRequestArrow}
          title={t("overview.pendingProposalsTitle")}
          description={t("overview.sharedProposals")}
          action={<LinkButton href="#/proposals">{t("nav.proposals")}</LinkButton>}
          className="lg:col-span-2"
        >
          <Load q={proposals}>{() => <ProposalList items={shared ?? []} max={8} empty={t("proposals.noPending")} />}</Load>
        </Section>
      </div>
    </Page>
  );
}

// ── one project ────────────────────────────────────────────────────────────

function ProjectOverview({ project: p }: { project: string }) {
  const { client, me, setScope } = useHive();
  const t = useT();
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
    ? OPEN.map((s) => [s, open.filter((task) => task.status === s).length] as const)
        .filter(([, n]) => n > 0)
        .map(([s, n]) => statusCount(t, n, s))
        .join(" · ")
    : "";

  return (
    // A project key has no spaces: let a long one wrap at 375px.
    <Page className="[&_h1]:wrap-anywhere">
      <PageHeader
        title={p}
        subtitle={t("overview.projectSubtitle", { project: p })}
        actions={<AllProjectsButton onClick={() => setScope(ALL)} />}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={FileText}
          label={t("nav.docs")}
          q={docs}
          parts={[
            { value: ownDocs?.length, unit: t("overview.own") },
            { value: sharedDocs?.length, unit: t("overview.shared") },
          ]}
        />
        <StatCard
          icon={Sparkles}
          label={t("nav.memory")}
          q={memory}
          parts={[
            { value: ownMemory, unit: t("overview.own") },
            { value: sharedMemory, unit: t("overview.shared") },
          ]}
        />
        <StatCard icon={ListTodo} label={t("overview.openTasksTitle")} q={tasks} parts={[{ value: open?.length }]} detail={statusLine || undefined} />
        <StatCard
          icon={GitPullRequestArrow}
          label={t("overview.pendingProposalsTitle")}
          q={proposals}
          parts={[{ value: ownProposals?.length }]}
          detail={sharedProposals ? t("overview.onSharedDocs", { count: sharedProposals }) : undefined}
          warnIfAny
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section icon={ListTodo} title={t("overview.openTasksSection")} action={<LinkButton href="#/tasks">{t("nav.tasks")}</LinkButton>}>
          <Load q={tasks}>
            {() => (
              <Rows items={open ?? []} max={8} empty={t("overview.noOpenTasks")} more={(n) => t("overview.moreTasks", { count: n })} href="#/tasks">
                {(task) => (
                  <li key={task.id} className={ROW}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={STATUS_TONE[task.status]}>{t(`taskStatus.${task.status}`)}</Badge>
                      <span className="min-w-0 font-mono text-xs break-all text-muted-foreground">{task.id}</span>
                    </div>
                    <p className="text-sm break-words">{task.title}</p>
                    <p className="text-xs break-all text-muted-foreground">
                      {task.owner ?? t("overview.unclaimed")} · {formatTime(task.updatedAt)}
                    </p>
                  </li>
                )}
              </Rows>
            )}
          </Load>
        </Section>

        <Section icon={FileText} title={t("nav.docs")} description={t("overview.projectDocs")} action={<LinkButton href="#/docs">{t("nav.docs")}</LinkButton>}>
          <Load q={docs}>
            {() => (
              <>
                <DocList docs={ownDocs ?? []} max={8} empty={t("docs.noOwnDocs")} />
                <a
                  href="#/docs"
                  className="flex flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  <OwnerBadge owner={null} />
                  {sharedDocs?.length ? t("overview.sharedDocsApply", { count: sharedDocs.length }) : t("overview.noSharedDocs")}
                  <ChevronRight className="ml-auto size-4" />
                </a>
              </>
            )}
          </Load>
        </Section>

        <Section
          icon={Sparkles}
          title={t("overview.recentMemory")}
          description={t("overview.recentMemoryHint")}
          action={<LinkButton href="#/memory">{t("nav.memory")}</LinkButton>}
        >
          <Load q={memory}>{(list) => <MemoryList items={list} max={8} empty={t("overview.noMemory")} />}</Load>
        </Section>

        {desktop ? (
          <Section icon={Bot} title={t("overview.recentRuns")} description={t("overview.recentRunsHint")} action={<LinkButton href="#/board">{t("nav.board")}</LinkButton>}>
            <Load q={runs}>
              {(list) => (
                <Rows items={list ?? []} max={5} empty={t("overview.noRuns")}>
                  {(r) => (
                    <li key={r.id} className={ROW}>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={STATUS_TONE[r.status]}>{t(`runStatus.${r.status}`)}</Badge>
                        <span className="min-w-0 font-mono text-xs break-all text-muted-foreground">{r.taskId}</span>
                      </div>
                      <p className="text-sm break-words">{r.taskTitle}</p>
                      <p className="text-xs break-all text-muted-foreground">
                        {t(`agentRole.${r.role}`)} · {r.profileId ?? t("overview.noProfile")} · {formatTime(r.createdAt)}
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
            title={t("overview.machines")}
            description={t("overview.machinesHint")}
            action={<LinkButton href="#/admin">{t("nav.admin")}</LinkButton>}
          >
            <Load q={machines}>
              {(list) => {
                const withProject = (list ?? []).flatMap((m) => {
                  const entry = m.setup?.projects.find((x) => x.project === p);
                  return entry ? [{ machine: m, entry }] : [];
                });
                return (
                  <Rows items={withProject} max={8} empty={t("overview.noMachines")}>
                    {({ machine: m, entry }) => {
                      const missing = entry.items.filter((i) => i.state !== "installed").length;
                      return (
                        <li key={m.id} className={ROW}>
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusDot tone={m.online ? "ok" : "neutral"} />
                            <span className="min-w-0 font-mono text-sm break-all">{m.machine}</span>
                            {missing ? <Badge tone="warn">{t("overview.missing", { count: missing })}</Badge> : <Badge tone="ok">{t("overview.allInstalled")}</Badge>}
                          </div>
                          <p className="font-mono text-xs break-all text-muted-foreground">{entry.repo}</p>
                          <p className="text-xs text-muted-foreground">
                            {m.online ? t("overview.online") : t("overview.offline")} · {t("overview.heartbeat", { time: formatTime(m.lastSeen) })}
                          </p>
                        </li>
                      );
                    }}
                  </Rows>
                );
              }}
            </Load>
            <div className="flex flex-col gap-2 border-t pt-3">
              <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("overview.policy")}</span>
              <Load q={policy} rows={1}>
                {(data) => {
                  const parts = data?.projects[p] ?? [];
                  return parts.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {parts.map((part) => (
                        <Badge key={part}>{t(`setupPart.${part}`)}</Badge>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t("overview.noPolicy")}</p>
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
  const t = useT();
  const repo = q.data?.projects.find((x) => x.name === project)?.repo;
  return (
    <Section
      icon={FolderGit2}
      title={t("overview.repo")}
      action={repo ? <LinkButton href="#/projects">{t("overview.settings")}</LinkButton> : undefined}
    >
      <Load q={q} rows={1}>
        {() =>
          repo ? (
            <code className="rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-all">{repo}</code>
          ) : (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted-foreground">{t("overview.noRepo")}</p>
              <Button asChild size="sm">
                <a href="#/projects">{t("overview.addRepo")}</a>
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
  const t = useT();
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <Layers />
      {t("common.allProjects")}
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
  const t = useT();
  if (props.items.length === 0) return <p className="text-sm text-muted-foreground">{props.empty}</p>;
  const rest = props.items.length - props.max;
  return (
    <>
      <ul className="flex flex-col divide-y">{props.items.slice(0, props.max).map(props.children)}</ul>
      {rest > 0 ? (
        props.href ? (
          <a href={props.href} className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            + {props.more ? props.more(rest) : t("overview.moreItems", { count: rest })}
          </a>
        ) : (
          <p className="text-xs text-muted-foreground">+ {props.more ? props.more(rest) : t("overview.moreItems", { count: rest })}</p>
        )
      ) : null}
    </>
  );
}

function DocList({ docs, max, empty }: { docs: DocSummary[]; max: number; empty: string }) {
  const t = useT();
  return (
    <Rows items={docs} max={max} empty={empty} more={(n) => t("overview.moreDocs", { count: n })} href="#/docs">
      {(d) => (
        <li key={d.key} className={ROW}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 text-sm font-medium break-words">{d.title}</span>
            {d.includeInAgents ? <Badge tone="info">{t("overview.inAgentsBadge")}</Badge> : null}
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
  const t = useT();
  return (
    <Rows items={items} max={max} empty={empty} more={(n) => t("overview.moreMemory", { count: n })} href="#/memory">
      {(m) => (
        <li key={m.id} className={ROW}>
          <div className="flex flex-wrap items-center gap-2">
            {showOwner ? <OwnerBadge owner={m.project} /> : null}
            <span className="text-xs text-muted-foreground">{t(`memoryKind.${m.kind}`)}</span>
            {m.status === "pending" ? <Badge tone={STATUS_TONE.pending}>{t("memory.pending")}</Badge> : null}
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
  const t = useT();
  return (
    <Rows items={items} max={max} empty={empty} more={(n) => t("overview.moreProposals", { count: n })} href="#/proposals">
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
