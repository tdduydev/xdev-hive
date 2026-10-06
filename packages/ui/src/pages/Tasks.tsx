import { ResponsiveTable as Table, ResponsiveTableRow as TableRow } from "#ui/components/ResponsiveTable.tsx";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "cn";
import { Sparkles } from "lucide-react";
import { AGENT_ROLES, MAX_CANDIDATES, TASK_KINDS, TASK_RISKS, TASK_SIZES, TASK_STATUSES, type AgentRole, type PreferKind, type RunRequest, type Task, type TaskKind, type TaskRisk, type TaskSize, type TaskStatus } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent } from "@xdev-hive/ui/components/ui/card";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@xdev-hive/ui/components/ui/sheet";
import { TableBody, TableCell, TableHead, TableHeader } from "@xdev-hive/ui/components/ui/table";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Badge, Empty, ErrorNote, Notice, OwnerBadge, Page, PageHeader, STATUS_TONE } from "#ui/components/common.tsx";
import { BatchSheet, PromptSheet } from "#ui/components/AgentSheets.tsx";
import { BoardPage } from "#ui/pages/Board.tsx";
import { FlowList, FlowTaskPanel } from "#ui/components/FlowCard.tsx";
import { MachineSelect, PreferKindSelect, ProfileSelect, takesRunsOf } from "#ui/components/MachinePicker.tsx";
import { AgentAssignment } from "#ui/components/AgentAssignment.tsx";
import { AgentBoard } from "#ui/components/AgentBoard.tsx";
import { agentLabel, agentLanes, filterAgent } from "#ui/lib/assignment.ts";
import { TaskKanban } from "#ui/components/TaskKanban.tsx";
import { formatTime, hashParam, useAction, useCan, useHashParam, useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { REQUEST_TONE, requestErrorText, runLabel } from "#ui/lib/runs.ts";
import { scopeFilter, scopeKey, scopeProject } from "#ui/lib/scope.ts";
import { depLabel, ownerLabel, waitingLabels } from "#ui/lib/tasks.ts";
import { canCloseTask, canEditDependencies } from "#ui/lib/permission-controls.ts";
import { decodeTargets, type AgentTarget } from "#ui/lib/agentmap.ts";

/** Text colour of the status select, keyed by STATUS_TONE. */
const TONE_TEXT: Record<string, string> = {
  ok: "text-success",
  info: "text-info",
  running: "text-running",
  warn: "text-warning",
  danger: "text-danger",
};

/** Machines take a request at their next heartbeat (30 s): follow it closely until one does. */
const PENDING_MS = 3000;

type View = "kanban" | "list" | "agent";
// Each reader's own choice, in this browser only (roadmap 30a): Kanban unless they picked the list.
const VIEW_KEY = "hive-tasks-view";
const readView = (): View => {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    return saved === "list" || saved === "agent" ? saved : "kanban";
  } catch {
    return "kanban";
  }
};
const writeView = (v: View) => {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    // Not remembered.
  }
};

/** Kanban (Board in the app) or Danh sách. Buttons, not a select: the screenshot harness clicks them. */
function ViewSwitch({ value, onChange, board, agents = false }: { value: View; onChange: (v: View) => void; board?: boolean; agents?: boolean }) {
  const t = useT();
  return (
    <div role="radiogroup" aria-label={t("tasks.view")} className="ml-auto flex gap-0.5 rounded-[7px] bg-sunken p-0.5">
      {(["kanban", "list", ...(agents ? ["agent" as const] : [])] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="radio"
          data-task-view={v}
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn("h-7 max-md:min-h-11 cursor-pointer rounded-[5px] px-2.5 text-xs/none font-semibold outline-none focus-visible:focus-ring", value === v ? "bg-surface text-fg-strong shadow-e1" : "text-fg-secondary")}
        >
          {t(v === "agent" ? "assignment.byAgent" : v === "kanban" && board ? "tasks.view_board" : `tasks.view_${v}`)}
        </button>
      ))}
    </div>
  );
}

/**
 * Task. In the desktop app it opens on the Board of this machine, with Danh sách as the other view (roadmap 39f):
 * the two were separate menu entries before, and the Board is where a run starts. On the web the page is this one,
 * with the shared Kanban.
 */
