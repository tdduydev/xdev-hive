import { visibleInterval } from "#ui/lib/visible-interval.ts";
// Board (docs/design/2026-09-redesign, xDev Hive Client): a project's tasks in five columns; drag a card to change
// its status, click it for the inspector (details, the latest run, and the form that starts an agent on this
// machine). The runs themselves are on Lượt chạy.
import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";
import { ExternalLink, X } from "lucide-react";
import { cn } from "cn";
import {
  WORK_ROLES,
  PREFER_KINDS,
  TASK_STATUSES,
  type AgentProfileStatus,
  type WorkRole,
  type AgentRun,
  type PreferKind,
  type Task,
  type TaskStatus,
} from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Badge, ErrorNote, Notice, StatusDot } from "#ui/components/common.tsx";
import { PausedNotice } from "#ui/components/StopAgents.tsx";
import { errorMessage, formatTime, hashParam, useAction, useCan, useHive, useProjects, useQuery } from "#ui/hooks.ts";
import { rich, useT, type TFunction } from "#ui/i18n/index.tsx";
import { agentLabel } from "#ui/lib/assignment.ts";
import { boardProjects, profileState, profileSummary } from "#ui/lib/board.ts";
import { canCloseTask } from "#ui/lib/permission-controls.ts";
import { runDuration } from "#ui/lib/runs.ts";
import { projectScope, scopeProject } from "#ui/lib/scope.ts";
import { BoardColumns } from "#ui/components/BoardColumns.tsx";
import { columnOf, ownerLabel, waitingLabels } from "#ui/lib/tasks.ts";
import { useToast } from "#ui/shell/toast.tsx";

/** Re-renders every `ms` while `active`, for live runs. */
function usePulse(active: boolean, ms = 2000): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    return visibleInterval(ms, () => setN((x) => x + 1));
  }, [active, ms]);
  return n;
}


/** "c2/3" for a best-of-n candidate, "judge" for the run that compares them. */
function bestOfLabel(run: AgentRun, t: TFunction): string | null {
  const b = run.bestOf;
  if (!b) return null;
  return b.n === 0 ? t("board.judge") : t("board.candidateOf", { n: b.n, of: b.of });
}

/** The MR / CI chip of a card: "MR !84 · CI lỗi", "PR #12 · đã merge"… */
function mrTag(run: AgentRun | null, t: TFunction): { text: string; kind: "danger" | "success" | "neutral" } | null {
  if (!run?.mrUrl) return null;
  const mr = /\/pull\/\d+$/.test(run.mrUrl) ? `PR #${run.mrIid}` : `MR !${run.mrIid}`;
  if (run.mrStatus === "merged") return { text: `${mr} · ${t("mrStatus.merged")}`, kind: "success" };
  if (run.pipelineStatus === "failed") return { text: `${mr} · ${t("board.pipeline", { status: t("pipelineStatus.failed") })}`, kind: "danger" };
  if (run.pipelineStatus === "success") return { text: `${mr} · ${t("board.pipeline", { status: t("pipelineStatus.success") })}`, kind: "success" };
  return { text: mr, kind: "neutral" };
}

const TAG = {
  danger: "bg-danger-soft text-danger",
  success: "bg-success-soft text-success",
  neutral: "bg-neutral-soft text-neutral",
  info: "bg-info-soft text-info",
  warning: "bg-warning-soft text-warning",
} as const;

function Tag({ kind, title, children }: { kind: keyof typeof TAG; title?: string; children: ReactNode }) {
  return (
    <span title={title} className={cn("inline-flex h-[18px] items-center rounded-xs px-1.5 font-sans whitespace-nowrap", TAG[kind])}>
      {children}
    </span>
  );
}

/** A refused move in the reader's language: the hub's own text when it has one, else that the token may not. */
function moveError(err: unknown, t: TFunction): string {
  const { code, key } = (err ?? {}) as { code?: unknown; key?: unknown };
  return code === "forbidden" && typeof key !== "string" ? t("board.moveForbidden") : errorMessage(err);
}

