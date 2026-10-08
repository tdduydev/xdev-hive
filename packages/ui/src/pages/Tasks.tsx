import { allDispatchTasks } from "#ui/lib/inbox-source.ts";
import { useChatPageContext } from "#ui/components/ChatSession.tsx";
import { TaskRunChain } from "#ui/components/RunRedispatch.tsx";
import { ImplementationPlans } from "#ui/components/ImplementationPlans.tsx";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@xdev-hive/ui/components/ui/tabs";
import { ServiceFilter, useServiceFilter } from "#ui/components/ServiceFilter.tsx";
import { ResponsiveTable as Table, ResponsiveTableRow as TableRow } from "#ui/components/ResponsiveTable.tsx";
import { TaskModelChips } from "#ui/components/ModelChip.tsx";
import { Fragment, useContext, useEffect, useState, type ReactNode } from "react";
import { cn } from "cn";
import { DEFAULT_RUN_TIMEOUT, runTimeoutMinutes, WORK_ROLES, MAX_CANDIDATES, TASK_STATUSES, type WorkRole, type PreferKind, type RunRequest, type Task, type TaskNote, type TaskStatus } from "@xdev-hive/core";
import { CLASS_FIELDS, CLASS_VALUES, classInput, classSource, type ClassField } from "#ui/lib/task-class.ts";
import { ListOrdered, Split, Sparkles } from "lucide-react";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@xdev-hive/ui/components/ui/dropdown-menu";
import { Card } from "@xdev-hive/ui/components/ui/card";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@xdev-hive/ui/components/ui/sheet";
import { TableBody, TableCell, TableHead, TableHeader } from "@xdev-hive/ui/components/ui/table";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Badge, Empty, ErrorNote, Notice, OwnerBadge, Page, PageHeader, STATUS_TONE } from "#ui/components/common.tsx";
import { BatchSheet, PromptSheet, RolesSheet, SplitSheet } from "#ui/components/AgentSheets.tsx";
import { BoardPage } from "#ui/pages/Board.tsx";
import { Diff } from "#ui/components/Diff.tsx";
import { ArtifactContext, ArtifactRows, ArtifactText, useArtifacts } from "#ui/components/Artifacts.tsx";
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
/** An agent splitting a job lists its parts within minutes: look again this often, so they show to be checked. */
const OPEN_GROUP_MS = 5000;

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
  const [dispatchLink] = useHashParam("pipelineDispatch");
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
  // A pipeline total belongs to the scope, so its link must open the shared list even on a machine Board.
  if (dispatchLink === "1") return <TasksPage view="list" />;
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
  const { client, scope, projects, me, setScope } = useHive();
  const t = useT();
  const allow = useCan();
  // A system's new tasks go to one of its projects.
  // Tasks always belong to one project: the shared scope has none of its own, so it shows every project's.
  const scoped = scopeProject(scope);
  const [linkedProject] = useHashParam("project");
  const [linkedIds] = useHashParam("ids");
  const [linkedDispatch] = useHashParam("pipelineDispatch");
  const [linkedKind] = useHashParam("kind");
  useEffect(() => {
    if (linkedProject && projects.includes(linkedProject) && linkedProject !== scoped) setScope({ kind: "project", project: linkedProject });
  }, [linkedProject, projects, scoped, setScope]);
  const key = scopeKey(scope);
  const [service, setService] = useServiceFilter(scope);
  const [own, setViewState] = useState<View>(readView);
  const [linkedStatus] = useHashParam("status");
  const chosen = fixed ?? (linkedStatus ? "list" : own);
  const view = chosen === "agent" && me.mode !== "hub" ? "list" : chosen;
  const setView = (v: View) => {
    setViewState(v);
    writeView(v);
  };
  const [status, setStatus] = useState<TaskStatus | "">("");
  useEffect(() => { if (linkedStatus && TASK_STATUSES.includes(linkedStatus as TaskStatus)) setStatus(linkedStatus as TaskStatus); }, [linkedStatus]);
  // The board's columns are the statuses: it always gets every task.
  const filter = view === "list" ? status : "";
  const taskPoll = usePoll(me.mode === "hub" ? 5000 : null);
  const list = useQuery(
    async () => linkedDispatch === "1"
      ? (await allDispatchTasks(client, { ...(linkedProject ? { project: linkedProject } : service ? { project: service } : scopeFilter(scope)) })).filter((task) => !filter || task.status === filter)
      : client.call("tasks.list", { ...(service ? { project: service } : scopeFilter(scope)), status: filter || undefined }),
    [client, key, service, filter, taskPoll, linkedDispatch, linkedProject],
  );
  const next = useQuery(() => client.call("tasks.next", { ...(service ? { project: service } : scopeFilter(scope)), limit: 3 }), [client, key, service, list.data]);
  // Runs queued on a machine from here (hub only): which machine a task waits for, and what became of it.
  const hub = me.mode === "hub";
  const [pending, setPending] = useState(false);
  const poll = usePoll(pending ? PENDING_MS : null);
  const requests = useQuery(
    async () => (hub ? client.call("runs.requests", { ...(service ? { project: service } : scopeFilter(scope)), limit: 200 }) : []),
    [client, hub, key, service, poll],
  );
  useEffect(() => setPending((requests.data ?? []).some((r) => r.status === "pending")), [requests.data]);
  const [openId, setOpenId] = useState<string | null>(null);
  // A link from another page (a chat reply naming a task) opens that task.
  const [linked, clearLinked] = useHashParam("task");
  useEffect(() => {
    if (linked) setOpenId(linked), clearLinked();
  }, [linked, clearLinked]);
  const open = list.data?.find((task) => task.id === openId) ?? null;
  useChatPageContext(open ? { id: open.id, href: `#/tasks?task=${encodeURIComponent(open.id)}`, project: open.project } : null);
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
  // A big job in parts (roadmap 31c): a new one, or one whose parts an agent listed, waiting for a person to check them.
  const [splitting, setSplitting] = useState<number | "new" | null>(null);
  const [splitRunning, setSplitRunning] = useState(false);
  const jobsPoll = usePoll(splitRunning ? OPEN_GROUP_MS : null);
  const jobs = useQuery(
    async () => (prompters.length ? client.call("runs.groups", { ...scopeFilter(scope), limit: 30 }) : []),
    [client, key, prompters.length, jobsPoll, list.data],
  );
  const mapGroups = (jobs.data ?? []).filter((g) => g.kind === "mapreduce" && !g.closedAt && prompters.includes(g.project));
  useEffect(() => setSplitRunning(mapGroups.some((g) => g.phase === "split")), [jobs.data]);
  const readyJobs = mapGroups.filter((g) => g.phase === "ready");
  // A link from Đợt chạy (#/tasks?split=…) opens that group's parts.
  const [splitParam, clearSplit] = useHashParam("split");
  useEffect(() => {
    if (splitParam) setSplitting(Number(splitParam) || null), clearSplit();
  }, [splitParam, clearSplit]);
  // A chain of roles on one task (roadmap 31d): from the one picked task, or from a task's panel.
  const [chaining, setChaining] = useState<Task | null>(null);
  const readyGroup = typeof splitting === "number" ? (mapGroups.find((g) => g.id === splitting && g.phase === "ready") ?? null) : null;


  const [agentFilter, setAgentFilter] = useState("");
  const machines = useQuery(async () => hub ? client.call("machines.list", {}) : [], [client, hub, poll]);
  const lanes = agentLanes(machines.data ?? [], list.data ?? [], t("assignment.any"), t("assignment.unassigned"));
  const visible = filterAgent(list.data ?? [], agentFilter).filter((task) => (linkedIds === null || linkedIds.split(",").includes(task.id))).filter((task) => !linkedKind || (task.status !== "done" && (linkedKind === "fast" ? ["docs", "small-fix", "test"] : linkedKind.split(",")).includes(task.kind ?? "")));
  return (
    <Page wide={view !== "list"}>
      <PageHeader title={t("tasks.title")} subtitle={t("tasks.subtitle")} />
      <div className="flex flex-wrap items-center gap-2">
        <ServiceFilter scope={scope} value={service} onChange={setService} />
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
        {/* One create entry (49c) stays + Mới: what asks an agent to write or split work lives behind one menu, not as buttons of its own. */}
        {prompters.length ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="max-md:min-h-11" data-agent-work-menu>
                <Sparkles aria-hidden="true" />
                {t("tasks.agentWork")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setPrompting(true)} data-prompt-agent>
                <Sparkles aria-hidden="true" />
                {t("tasks.promptOpen")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setSplitting("new")} data-map-open>
                <Split aria-hidden="true" />
                {t("tasks.mapOpen")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
      <ErrorNote error={list.error} />
      {batchSent !== null ? (
        <Notice tone="ok">
          {t("tasks.batchSent", { id: batchSent })}{" "}
          <a className="font-medium underline underline-offset-2" href={`#/runs?tab=batches&group=${batchSent}`}>
            {t("tasks.batchView")}
          </a>
        </Notice>
      ) : null}
      {readyJobs.map((g) => (
        <Notice key={g.id} tone="warn">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 wrap-anywhere">{t("tasks.mapReady", { task: g.parentTask ?? "", title: g.title, count: g.parts.length })}</span>
            <button type="button" className="font-medium underline underline-offset-2 focus-visible:focus-ring max-md:min-h-11" onClick={() => setSplitting(g.id)} data-map-ready={g.id}>
              {t("tasks.mapReadyOpen")}
            </button>
          </span>
        </Notice>
      ))}
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
          <button
            type="button"
            disabled={picked.length !== 1}
            title={picked.length !== 1 ? t("tasks.rolesOpenHint") : undefined}
            onClick={() => setChaining(picked[0]!)}
            data-roles-open
            className="h-7 max-md:min-h-11 cursor-pointer rounded-sm border border-white/30 px-2.5 text-xs font-semibold outline-none hover:bg-white/10 focus-visible:focus-ring disabled:cursor-default disabled:opacity-60"
          >
            {t("tasks.rolesOpen")}
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
                {scoped === null ? <TableHead>{t("systemOverview.service")}</TableHead> : null}
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
      <Sheet open={chaining !== null} onOpenChange={(v) => (v ? null : setChaining(null))}>
        {chaining ? (
          <RolesSheet
            key={chaining.id}
            task={chaining}
            onSent={(id) => {
              setChaining(null);
              setPicks(new Set());
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
      <Sheet open={splitting === "new" || readyGroup !== null} onOpenChange={(v) => (v ? null : setSplitting(null))}>
        {splitting === "new" || readyGroup ? (
          <SplitSheet
            key={readyGroup?.id ?? "new"}
            projects={prompters}
            defaultProject={scoped && prompters.includes(scoped) ? scoped : (prompters[0] ?? "")}
            ready={readyGroup}
            onGroup={(id) => {
              setSplitting(null);
              setBatchSent(id);
              reload();
              jobs.reload();
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
            onRoles={() => (setOpenId(null), setChaining(open))}
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
function TaskDetail({ task, requests, hub, onChanged, onRoles }: { task: Task; requests: RunRequest[]; hub: boolean; onChanged: () => void; onRoles: () => void }) {
  const t = useT();
  const allow = useCan();
  const files = useArtifacts(task.project, task.id, undefined, undefined, task.updatedAt);
  return (
    <ArtifactContext.Provider value={files.data ?? []}>
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
      <Tabs defaultValue="details" className="min-h-0 flex-1 overflow-y-auto p-4">
        <TabsList variant="line" className="shrink-0 flex-wrap">
          <TabsTrigger value="details" className="min-h-(--control-h-touch)">{t("planApproval.detail")}</TabsTrigger>
          {hub ? <TabsTrigger value="artifacts" className="min-h-(--control-h-touch)" data-task-artifacts-tab>{t("artifacts.title")} ({files.data?.length ?? "…"})</TabsTrigger> : null}
          {hub ? <TabsTrigger value="plan" className="min-h-(--control-h-touch)" data-task-plan-tab>{t("planApproval.tab")}</TabsTrigger> : null}
        </TabsList>
        {hub ? <TabsContent value="artifacts"><ArtifactRows files={files.data ?? []} error={files.error} loading={files.loading} onChanged={files.reload} context={task.id} /></TabsContent> : null}
        {hub ? <TabsContent value="plan"><ImplementationPlans project={task.project} taskId={task.id} /></TabsContent> : null}
        <TabsContent value="details" className="flex flex-col gap-5">
        <section className="grid grid-cols-[auto_1fr] items-start gap-x-4 gap-y-3 text-sm">
          <span className="text-xs font-medium text-muted-foreground">{t("tasks.status")}</span>
          <div className="max-w-48">
            <StatusSelect task={task} onChanged={onChanged} />
          </div>
          <TaskClassFields task={task} onChanged={onChanged} />
          <span className="text-xs font-medium text-muted-foreground">{t("tasks.colDeps")}</span>
          <div className="text-xs">
            <Deps task={task} onChanged={onChanged} />
          </div>
          <span className="text-xs font-medium text-muted-foreground">{t("tasks.colOwner")}</span>
          <div className="text-xs">
            <Owner task={task} />
          </div>
        </section>
        {hub ? <TaskModelChips key={task.id} task={task} requests={requests} /> : null}
        {/* A task the hub drives through the project's gates (roadmap 34b). */}
        {hub ? <FlowList project={task.project} taskId={task.id} /> : null}
        {hub ? <FlowTaskPanel project={task.project} taskId={task.id} /> : null}
        {hub ? <AgentAssignment tasks={[task]} onChanged={onChanged} /> : null}
        {hub && allow(task.project, "runDispatch") && task.status !== "done" ? <DispatchForm task={task} requests={requests} onSent={onChanged} /> : null}
        {hub && allow(task.project, "runDispatch") && task.status !== "done" ? (
          <div>
            <Button size="sm" variant="outline" className="max-md:min-h-11" onClick={onRoles} data-roles-detail>
              <ListOrdered aria-hidden="true" />
              {t("tasks.rolesDetail")}
            </Button>
          </div>
        ) : null}
        {hub ? <TaskRunChain key={`${task.project}/${task.id}`} project={task.project} taskId={task.id} /> : null}
        {hub && requests.length ? <RequestList requests={requests} onChanged={onChanged} /> : null}
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">{t("tasks.colNote")}</h3>
          {task.note ? (
            <div className="rounded-md border bg-muted/40 p-3 text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere"><ArtifactText text={task.note} /></div>
          ) : (
            <p className="text-xs text-muted-foreground">{t("tasks.noNote")}</p>
          )}
        </section>
        <NoteHistory task={task} />
      </TabsContent></Tabs>
    </SheetContent>
    </ArtifactContext.Provider>
  );
}

/** Kind, size and risk (roadmap 54b): a select each for whoever manages the project's tasks, words for the rest. */
function TaskClassFields({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const { client } = useHive();
  const t = useT();
  const allow = useCan();
  const action = useAction();
  const edit = allow(task.project, "taskManage");
  const valueText = (field: ClassField, value: string | null | undefined) =>
    value ? t(`taskClass.${field}Values.${value}` as Parameters<typeof t>[0]) : t("taskClass.unknown");
  const source = classSource(task);
  return (
    <>
      {CLASS_FIELDS.map((field) => {
        const label = t(`taskClass.${field}`);
        const value = task[field] ?? null;
        return (
          <Fragment key={field}>
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            <div className="max-w-48" data-task-class={field}>
              {edit ? (
                <NativeSelect
                  size="sm"
                  className="w-full"
                  value={value ?? ""}
                  aria-label={t("taskClass.fieldOf", { field: label, id: task.id })}
                  disabled={action.busy}
                  onChange={(e) =>
                    void action.run(async () => {
                      await client.call("tasks.classify", classInput(task.id, field, e.target.value));
                      onChanged();
                    })
                  }
                >
                  {value === null ? (
                    <NativeSelectOption value="" disabled>
                      {t("taskClass.unknown")}
                    </NativeSelectOption>
                  ) : null}
                  {CLASS_VALUES[field].map((v) => (
                    <NativeSelectOption key={v} value={v}>
                      {valueText(field, v)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : (
                <span className={cn("text-sm", value === null && "text-muted-foreground")}>{valueText(field, value)}</span>
              )}
            </div>
          </Fragment>
        );
      })}
      {source || action.error ? (
        <>
          <span />
          <div className="flex flex-col gap-1">
            {source ? (
              <span className="text-xs text-muted-foreground">
                {t("taskClass.by", {
                  by: source.by === "rule" ? t("taskClass.byRule") : source.by === "ai" ? t("taskClass.byAi") : source.name,
                  time: formatTime(source.at),
                })}
              </span>
            ) : null}
            <ErrorNote error={action.error} />
          </div>
        </>
      ) : null}
    </>
  );
}

/** The handovers kept beside the latest (roadmap 41a): each one as it was written, and what it changed. */
function NoteHistory({ task }: { task: Task }) {
  const artifacts = useContext(ArtifactContext);
  const { client } = useHive();
  const t = useT();
  // A note is written with a status change, so the task's updatedAt is enough to know the history may have grown.
  // An older hub (or a machine's own database) that does not know the method shows no history rather than an error.
  const notes = useQuery(() => client.call("tasks.notes", { id: task.id, limit: 20 }).catch(() => [] as TaskNote[]), [client, task.id, task.updatedAt]);
  const [diffOf, setDiffOf] = useState<number | null>(null);
  const list = notes.data ?? [];
  if (!list.length) return null;
  return (
    <section className="flex flex-col gap-2" data-task-notes>
      <h3 className="text-xs font-medium text-muted-foreground">{t("tasks.noteHistory")}</h3>
      <ul className="flex flex-col gap-2">
        {list.map((n, i) => {
          // Newest first, so the one before it is the next in the list; the oldest has nothing to compare with.
          const before = list[i + 1] ?? null;
          const open = diffOf === n.version;
          return (
            <li key={n.version} className="flex flex-col gap-1 rounded-md border p-2 text-xs" data-task-note={n.version}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-muted-foreground">v{n.version}</span>
                <Badge tone={STATUS_TONE[n.status]}>{t(`taskStatus.${n.status}`)}</Badge>
                <span className="text-muted-foreground">
                  {t("tasks.noteBy", { who: n.onBehalf ? `${n.author} (${n.onBehalf})` : n.author, time: formatTime(n.createdAt) })}
                </span>
              </div>
              <div className="max-h-40 overflow-y-auto leading-relaxed whitespace-pre-wrap wrap-anywhere"><ArtifactText text={n.note} files={n.source?.run ? artifacts.filter((a) => a.runId === n.source!.run && (!n.source!.machine || !a.source?.machine || a.source.machine === n.source!.machine)) : artifacts} /></div>
              {before ? (
                <div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-1.5 text-xs"
                    aria-pressed={open}
                    onClick={() => setDiffOf(open ? null : n.version)}
                  >
                    {open ? t("tasks.noteHideDiff") : t("tasks.noteDiff", { version: before.version })}
                  </Button>
                </div>
              ) : null}
              {before && open ? (
                <div data-task-note-diff={n.version}>
                  <Diff before={before.note} after={n.note} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Machines that can take this task's run now: online, taking runs from the hub, with the project's repo. */

function DispatchForm({ task, requests, onSent }: { task: Task; requests: RunRequest[]; onSent: () => void }) {
  const { client } = useHive();
  const t = useT();
  const machines = useQuery(() => client.call("machines.list", {}), [client]);
  const fit = (machines.data ?? []).filter((m) => takesRunsOf(m, task.project));
  const [machineId, setMachineId] = useState("");
  const machine = fit.find((m) => m.id === machineId) ?? null;
  const [role, setRole] = useState<WorkRole>(task.status === "review" ? "review" : "implement");
  const [profileId, setProfileId] = useState("");
  const [preferKind, setPreferKind] = useState<PreferKind | "">("");
  const [instructions, setInstructions] = useState("");
  const [reviewAfter, setReviewAfter] = useState(true);
  const [candidates, setCandidates] = useState(1);
  const action = useAction();
  const timeoutSettings = useQuery(() => client.call("runs.timeoutSettings", {}), [client]);
  const [timeout, setTimeout] = useState("");
  const settings = timeoutSettings.data ?? DEFAULT_RUN_TIMEOUT;
  const profiles = (machine ? [machine] : fit).flatMap((m) => m.profiles).filter((p) => p.enabled && p.installed && (!profileId || p.id === profileId));
  const ceiling = Math.min(settings.maxMinutes, profiles.length ? Math.max(...profiles.map((p) => p.timeoutMinutes ?? 60)) : 60);
  const automaticTimes = new Set(profiles.map((p) => runTimeoutMinutes(settings, p.timeoutMinutes ?? 60, task.kind, task.id)));
  const defaultMinutes = automaticTimes.size === 1 ? [...automaticTimes][0]! : null;
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
      {fit.length > 0 && !waiting.length && !pending ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await client.call("runs.dispatch", {
                machineId: machine?.id ?? null,
                project: task.project,
                taskId: task.id,
                role,
                profileId: profileId || null,
                preferKind: (!profileId && preferKind) || null,
                reviewAfter: role !== "review" && reviewAfter,
                candidates: several ? candidates : 1,
                timeoutMinutes: timeout ? Number(timeout) : null,
                instructions,
              });
              setInstructions("");
              onSent();
            });
          }}
        >
          <div className="flex flex-col gap-1.5">
            <MachineSelect id={`machine-${task.id}`} machines={fit} value={machineId} any onChange={(id) => (setMachineId(id), setProfileId(""))} />
          </div>
          <details className="rounded-md border border-line-default p-3">
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium focus-visible:focus-ring md:min-h-0">{t("tasks.dispatchOptions")}</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`role-${task.id}`}>{t("board.role")}</Label>
              <NativeSelect id={`role-${task.id}`} size="sm" className="w-full max-md:h-11 max-md:text-base" value={role} onChange={(e) => setRole(e.target.value as WorkRole)}>
                {WORK_ROLES.map((r) => (
                  <NativeSelectOption key={r} value={r}>
                    {t(`agentRole.${r}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <ProfileSelect id={`profile-${task.id}`} machine={machine} value={profileId} onChange={setProfileId} />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`timeout-${task.id}`}>{t("runTimeout.duration")}</Label>
              <Input id={`timeout-${task.id}`} data-dispatch-timeout type="number" min={1} max={ceiling} step={1} value={timeout} placeholder={defaultMinutes == null ? t("runTimeout.profile") : t("runTimeout.automatic", { minutes: defaultMinutes })} className="max-md:h-11 max-md:text-base" onChange={(e) => setTimeout(e.target.value)} aria-describedby={`timeout-hint-${task.id}`} />
              <p id={`timeout-hint-${task.id}`} className="text-xs text-muted-foreground">{t("runTimeout.hint")}</p>
            </div>
            {!profileId ? <PreferKindSelect id={`prefer-${task.id}`} machine={machine} value={preferKind} onChange={setPreferKind} /> : null}
            {several ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`candidates-${task.id}`}>{t("board.candidates")}</Label>
                <NativeSelect
                  id={`candidates-${task.id}`}
                  size="sm"
                  className="w-full max-md:h-11 max-md:text-base"
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
            <Label className="mt-3" htmlFor={`instructions-${task.id}`}>{t("board.instructions")}</Label>
            <Textarea
              id={`instructions-${task.id}`}
              placeholder={t("board.instructionsPlaceholder")}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              aria-label={t("board.instructions")}
              className="mt-3 max-md:text-base"
            />
            {role !== "review" ? (
              <label className="mt-3 flex items-center gap-2 text-sm max-md:min-h-11">
                <Checkbox checked={reviewAfter} onCheckedChange={(v) => setReviewAfter(v === true)} />
                {t("board.reviewAfter")}
              </label>
            ) : null}
          </details>
          <div>
            <Button size="sm" type="submit" disabled={action.busy} className="max-md:min-h-11">
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