export function TaskWorkPage() {
  const { client, me } = useHive();
  const [view, setViewState] = useState<View>(readView);
  // A link to one task (#/tasks?task=…, from Hôm nay, a run or memory) opens the list: the task's panel is there.
  // Read from the address each time rather than useHashParam: the list takes the parameter out when it opens the
  // task, so the same link followed again would look unchanged to a state that remembered it.
  useEffect(() => {
    const onHash = () => {
      if (hashParam("task")) setViewState("list");
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (!client.desktop) return <TasksPage />;
  // Connected to a hub the app has the Board of this machine's projects only (roadmap 44); the list is the web's.
  if (me.mode === "hub") return <BoardPage />;
  const change = (v: View) => {
    setViewState(v);
    writeView(v);
  };
  const switcher = <ViewSwitch value={view} onChange={change} board />;
  return view !== "kanban" ? <TasksPage view="list" switcher={switcher} /> : <BoardPage switcher={switcher} />;
}

/** `view` and `switcher` are set by TaskWorkPage when the Board is the other view; alone, the page owns both. */
export function TasksPage({ view: fixed, switcher }: { view?: View; switcher?: ReactNode }) {
  const { client, scope, projects, me } = useHive();
  const t = useT();
  const allow = useCan();
  // A system's new tasks go to one of its projects.
  const managed = (scope.kind === "system" ? scope.projects : projects).filter((p) => allow(p, "taskManage"));
  // Tasks always belong to one project: the shared scope has none of its own, so it shows every project's.
  const scoped = scopeProject(scope);
  const key = scopeKey(scope);
  const [own, setViewState] = useState<View>(readView);
  const chosen = fixed ?? own;
  const view = chosen === "agent" && me.mode !== "hub" ? "list" : chosen;
  const setView = (v: View) => {
    setViewState(v);
    writeView(v);
  };
  const [status, setStatus] = useState<TaskStatus | "">("");
  // The board's columns are the statuses: it always gets every task.
  const filter = view === "list" ? status : "";
  const taskPoll = usePoll(me.mode === "hub" ? 5000 : null);
  const list = useQuery(
    () => client.call("tasks.list", { ...scopeFilter(scope), status: filter || undefined }),
    [client, key, filter, taskPoll],
  );
  const next = useQuery(() => client.call("tasks.next", { ...scopeFilter(scope), limit: 3 }), [client, key, list.data]);
  // Runs queued on a machine from here (hub only): which machine a task waits for, and what became of it.
  const hub = me.mode === "hub";
  const [pending, setPending] = useState(false);
  const poll = usePoll(pending ? PENDING_MS : null);
  const requests = useQuery(
    async () => (hub ? client.call("runs.requests", { ...scopeFilter(scope), limit: 200 }) : []),
    [client, hub, key, poll],
  );
  useEffect(() => setPending((requests.data ?? []).some((r) => r.status === "pending")), [requests.data]);
  const [openId, setOpenId] = useState<string | null>(null);
  // A link from another page (a chat reply naming a task) opens that task.
  const [linked, clearLinked] = useHashParam("task");
  useEffect(() => {
    if (linked) setOpenId(linked), clearLinked();
  }, [linked, clearLinked]);
  const open = list.data?.find((task) => task.id === openId) ?? null;
  const reload = () => (list.reload(), requests.reload());
  // Tasks picked to give to agents at once (roadmap 31a): on the hub, open ones of projects the person dispatches in.
  const [picks, setPicks] = useState<Set<string>>(new Set());
  const [assigning, setAssigning] = useState(false);
  const [batching, setBatching] = useState(false);
  const [batchSent, setBatchSent] = useState<number | null>(null);
  // Agents picked on the agent map (#/tasks?agents=…, roadmap 31b): the tasks picked here go to them in turn.
  const [agentsParam, clearAgents] = useHashParam("agents");
  const [agents, setAgents] = useState<AgentTarget[]>([]);
  useEffect(() => {
    // Tasks are picked in the list: that view, for this visit only.
    if (agentsParam) setAgents(decodeTargets(agentsParam)), setViewState("list"), clearAgents();
  }, [agentsParam, clearAgents]);
  const pickable = (task: Task) => hub && task.status !== "done" && allow(task.project, "runDispatch");
  const picked = [...picks].flatMap((id) => (list.data ?? []).filter((task) => task.id === id && pickable(task)));
  const pickedProjects = new Set(picked.map((task) => task.project));
  const togglePick = (id: string) =>
    setPicks((p) => {
      const next = new Set(p);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // A prompt makes a task and queues its run (roadmap 32b): whoever may do both, on the hub.
  const prompters = hub ? (scope.kind === "system" ? scope.projects : projects).filter((p) => allow(p, "taskManage") && allow(p, "runDispatch")) : [];
  const [prompting, setPrompting] = useState(false);

  const [agentFilter, setAgentFilter] = useState("");
  const machines = useQuery(async () => hub ? client.call("machines.list", {}) : [], [client, hub, poll]);
  const lanes = agentLanes(machines.data ?? [], list.data ?? [], t("assignment.any"), t("assignment.unassigned"));
  const visible = filterAgent(list.data ?? [], agentFilter);
  return (
    <Page wide={view !== "list"}>
      <PageHeader title={t("tasks.title")} subtitle={t("tasks.subtitle")} />
      <div className="flex flex-wrap items-center gap-2">
        {view === "list" ? (
          <NativeSelect value={status} onChange={(e) => setStatus(e.target.value as TaskStatus | "")} aria-label={t("tasks.status")}>
            <NativeSelectOption value="">{t("tasks.anyStatus")}</NativeSelectOption>
            {TASK_STATUSES.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {t(`taskStatus.${s}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : null}
        {hub ? <NativeSelect data-agent-filter aria-label={t("assignment.agent")} wrapperClassName="max-w-full" className="max-md:min-h-11 max-md:text-base" value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)}>
          <NativeSelectOption value="">{t("assignment.all")}</NativeSelectOption>
          {lanes.map((lane) => <NativeSelectOption key={lane.key} value={lane.key}>{lane.label}</NativeSelectOption>)}
        </NativeSelect> : null}
        {switcher ?? <ViewSwitch value={view} onChange={setView} agents={hub} />}
        {prompters.length ? (
          <Button size="sm" className="max-md:min-h-10" onClick={() => setPrompting(true)} data-prompt-agent>
            <Sparkles />
            {t("tasks.promptOpen")}
          </Button>
        ) : null}
      </div>
      {scope.kind === "shared" ? <Notice tone="info">{t("tasks.sharedScope")}</Notice> : null}
      {next.data && list.data?.some((task) => task.status !== "done") ? (
        <Notice tone="info">
          {next.data.length ? (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium">{t("tasks.nextReady")}</span>
              {next.data.map((task) => (
                <span key={task.id} className="min-w-0 wrap-anywhere">
                  <span className="font-mono text-xs">{task.id}</span> {task.title}
                </span>
              ))}
            </span>
          ) : (
            t("tasks.nextNone")
          )}
        </Notice>
      ) : null}
      {managed.length || allow(null, "taskManage") ? (
        <CreateTask
          key={scoped ?? ""}
          defaultProject={scoped && managed.includes(scoped) ? scoped : ""}
          projects={allow(null, "taskManage") ? projects : managed}
          onCreated={list.reload}
        />
      ) : null}
      <ErrorNote error={list.error} />
      {batchSent !== null ? (
        <Notice tone="ok">
          {t("tasks.batchSent", { id: batchSent })}{" "}
          <a className="font-medium underline underline-offset-2" href={`#/batches?group=${batchSent}`}>
            {t("tasks.batchView")}
          </a>
        </Notice>
      ) : null}
      {agents.length ? (
        <Notice tone="info">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{t("tasks.agentsPicked", { count: agents.length })}</span>
            <button type="button" className="font-medium underline underline-offset-2" onClick={() => setAgents([])}>
              {t("tasks.agentsClear")}
            </button>
          </span>
        </Notice>
      ) : null}
      {picked.length ? (
        <div role="toolbar" aria-label={t("tasks.picked", { count: picked.length })} className="flex flex-wrap items-center gap-2 rounded-[10px] bg-inverse px-3 py-2 text-[13px] text-fg-inverse">
          <span className="font-semibold">{t("tasks.picked", { count: picked.length })}</span>
          {pickedProjects.size > 1 ? <span className="text-xs opacity-80">{t("tasks.batchOneProject")}</span> : null}
          <span className="flex-1" />
          <Button data-assign-bulk className="max-md:min-h-11" onClick={() => setAssigning(true)}>{t("assignment.assign")}</Button>
          <button
            type="button"
            disabled={pickedProjects.size !== 1}
            onClick={() => setBatching(true)}
            data-batch-open
            className="h-7 cursor-pointer rounded-sm border border-white/30 px-2.5 text-xs font-semibold outline-none hover:bg-white/10 focus-visible:focus-ring disabled:cursor-default disabled:opacity-60"
          >
            {t("tasks.batchOpen", { count: picked.length })}
          </button>
          <button type="button" onClick={() => setPicks(new Set())} className="h-7 cursor-pointer rounded-sm px-2 text-xs underline">
            {t("tasks.clearPicks")}
          </button>
        </div>
      ) : null}
      {list.data?.length === 0 ? <Empty>{t("tasks.none")}</Empty> : null}
      {hub && view === "agent" ? <AgentBoard tasks={visible} machines={machines.data ?? []} onOpen={setOpenId} onChanged={reload} /> : null}
      {list.data?.length && view === "kanban" ? (
        <TaskKanban
          tasks={visible}
          showProject={scoped === null}
          requests={requests.data ?? []}
          nextIds={(next.data ?? []).map((task) => task.id)}
          selectedId={openId}
          onOpen={setOpenId}
          onChanged={reload}
        />
      ) : null}
      {list.data?.length && view === "list" ? (
        <div className="overflow-x-auto rounded-lg border">
          {/* Fixed columns: a long title or note wraps in its own cell instead of pushing the others out of view. */}
          <Table className={cn("table-fixed", scoped === null ? "md:min-w-[56rem]" : "md:min-w-[48rem]")}>
            <colgroup>
              <col />
              {scoped === null ? <col className="w-28" /> : null}
              <col className="w-36" />
              <col className="hidden w-32 md:table-column" />
              <col className="hidden w-40 md:table-column" />
              <col className="hidden w-28 md:table-column" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead>{t("tasks.colTask")}</TableHead>
                {scoped === null ? <TableHead>{t("tasks.colProject")}</TableHead> : null}
                <TableHead>{t("tasks.status")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("tasks.colDeps")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("tasks.colOwner")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("tasks.colUpdated")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  waiting={requests.data?.find((r) => r.taskId === task.id && r.project === task.project && r.status === "pending") ?? null}
                  showProject={scoped === null}
                  selected={task.id === openId}
                  pick={pickable(task) ? { on: picks.has(task.id), toggle: () => togglePick(task.id) } : null}
                  onOpen={() => setOpenId(task.id)}
                  onChanged={reload}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
      <Sheet open={assigning} onOpenChange={setAssigning}>
        {assigning ? <SheetContent className="w-full overflow-y-auto sm:max-w-xl"><SheetHeader><SheetTitle>{t("assignment.assign")}</SheetTitle><SheetDescription>{t("tasks.picked", { count: picked.length })}</SheetDescription></SheetHeader><div className="p-4"><AgentAssignment tasks={picked} onChanged={reload} onAssigned={() => { setAssigning(false); setPicks(new Set()); }} /></div></SheetContent> : null}
      </Sheet>
      <Sheet open={batching} onOpenChange={setBatching}>
        {batching && picked.length && pickedProjects.size === 1 ? (
          <BatchSheet
            tasks={picked}
            targets={agents}
            onSent={(id) => {
              setBatching(false);
              setPicks(new Set());
              setAgents([]);
              setBatchSent(id);
              reload();
            }}
          />
        ) : null}
      </Sheet>
      <Sheet open={prompting} onOpenChange={setPrompting}>
        {prompting ? (
          <PromptSheet
            projects={prompters}
            defaultProject={scoped && prompters.includes(scoped) ? scoped : prompters[0]!}
            onSent={(task) => {
              setPrompting(false);
              reload();
              setOpenId(task.id);
            }}
            onGroup={(id) => {
              setPrompting(false);
              setBatchSent(id);
              reload();
            }}
          />
        ) : null}
      </Sheet>
      <Sheet open={open !== null} onOpenChange={(v) => (v ? null : setOpenId(null))}>
        {open ? (
          <TaskDetail
            task={open}
            requests={(requests.data ?? []).filter((r) => r.taskId === open.id && r.project === open.project)}
            hub={hub}
            onChanged={reload}
          />
        ) : null}
      </Sheet>
    </Page>
  );
}

function TaskRow({
  task,
  waiting,
  showProject,
  selected,
  pick,
  onOpen,
  onChanged,
}: {
  task: Task;
  waiting: RunRequest | null;
  showProject: boolean;
  selected: boolean;
  /** Its box for giving several tasks to agents at once (roadmap 31a); null when it cannot be picked. */
  pick: { on: boolean; toggle: () => void } | null;
  onOpen: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  // The controls in a row do their own thing; a click anywhere else opens the task.
  const keep = (e: { stopPropagation(): void }) => e.stopPropagation();
  return (
    <TableRow data-state={selected ? "selected" : undefined} className="cursor-pointer data-[state=selected]:bg-brand-soft/60" onClick={onOpen}>
      <TableCell className="align-top whitespace-normal">
        <div className="flex min-w-0 items-start gap-2">
          {pick ? (
            <span onClick={keep} className="pt-0.5">
              <Checkbox checked={pick.on} onCheckedChange={pick.toggle} aria-label={t("tasks.pick", { id: task.id })} data-pick-task={task.id} />
            </span>
          ) : null}
          <button type="button" className="flex w-full min-w-0 flex-col items-start gap-0.5 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" onClick={onOpen}>
            <span className="flex max-w-full items-baseline gap-2">
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{task.id}</span>
              <span className="min-w-0 font-medium wrap-anywhere">{task.title}</span>
            </span>
            {task.agent ? <span className="text-xs text-info wrap-anywhere">{agentLabel(task.agent, t("assignment.any"))}</span> : null}
            {task.note ? <span className="line-clamp-2 max-w-full text-xs text-muted-foreground wrap-anywhere">{task.note}</span> : null}
          </button>
        </div>
      </TableCell>
      {showProject ? (
        <TableCell className="align-top">
          <OwnerBadge owner={task.project} className="max-w-full truncate" />
        </TableCell>
      ) : null}
      <TableCell className="align-top whitespace-normal" onClick={keep}>
        <StatusSelect task={task} onChanged={onChanged} />
        {waiting ? <div className="mt-1 text-xs wrap-anywhere text-info">{t("tasks.waitingMachine", { machine: waiting.machine })}</div> : null}
      </TableCell>
      <TableCell className="hidden align-top text-xs whitespace-normal md:table-cell" onClick={keep}>
        <Deps task={task} onChanged={onChanged} />
      </TableCell>
      <TableCell className="hidden align-top text-xs whitespace-normal md:table-cell">
        <Owner task={task} />
      </TableCell>
      <TableCell className="hidden align-top text-xs whitespace-normal text-muted-foreground md:table-cell">{formatTime(task.updatedAt)}</TableCell>
    </TableRow>
  );
}

function Owner({ task }: { task: Task }) {
  const t = useT();
  if (!task.owner) return <span className="text-muted-foreground">—</span>;
  const { who, machine } = ownerLabel(task.owner);
  return (
    <div className="flex min-w-0 flex-col" title={task.owner}>
      <span className="font-mono wrap-anywhere">{who}</span>
      {machine ? <span className="font-mono wrap-anywhere text-muted-foreground">{machine}</span> : null}
      {task.leaseUntil ? <span className="text-muted-foreground">{t("tasks.leaseUntil", { time: formatTime(task.leaseUntil) })}</span> : null}
    </div>
  );
}

function StatusSelect({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const { client, me } = useHive();
  const t = useT();
  const allow = useCan();
  const action = useAction();
  if (!allow(task.project, "taskWork")) return <Badge tone={STATUS_TONE[task.status]}>{t(`taskStatus.${task.status}`)}</Badge>;
  return (
    <div className="flex flex-col gap-1">
      <NativeSelect
        size="sm"
        className={cn("w-full", TONE_TEXT[STATUS_TONE[task.status] ?? ""])}
        value={task.status}
        disabled={action.busy}
        aria-label={t("tasks.statusOf", { id: task.id })}
        onChange={(e) =>
          void action.run(async () => {
            await client.call("tasks.update", { id: task.id, status: e.target.value as TaskStatus });
            onChanged();
          })
        }
      >
        {TASK_STATUSES.map((s) => (
          <NativeSelectOption key={s} value={s} disabled={s === "done" && task.status !== "done" && !canCloseTask(me, task.project)}>
            {t(`taskStatus.${s}`)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {task.status !== "done" && !canCloseTask(me, task.project) ? <span className="text-xs text-muted-foreground">{t("tasks.doneNeedsReview")}</span> : null}
      <ErrorNote error={action.error} />
    </div>
  );
}

/** Everything about one task: its full note, what it depends on, and (hub) running it on a team machine. */
function TaskDetail({ task, requests, hub, onChanged }: { task: Task; requests: RunRequest[]; hub: boolean; onChanged: () => void }) {
  const t = useT();
  const allow = useCan();
  return (
    <SheetContent className="w-full gap-0 sm:max-w-xl">
      <SheetHeader className="border-b pr-10">
        <SheetTitle className="flex flex-col gap-1">
          <span className="font-mono text-xs font-normal text-muted-foreground">
            {task.project} · {task.id}
          </span>
          <span className="wrap-anywhere">{task.title}</span>
        </SheetTitle>
        <SheetDescription asChild>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[task.status]}>{t(`taskStatus.${task.status}`)}</Badge>
            <span className="text-xs">{t("tasks.updatedAt", { time: formatTime(task.updatedAt) })}</span>
          </div>
        </SheetDescription>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        <section className="grid grid-cols-[auto_1fr] items-start gap-x-4 gap-y-3 text-sm">
          <span className="text-xs font-medium text-muted-foreground">{t("tasks.status")}</span>
          <div className="max-w-48">
            <StatusSelect task={task} onChanged={onChanged} />
          </div>
          <TaskClassField task={task} field="kind" values={TASK_KINDS} onChanged={onChanged} />
          <TaskClassField task={task} field="size" values={TASK_SIZES} onChanged={onChanged} />
          <TaskClassField task={task} field="risk" values={TASK_RISKS} onChanged={onChanged} />
          <span className="text-xs font-medium text-muted-foreground">{t("tasks.colDeps")}</span>
          <div className="text-xs">
            <Deps task={task} onChanged={onChanged} />
          </div>
          <span className="text-xs font-medium text-muted-foreground">{t("tasks.colOwner")}</span>
          <div className="text-xs">
            <Owner task={task} />
          </div>
        </section>
        {/* A task the hub drives through the project's gates (roadmap 34b). */}
        {hub ? <FlowList project={task.project} taskId={task.id} /> : null}
        {hub ? <FlowTaskPanel project={task.project} taskId={task.id} /> : null}
        {hub ? <AgentAssignment tasks={[task]} onChanged={onChanged} /> : null}
        {hub && allow(task.project, "runDispatch") && task.status !== "done" ? <DispatchForm task={task} requests={requests} onSent={onChanged} /> : null}
        {hub && requests.length ? <RequestList requests={requests} onChanged={onChanged} /> : null}
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">{t("tasks.colNote")}</h3>
          {task.note ? (
            <div className="rounded-md border bg-muted/40 p-3 text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere">{task.note}</div>
          ) : (
            <p className="text-xs text-muted-foreground">{t("tasks.noNote")}</p>
          )}
        </section>
      </div>
    </SheetContent>
  );
}

function TaskClassField({ task, field, values, onChanged }: { task: Task; field: "kind" | "size" | "risk"; values: readonly string[]; onChanged: () => void }) {
  const { client } = useHive();
  const t = useT();
  const allow = useCan();
  const action = useAction();
  const label = t(`taskClass.${field}`);
  return <>
    <span className="text-xs font-medium text-muted-foreground">{label}</span>
    <div className="min-w-0">
      {allow(task.project, "taskManage") ? <NativeSelect size="sm" className="w-full max-w-48" value={task[field] ?? ""} aria-label={label} disabled={action.busy}
        onChange={(e) => void action.run(async () => {
          const value = e.target.value;
          await client.call("tasks.classify", { id: task.id, ...(field === "kind" ? { kind: value as TaskKind } : field === "size" ? { size: value as TaskSize } : { risk: value as TaskRisk }) });
          onChanged();
        })}>
        <NativeSelectOption value="" disabled>{t("taskClass.unknown")}</NativeSelectOption>
        {values.map((value) => <NativeSelectOption key={value} value={value}>{t(`taskClass.${field}Values.${value}` as Parameters<typeof t>[0])}</NativeSelectOption>)}
      </NativeSelect> : <span className="text-sm">{task[field] ? t(`taskClass.${field}Values.${task[field]}` as Parameters<typeof t>[0]) : t("taskClass.unknown")}</span>}
      <ErrorNote error={action.error} />
    </div>
  </>;
}

/** Machines that can take this task's run now: online, taking runs from the hub, with the project's repo. */

function DispatchForm({ task, requests, onSent }: { task: Task; requests: RunRequest[]; onSent: () => void }) {
  const { client } = useHive();
  const t = useT();
  const machines = useQuery(() => client.call("machines.list", {}), [client]);
  const fit = (machines.data ?? []).filter((m) => takesRunsOf(m, task.project));
  const [machineId, setMachineId] = useState("");
  const machine = fit.find((m) => m.id === machineId) ?? fit[0] ?? null;
  const [role, setRole] = useState<AgentRole>(task.status === "review" ? "review" : "implement");
  const [profileId, setProfileId] = useState("");
  const [preferKind, setPreferKind] = useState<PreferKind | "">("");
  const [instructions, setInstructions] = useState("");
  const [reviewAfter, setReviewAfter] = useState(true);
  const [candidates, setCandidates] = useState(1);
  const action = useAction();
  const several = role === "implement" && !profileId;
  const waiting = waitingLabels(task);
  const pending = requests.find((r) => r.status === "pending");

  return (
    <section className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium">{t("tasks.dispatchTitle")}</h3>
        <p className="text-xs text-muted-foreground">{t("tasks.dispatchHint")}</p>
      </div>
      <ErrorNote error={machines.error} />
      {machines.data && !fit.length ? <Notice tone="info">{t("tasks.dispatchNoMachine", { project: task.project })}</Notice> : null}
      {waiting.length ? <Notice tone="warn">{t("board.waitingOn", { tasks: waiting.join(", ") })}</Notice> : null}
      {pending ? <Notice tone="info">{t("tasks.waitingMachine", { machine: pending.machine })}</Notice> : null}
      {machine && !waiting.length && !pending ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await client.call("runs.dispatch", {
                machineId: machine.id,
                project: task.project,
                taskId: task.id,
                role,
                profileId: profileId || null,
                preferKind: (!profileId && preferKind) || null,
                reviewAfter: role !== "review" && reviewAfter,
                candidates: several ? candidates : 1,
                instructions,
              });
              setInstructions("");
              onSent();
            });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <MachineSelect id={`machine-${task.id}`} machines={fit} value={machine.id} onChange={(id) => (setMachineId(id), setProfileId(""))} />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`role-${task.id}`}>{t("board.role")}</Label>
              <NativeSelect id={`role-${task.id}`} size="sm" className="w-full" value={role} onChange={(e) => setRole(e.target.value as AgentRole)}>
                {AGENT_ROLES.map((r) => (
                  <NativeSelectOption key={r} value={r}>
                    {t(`agentRole.${r}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <ProfileSelect id={`profile-${task.id}`} machine={machine} value={profileId} onChange={setProfileId} />
            {!profileId ? <PreferKindSelect id={`prefer-${task.id}`} machine={machine} value={preferKind} onChange={setPreferKind} /> : null}
            {several ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`candidates-${task.id}`}>{t("board.candidates")}</Label>
                <NativeSelect
                  id={`candidates-${task.id}`}
                  size="sm"
                  className="w-full"
                  value={String(candidates)}
                  onChange={(e) => setCandidates(Number(e.target.value))}
                  title={t("board.candidatesHint")}
                >
                  {Array.from({ length: MAX_CANDIDATES }, (_, i) => i + 1).map((n) => (
                    <NativeSelectOption key={n} value={String(n)}>
                      {n === 1 ? t("board.candidatesOne") : t("board.candidatesMany", { n })}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            ) : null}
          </div>
          {several && candidates > 1 ? <p className="text-xs text-muted-foreground">{t("board.candidatesHint")}</p> : null}
          <Textarea
            placeholder={t("board.instructionsPlaceholder")}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            aria-label={t("board.instructions")}
          />
          {role !== "review" ? (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={reviewAfter} onCheckedChange={(v) => setReviewAfter(v === true)} />
              {t("board.reviewAfter")}
            </label>
          ) : null}
          <div>
            <Button size="sm" type="submit" disabled={action.busy}>
              {t("tasks.dispatchSend")}
            </Button>
          </div>
          <ErrorNote error={action.error} />
        </form>
      ) : null}
    </section>
  );
}

function RequestList({ requests, onChanged }: { requests: RunRequest[]; onChanged: () => void }) {
  const t = useT();
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{t("tasks.requests")}</h3>
      <ul className="flex flex-col gap-2">
        {requests.slice(0, 5).map((r) => (
          <RequestItem key={r.id} request={r} onChanged={onChanged} />
        ))}
      </ul>
    </section>
  );
}

function RequestItem({ request: r, onChanged }: { request: RunRequest; onChanged: () => void }) {
  const { client } = useHive();
  const t = useT();
  const allow = useCan();
  const action = useAction();
  return (
    <li className="flex flex-col gap-1 rounded-md border p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={REQUEST_TONE[r.status] ?? "neutral"}>{t(`requestStatus.${r.status}`)}</Badge>
        <span className="font-mono">{r.machine}</span>
        <span className="text-muted-foreground">
          {runLabel("agentRole", r.role)} · {r.profileId ?? t("board.auto")}
          {r.candidates > 1 ? ` · ${t("board.candidatesMany", { n: r.candidates })}` : ""}
        </span>
      </div>
      <div className="text-muted-foreground">{t("tasks.requestBy", { who: r.requestedBy, time: formatTime(r.requestedAt) })}</div>
      {r.runId ? (
        <a className="font-medium text-primary underline underline-offset-2" href={`#/runs?run=${encodeURIComponent(r.runId)}`}>
          {t("tasks.requestRun", { run: r.runId })}
        </a>
      ) : null}
      {r.error ? <div className="text-destructive wrap-anywhere">{requestErrorText(r.error)}</div> : null}
      {r.status === "pending" && allow(r.project, "runDispatch") ? (
        <div>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-xs"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await client.call("runs.cancelRequest", { id: r.id });
                onChanged();
              })
            }
          >
            {t("tasks.cancelRequest")}
          </Button>
        </div>
      ) : null}
      <ErrorNote error={action.error} />
    </li>
  );
}

/** "T-1, T-2" → ids. */
const parseIds = (text: string) => text.split(/[\s,]+/).filter(Boolean);

function Deps({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const { client, me } = useHive();
  const t = useT();
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const deps = task.dependsOn ?? [];
  const [text, setText] = useState(deps.join(", "));
  if (editing) {
    return (
      <form
        className="flex flex-col gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await client.call("tasks.setDeps", { id: task.id, dependsOn: parseIds(text) });
            setEditing(false);
            onChanged();
          });
        }}
      >
        <Input className="h-7 w-full max-w-40 font-mono text-xs md:text-xs" placeholder="T-1, T-2" value={text} onChange={(e) => setText(e.target.value)} aria-label={t("tasks.depsOf", { id: task.id })} />
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="outline" type="submit" disabled={action.busy}>
            {t("tasks.saveDeps")}
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => (setEditing(false), setText(deps.join(", ")))}>
            {t("common.cancel")}
          </Button>
        </div>
        <ErrorNote error={action.error} />
      </form>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {deps.length ? (
        deps.map((d) => {
          const open = (task.waitingOn ?? []).includes(d);
          return (
            <span key={d} title={t(open ? "tasks.depOpen" : "tasks.depDone", { id: d })}>
              <Badge tone={open ? "warn" : "ok"}>{depLabel(task, d)}</Badge>
            </span>
          );
        })
      ) : (
        <span className="text-muted-foreground">—</span>
      )}
      {task.waitingHidden ? (
        <span title={t("tasks.depHidden", { count: task.waitingHidden })}>
          <Badge tone="warn">+{task.waitingHidden}</Badge>
        </span>
      ) : null}
      {canEditDependencies(me, task.project) && task.status !== "done" ? (
        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs" onClick={() => setEditing(true)}>
          {t("tasks.editDeps")}
        </Button>
      ) : null}
    </div>
  );
}

function CreateTask({
  defaultProject,
  projects,
  onCreated,
}: {
  defaultProject: string;
  projects: string[];
  onCreated: () => void;
}) {
  const { client } = useHive();
  const t = useT();
  const [id, setId] = useState("");
  // undefined: not typed yet, so it shows the scope's project (prefilled in a project scope).
  const [project, setProject] = useState<string>();
  const [title, setTitle] = useState("");
  const [deps, setDeps] = useState("");
  const [expanded, setExpanded] = useState(false);
  const action = useAction();
  const effectiveProject = project ?? defaultProject;
  return (
    <div>
      <Button type="button" variant="outline" className="mb-2 min-h-10 md:hidden" data-create-task-toggle aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
        {t("shell.newTask")}
      </Button>
      <Card className={cn("py-4", !expanded && "hidden md:flex")}>
        <CardContent className="flex flex-col gap-2 px-4">
          <form
            className="flex flex-wrap items-center gap-2 max-md:flex-col max-md:items-stretch max-md:[&_input]:min-h-10"
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                await client.call("tasks.create", { id: id.trim(), project: effectiveProject.trim(), title: title.trim(), dependsOn: parseIds(deps) });
                setId("");
                setTitle("");
                setDeps("");
                setExpanded(false);
                onCreated();
              });
            }}
          >
            <Input className="w-28 font-mono text-base md:text-xs max-md:w-full" placeholder="T-001" value={id} onChange={(e) => setId(e.target.value)} aria-label={t("tasks.newId")} />
            <Input
              className="w-40 min-w-0 flex-1 font-mono text-base md:text-xs max-md:w-full"
              placeholder={t("tasks.newProject")}
              list="hive-projects"
              value={effectiveProject}
              onChange={(e) => setProject(e.target.value)}
              aria-label={t("tasks.colProject")}
            />
            <datalist id="hive-projects">
              {projects.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
            <Input className="min-w-48 flex-1 max-md:w-full max-md:min-w-0" placeholder={t("tasks.newTitle")} value={title} onChange={(e) => setTitle(e.target.value)} aria-label={t("tasks.colTitle")} />
            <Input
              className="w-40 font-mono text-base md:text-xs max-md:w-full"
              placeholder={t("tasks.newDeps")}
              value={deps}
              onChange={(e) => setDeps(e.target.value)}
              aria-label={t("tasks.colDeps")}
            />
            <Button variant="outline" type="submit" className="max-md:min-h-10" disabled={!id.trim() || !effectiveProject.trim() || !title.trim() || action.busy}>
              {t("tasks.create")}
            </Button>
          </form>
          <ErrorNote error={action.error} />
        </CardContent>
      </Card>
    </div>
  );
}