/**
 * `switcher`: Board / Danh sách, since the Task page is the two of them in the app (roadmap 39f). Connected to a hub
 * the app has the Board alone, over this machine's projects only (roadmap 44): the rest opens on the hub's web.
 */
export function BoardPage({ switcher }: { switcher?: ReactNode }) {
  const { client, me, scope, setScope } = useHive();
  const t = useT();
  const allow = useCan();
  const toast = useToast();
  const desktop = client.desktop!;
  const projects = useProjects();
  const settings = useQuery(() => desktop.settings(), [desktop]);
  const localProjects = settings.data?.projects.map((p) => p.name) ?? [];
  const machineOnly = me.mode === "hub";
  const webUrl = machineOnly && settings.data?.hubUrl ? settings.data.hubUrl.replace(/\/+$/, "") : null;
  // A system: only its projects, the ones with a repo here first.
  const system = scope.kind === "system" ? scope.projects : null;
  const options = boardProjects({ local: localProjects, seen: projects, system, machineOnly });
  // Follow the sidebar scope when it is a project with a repo on this machine; otherwise (all, shared,
  // a project not cloned here) keep the project shown last, or the first one.
  const scoped = scopeProject(scope);
  const scopeLocal = scoped !== null && localProjects.includes(scoped) ? scoped : null;
  const [project, setProject] = useState("");
  useEffect(() => {
    if (scopeLocal) setProject(scopeLocal);
  }, [scopeLocal]);
  const firstLocal = machineOnly ? options[0] : system ? options.find((p) => localProjects.includes(p)) || options[0] : localProjects[0] || projects[0];
  const current = scopeLocal || (options.includes(project) ? project : "") || firstLocal || "";

  const [tick, setTick] = useState(0);
  const runs = useQuery(() => desktop.runs({ project: current || undefined, limit: 60 }), [desktop, current, tick]);
  // A run that just ended may still get its MR or its task note: keep refreshing until it has.
  const active = (runs.data ?? []).some((r) => r.status === "queued" || r.status === "running" || r.finishing);
  const pulse = usePulse(active);
  useEffect(() => setTick((n) => n + 1), [pulse]);
  // The elapsed time on running cards.
  usePulse((runs.data ?? []).some((r) => r.status === "running"), 1000);

  const tasks = useQuery(() => (current ? client.call("tasks.list", { project: current }) : Promise.resolve([] as Task[])), [client, current, tick]);
  const next = useQuery(() => (current ? client.call("tasks.next", { project: current, limit: 1 }) : Promise.resolve([] as Task[])), [client, current, tasks.data]);
  const nextId = next.data?.[0]?.id ?? null;
  const profiles = useQuery(() => desktop.profiles(), [desktop, tick]);
  const [selected, setSelected] = useState<string | null>(null);
  // Status changes made here, shown before the list reloads.
  const [moved, setMoved] = useState<Record<string, TaskStatus>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [moveProblem, setMoveError] = useState<string | null>(null);
  // A link to one task (#/tasks?task=…, from Hôm nay or a run) opens its panel once the list has it.
  const [wanted, setWanted] = useState(() => hashParam("task"));
  useEffect(() => {
    const onHash = () => setWanted(hashParam("task"));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (!wanted || !tasks.data) return;
    if (tasks.data.some((task) => task.id === wanted)) setSelected(wanted);
    setWanted(null);
  }, [wanted, tasks.data]);

  const latestRun = useMemo(() => {
    const map = new Map<string, AgentRun>();
    for (const r of runs.data ?? []) if (!map.has(r.taskId)) map.set(r.taskId, r);
    return map;
  }, [runs.data]);
  const list = useMemo(
    () => (tasks.data ?? []).map((task) => (moved[task.id] ? { ...task, status: moved[task.id]!, waitingOn: moved[task.id] === "todo" ? task.waitingOn : [] } : task)),
    [tasks.data, moved],
  );
  useEffect(() => setMoved({}), [tasks.data]);

  const counts = {
    running: (runs.data ?? []).filter((r) => r.status === "running").length,
    queued: (runs.data ?? []).filter((r) => r.status === "queued").length,
  };
  const refresh = () => setTick((n) => n + 1);
  const isLocalProject = localProjects.includes(current);
  const canMove = allow(current || null, "taskWork");

  const move = (task: Task, status: TaskStatus) => {
    const from = task.status;
    if (from === status) return;
    if (status === "done" && !canCloseTask(me, task.project)) {
      setMoveError(t("tasks.doneNeedsReview"));
      return;
    }
    setMoved((m) => ({ ...m, [task.id]: status }));
    setMoveError(null);
    client.call("tasks.update", { id: task.id, status }).then(
      () => {
        refresh();
        toast(t("board.moved", { id: task.id, status: t(`taskStatus.${status}`) }), {
          undo: () => void client.call("tasks.update", { id: task.id, status: from }).then(refresh, (err: unknown) => setMoveError(moveError(err, t))),
        });
      },
      (err: unknown) => {
        setMoved((m) => {
          const rest = { ...m };
          delete rest[task.id];
          return rest;
        });
        setMoveError(moveError(err, t));
      },
    );
  };
  const drop = (status: TaskStatus, e: DragEvent) => {
    const id = dragId ?? e.dataTransfer.getData("text/plain");
    setDragId(null);
    const task = list.find((x) => x.id === id);
    if (task && columnOf(task) !== status) move(task, status);
  };

  const inspected = list.find((x) => x.id === selected) ?? null;
  const problem = tasks.error ?? runs.error ?? moveProblem;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line-subtle bg-surface px-3.5 py-2.5">
          {options.length || !machineOnly ? (
            <NativeSelect
              size="sm"
              className="font-mono"
              value={current}
              onChange={(e) => {
                setProject(e.target.value);
                // Within a system the sidebar stays on it.
                if (!system) setScope(projectScope(e.target.value));
              }}
              aria-label={t("tasks.colProject")}
            >
              {options.map((p) => (
                <NativeSelectOption key={p} value={p}>
                  {p}
                  {localProjects.includes(p) ? "" : ` (${t("board.noRepoHere")})`}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : null}
          <ProfileStrip profiles={profiles.data ?? []} />
          <span className="flex-1" />
          <Badge tone="running">{t("board.running", { count: counts.running })}</Badge>
          <Badge tone="neutral">{t("board.queued", { count: counts.queued })}</Badge>
          {webUrl ? (
            // Other projects, batches and work handed to other machines: the hub's Task page has them.
            <Button size="sm" variant="outline" asChild>
              <a href={`${webUrl}/#/tasks`} target="_blank" rel="noreferrer" title={t("board.openWebHint")} data-open-web-board>
                <ExternalLink />
                {t("board.openWeb")}
              </a>
            </Button>
          ) : null}
          {switcher}
        </div>
        {!current && !settings.loading ? (
          <div className="px-3.5 pt-3" data-board-empty>
            {machineOnly ? (
              <Notice>
                {/* One span: the notice lays its children out as a grid, so the link alone would take a row. */}
                <span>
                  {rich(t(system ? "board.machineNoProjectsInScope" : "board.machineNoProjects"), {
                    setup: (
                      <a href="#/setup" className="font-medium text-fg-link underline-offset-2 hover:underline">
                        {t("nav.setup")}
                      </a>
                    ),
                  })}
                </span>
              </Notice>
            ) : (
              <Notice>{t("board.addProjectFirst")}</Notice>
            )}
          </div>
        ) : null}
        {current && me.mode === "hub" ? (
          // Empty while nothing is paused; the runs it holds say why in their own card too.
          <div className="px-3.5 pt-3 empty:hidden">
            <PausedNotice project={current} />
          </div>
        ) : null}
        {current && scoped !== null && scoped !== current && !settings.loading ? (
          <div className="px-3.5 pt-3">
            <Notice tone="info">
              {rich(t("board.scopeNotLocal"), { scoped: <span className="font-mono">{scoped}</span>, current: <span className="font-mono">{current}</span> })}
            </Notice>
          </div>
        ) : null}
        {current && !isLocalProject && !settings.loading ? (
          <div className="px-3.5 pt-3">
            <Notice tone="warn">{t("board.cannotRun")}</Notice>
          </div>
        ) : null}
        {problem ? (
          <div className="px-3.5 pt-3">
            <ErrorNote error={problem} />
          </div>
        ) : null}
        {machineOnly && !current ? null : (
          <div className="min-h-0 flex-1 overflow-auto px-3.5 py-3" aria-label={t("board.board")}>
            <BoardColumns count={(status) => list.filter((task) => columnOf(task) === status).length} dragging={canMove && dragId !== null} onDropTask={drop}>
              {(status) =>
                list
                  .filter((task) => columnOf(task) === status)
                  .map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      run={latestRun.get(task.id) ?? null}
                      isNext={task.id === nextId}
                      selected={task.id === selected}
                      draggable={canMove}
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", task.id);
                        e.dataTransfer.effectAllowed = "move";
                        setDragId(task.id);
                      }}
                      onDragEnd={() => setDragId(null)}
                      onOpen={() => setSelected(task.id)}
                    />
                  ))
              }
            </BoardColumns>
          </div>
        )}
      </div>
      {inspected ? (
        <Inspector
          key={inspected.id}
          task={inspected}
          run={latestRun.get(inspected.id) ?? null}
          profiles={profiles.data ?? []}
          canRun={isLocalProject}
          canMove={canMove}
          onMove={(status) => move(inspected, status)}
          onClose={() => setSelected(null)}
          onStarted={refresh}
        />
      ) : null}
    </div>
  );
}

/**
 * The subscriptions in one line ("5/7 gói sẵn sàng · 1 đang nghỉ", roadmap 39g), so the top of the Board stays one
 * row at 1100px. Each one's own state is in the tooltip, and the chip opens the page that fixes them.
 */
function ProfileStrip({ profiles }: { profiles: AgentProfileStatus[] }) {
  const t = useT();
  const { client } = useHive();
  if (!profiles.length) return null;
  const sum = profileSummary(profiles);
  const text = [
    t("board.profileChip", { ready: sum.ready, total: sum.total }),
    ...(sum.resting ? [t("board.profileChipResting", { count: sum.resting })] : []),
    ...(sum.overLimit ? [t("board.profileChipOverLimit", { count: sum.overLimit })] : []),
    ...(sum.signedOut ? [t("board.profileChipSignedOut", { count: sum.signedOut })] : []),
    ...(sum.off ? [t("board.profileChipOff", { count: sum.off })] : []),
  ].join(" · ");
  const tone = sum.signedOut ? "danger" : sum.resting || sum.overLimit ? "warn" : sum.ready ? "ok" : "neutral";
  // The whole state of each subscription, for whoever hovers: the chip itself counts them only.
  const detail = profiles
    .map((p) => {
      const state = profileState(p);
      const says =
        state === "off"
          ? t("board.profileOff")
          : state === "signedOut"
            ? t("board.profileSignedOut")
            : state === "overLimit"
              ? t("board.profileOverLimit")
              : state === "resting"
                ? t("board.profileResting", { time: formatTime(p.cooldownUntil) })
                : p.running
                  ? t("board.profileRunning", { running: p.running, max: p.maxConcurrent })
                  : t("board.profileReady");
      return `${p.id} · ${says}${p.cooldownReason ? ` (${p.cooldownReason})` : ""}`;
    })
    .join("\n");
  return (
    <a
      href={client.desktop ? "#/agents" : "#/machines"}
      title={detail}
      data-profile-chip
      className="inline-flex min-w-0 items-center gap-1.5 rounded-sm border border-line-default px-2 py-1 text-[11px] text-fg-secondary outline-none hover:bg-hover focus-visible:focus-ring"
    >
      <StatusDot tone={tone} />
      <span className="truncate">{text}</span>
    </a>
  );
}

function TaskCard({
  task,
  run,
  isNext,
  selected,
  draggable,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  task: Task;
  run: AgentRun | null;
  isNext: boolean;
  selected: boolean;
  draggable: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onOpen: () => void;
}) {
  const t = useT();
  const live = run?.status === "running";
  const tag = mrTag(run, t);
  const waiting = waitingLabels(task);
  const owner = task.owner ? ownerLabel(task.owner).who : run && (live || run.status === "queued") ? run.profileId : null;
  const stopped = run?.status === "rate_limited" || run?.status === "failed" ? run.status : null;
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "flex cursor-pointer flex-col gap-[7px] rounded-md border bg-surface px-2.5 py-[9px] outline-none hover:border-line-strong focus-visible:focus-ring",
        selected ? "border-line-selected" : "border-line-default",
      )}
    >
      <div className="flex gap-1.5 font-mono text-[11px]/none font-medium text-fg-muted">
        <span>{task.id}</span>
        {run?.bestOf ? <span className="truncate">{bestOfLabel(run, t)}</span> : null}
      </div>
      <span className="text-[13px]/[18px] font-medium text-pretty text-fg-strong [overflow-wrap:anywhere]">{task.title}</span>
      {live || run?.status === "queued" || stopped || tag || task.agent || waiting.length || isNext || owner ? (
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]/none font-medium">
          {live ? <span className="text-running">● {runDuration(run!)}</span> : null}
          {run?.status === "queued" ? <span className="text-fg-muted">◌ {t("runStatus.queued")}</span> : null}
          {stopped ? <Tag kind={stopped === "failed" ? "danger" : "warning"}>{t(`runStatus.${stopped}`)}</Tag> : null}
          {tag ? <Tag kind={tag.kind}>{tag.text}</Tag> : null}
          {/* Who the task is *for*, next to who took it: the app's board shows the same chip as the web's (roadmap 50b). */}
          {task.agent ? <Tag kind="info">{agentLabel(task.agent, t("assignment.any"))}</Tag> : null}
          {waiting.length ? <Tag kind="danger">{t("board.waitingOn", { tasks: waiting.join(", ") })}</Tag> : null}
          {isNext ? (
            <Tag kind="info" title={t("board.nextTaskHint")}>
              {t("board.nextTask")}
            </Tag>
          ) : null}
          {owner ? <span className="ml-auto truncate text-fg-secondary">{owner}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function Inspector({
  task,
  run,
  profiles,
  canRun,
  canMove,
  onMove,
  onClose,
  onStarted,
}: {
  task: Task;
  run: AgentRun | null;
  profiles: AgentProfileStatus[];
  canRun: boolean;
  canMove: boolean;
  onMove: (status: TaskStatus) => void;
  onClose: () => void;
  onStarted: () => void;
}) {
  const { client, me } = useHive();
  const t = useT();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const busy = run?.status === "queued" || run?.status === "running";
  const waiting = waitingLabels(task);
  const allowed = me.role !== "viewer" && canRun && task.status !== "done" && !waiting.length;
  const tag = mrTag(run, t);
  const props: Array<[string, ReactNode, boolean?]> = [
    [
      t("board.propStatus"),
      canMove ? (
        <div className="flex flex-col gap-1">
          <NativeSelect size="sm" value={task.status} onChange={(e) => onMove(e.target.value as TaskStatus)} aria-label={t("board.propStatus")}>
            {TASK_STATUSES.map((s) => (
              <NativeSelectOption key={s} value={s} disabled={s === "done" && task.status !== "done" && !canCloseTask(me, task.project)}>
                {t(`taskStatus.${s}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {task.status !== "done" && !canCloseTask(me, task.project) ? <span className="text-xs text-muted-foreground">{t("tasks.doneNeedsReview")}</span> : null}
        </div>
      ) : (
        t(`taskStatus.${task.status}`)
      ),
    ],
    [t("board.propProject"), task.project, true],
    [t("board.propOwner"), task.owner ? ownerLabel(task.owner).who : t("board.noOwner"), true],
    [t("board.propMr"), tag ? tag.text : "—"],
  ];

  return (
    <aside aria-label={task.id} className="flex w-[360px] shrink-0 flex-col border-l border-line-subtle bg-surface">
      <div className="flex h-[42px] shrink-0 items-center border-b border-line-subtle pr-2 pl-4">
        <span className="flex-1 font-mono text-xs/none font-medium text-fg-muted">{task.id}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="grid size-7 cursor-pointer place-items-center rounded-sm text-fg-secondary outline-none hover:bg-hover focus-visible:focus-ring"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-4">
        <h3 className="m-0 font-display text-base/[22px] font-semibold text-fg-strong">{task.title}</h3>
        <div className="grid grid-cols-[96px_1fr] items-center gap-x-2.5 gap-y-2 text-xs/[18px]">
          {props.map(([k, v, mono]) => (
            <div key={k} className="contents">
              <span className="text-fg-muted">{k}</span>
              <span className={cn("min-w-0 text-fg-strong", mono && "font-mono")}>{v}</span>
            </div>
          ))}
        </div>
        {waiting.length ? <Notice tone="warn">{t("board.waitingOn", { tasks: waiting.join(", ") })}</Notice> : null}
        <p className="m-0 text-[13px]/5 whitespace-pre-wrap text-fg-primary [overflow-wrap:anywhere]">{task.note?.trim() || t("board.noNote")}</p>
        {run ? (
          <div className="flex flex-col gap-1 rounded-md border border-line-subtle bg-subtle p-2.5 text-xs/[18px]">
            <span className="font-semibold text-fg-strong">{t("board.lastRun", { id: run.id, status: t(`runStatus.${run.status}`) })}</span>
            <span className="font-mono text-fg-muted">{[run.profileId, t(`agentRole.${run.role}`), runDuration(run)].filter(Boolean).join(" · ")}</span>
            {run.activity ? <span className="text-info [overflow-wrap:anywhere]">{t("board.activity", { activity: run.activity })}</span> : null}
            {run.error ? <span className="text-fg-muted [overflow-wrap:anywhere]">{run.error}</span> : null}
          </div>
        ) : null}
        {open ? (
          <RunForm
            task={task}
            profiles={profiles}
            onCancel={() => setOpen(false)}
            onStarted={(r) => {
              setOpen(false);
              onStarted();
              toast(t("runs.rerunDone", { task: task.id }));
              window.location.hash = `#/runs?run=${encodeURIComponent(r.id)}`;
            }}
          />
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2 border-t border-line-subtle px-4 py-3">
        {run ? (
          <Button size="sm" variant={allowed && !busy && !open ? "outline" : "default"} asChild>
            <a href={`#/runs?run=${encodeURIComponent(run.id)}`}>{t("board.viewRun")}</a>
          </Button>
        ) : null}
        {allowed && !busy && !open ? (
          <Button size="sm" data-run-here onClick={() => setOpen(true)}>
            {t("board.runHere")}
          </Button>
        ) : null}
        {run?.worktree ? (
          <Button size="sm" variant="ghost" onClick={() => void client.desktop!.showInFolder(run.worktree!)}>
            {t("board.openWorktree")}
          </Button>
        ) : null}
      </div>
    </aside>
  );
}

/** Starts an agent on the task: which job, which subscription (or rotate), how many candidates, extra instructions. */
function RunForm({ task, profiles, onCancel, onStarted }: { task: Task; profiles: AgentProfileStatus[]; onCancel: () => void; onStarted: (run: AgentRun) => void }) {
  const { client } = useHive();
  const t = useT();
  const [role, setRole] = useState<WorkRole>(task.status === "review" ? "review" : "implement");
  const [profileId, setProfileId] = useState("");
  const [preferKind, setPreferKind] = useState<PreferKind | "">("");
  const [instructions, setInstructions] = useState("");
  const [reviewAfter, setReviewAfter] = useState(true);
  const [candidates, setCandidates] = useState(1);
  const action = useAction();
  const several = role === "implement" && !profileId;
  const kinds = PREFER_KINDS.filter((k) => profiles.some((p) => p.enabled && p.kind === k));
  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-line-default p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          const started = await client.desktop!.startRun({
            project: task.project,
            taskId: task.id,
            role,
            profileId: profileId || null,
            preferKind: (!profileId && preferKind) || null,
            instructions,
            reviewAfter: role !== "review" && reviewAfter,
            ...(several && candidates > 1 ? { candidates } : {}),
          });
          setInstructions("");
          onStarted(started);
        });
      }}
    >
      <Label htmlFor={`role-${task.id}`}>{t("board.role")}</Label>
      <NativeSelect id={`role-${task.id}`} size="sm" wrapperClassName="w-full" value={role} onChange={(e) => setRole(e.target.value as WorkRole)}>
        {WORK_ROLES.map((r) => (
          <NativeSelectOption key={r} value={r}>
            {t(`agentRole.${r}`)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <Label htmlFor={`profile-${task.id}`}>{t("board.profile")}</Label>
      <NativeSelect id={`profile-${task.id}`} size="sm" wrapperClassName="w-full" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
        <NativeSelectOption value="">{t("board.rotate")}</NativeSelectOption>
        {profiles
          .filter((p) => p.enabled && p.roles.includes(role))
          .map((p) => (
            <NativeSelectOption key={p.id} value={p.id}>
              {p.label}
              {p.cooldownUntil ? ` (${t("board.resting")})` : ""}
            </NativeSelectOption>
          ))}
      </NativeSelect>
      {!profileId && kinds.length > 1 ? (
        <>
          <Label htmlFor={`prefer-${task.id}`}>{t("board.preferKind")}</Label>
          <NativeSelect
            id={`prefer-${task.id}`}
            size="sm"
            wrapperClassName="w-full"
            value={preferKind}
            onChange={(e) => setPreferKind(e.target.value as PreferKind | "")}
            title={t("board.preferKindHint")}
          >
            <NativeSelectOption value="">{t("board.preferKindAny")}</NativeSelectOption>
            {kinds.map((k) => (
              <NativeSelectOption key={k} value={k}>
                {t(`agentKind.${k}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </>
      ) : null}
      {several ? (
        <>
          <Label htmlFor={`candidates-${task.id}`}>{t("board.candidates")}</Label>
          <NativeSelect
            id={`candidates-${task.id}`}
            size="sm"
            wrapperClassName="w-full"
            value={String(candidates)}
            onChange={(e) => setCandidates(Number(e.target.value))}
            title={t("board.candidatesHint")}
          >
            {[1, 2, 3, 4].map((n) => (
              <NativeSelectOption key={n} value={String(n)}>
                {n === 1 ? t("board.candidatesOne") : t("board.candidatesMany", { n })}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {candidates > 1 ? <p className="m-0 text-xs text-fg-muted">{t("board.candidatesHint")}</p> : null}
        </>
      ) : null}
      <Textarea placeholder={t("board.instructionsPlaceholder")} value={instructions} onChange={(e) => setInstructions(e.target.value)} aria-label={t("board.instructions")} />
      {role !== "review" ? (
        <label className="flex items-center gap-2 text-[13px]">
          <Checkbox checked={reviewAfter} onCheckedChange={(v) => setReviewAfter(v === true)} />
          {t("board.reviewAfter")}
        </label>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="submit" disabled={action.busy}>
          {t("board.run")}
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
      <ErrorNote error={action.error} />
    </form>
  );
}
