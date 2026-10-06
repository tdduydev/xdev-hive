import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, useReactFlow, ReactFlowProvider, type NodeProps, type Node, type NodeChange, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import type { Machine, ProjectSummary, QuotaCooldown, RunRequest, SdlcFlowTask, SdlcGateRecord, Task, TaskAgentQueueItem } from "@xdev-hive/core";
import { Badge, ErrorNote, STATUS_TONE } from "#ui/components/common.tsx";
import { useAction, useCan, useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT, type MessageKey } from "#ui/i18n/index.tsx";
import { useIsMobile } from "#ui/lib/hooks/use-mobile.ts";
import { agentGraph, layoutGraph, sdlcGraph, systemGraph, taskGraph, readPositions, writePositions, clearPositions, type AgentGraphNode, type GraphNode, type Point, type SdlcGraphNode, type SystemGraphNode } from "#ui/lib/graph.ts";
import { featureHref, mayDecide, noteRequired } from "#ui/lib/features.ts";
import { profileCard } from "#ui/lib/agentmap.ts";
import { scopeFilter, scopeKey } from "#ui/lib/scope.ts";
import { ownerLabel } from "#ui/lib/tasks.ts";
import "./Graph.css";

type TaskData = Record<string, unknown> & { graph: GraphNode; running: boolean; open: (task: Task) => void };
// A queued run is already the agent's: the dot tells the viewer not to hand the task to someone else.
const OPEN_RUN = new Set(["queued", "running"]);
// Above 1 a two-node project fills the screen with oversized cards.
const FIT = { padding: 0.15, maxZoom: 1, duration: 0 };
// Every poll builds new node objects. Without `measured` React Flow drops the handle positions it measured and waits for a
// ResizeObserver callback that, for a card whose size never changes, can be missed: the edge then stays gone. Giving
// the size and the handles up front (base.css draws a 6px handle centred on the side) lets edges be drawn from data.
const HANDLE = 6;
function fixedSize(width: number, height: number, sides: ("target" | "source")[] = ["target", "source"]) {
  return {
    measured: { width, height },
    handles: sides.map((type) => ({ type, position: type === "target" ? Position.Left : Position.Right, x: (type === "target" ? 0 : width) - HANDLE / 2, y: height / 2 - HANDLE / 2, width: HANDLE, height: HANDLE })),
  };
}

function TaskNode({ data }: NodeProps<Node<TaskData>>) {
  const { graph, running, open } = data;
  const t = useT();
  if (graph.kind === "group") return <div className="graph-group-title">specs/{graph.label}</div>;
  if (graph.kind === "count") return <div className="graph-count" role="img" aria-label={`+${graph.count} ${t("graph.completed")}`}>+{graph.count} {t("graph.completed")}</div>;
  const task = graph.task;
  const foreign = graph.kind === "foreign";
  // Another project's task is not in this scope's list, so its panel cannot open from here.
  const openable = !!task && !graph.project;
  const status = task ? t(`taskStatus.${task.status}`) : "";
  const label = [task?.id ?? graph.id.split(":").at(-1), foreign ? graph.project : null, graph.label, status, running ? t("graph.running") : null].filter(Boolean).join(", ");
  return <>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    {/* The card is its own button and the drag uses a separate handle, so React Flow's drag never swallows the click. */}
    <button type="button" className={`nodrag graph-task graph-${task?.status ?? "todo"}${foreign ? " graph-foreign" : ""}`} aria-label={label} disabled={!openable} onClick={() => openable && open(task)} data-graph-task={task?.id ?? graph.id}>
      <span className="graph-task-top"><span>{task?.id ?? graph.id.split(":").at(-1)}</span>{running ? <span className="graph-running" title={t("graph.running")} /> : null}</span>
      <span className="graph-task-title">{graph.label}</span>
      <span className="graph-task-meta">{foreign ? <span>{graph.project}</span> : null}{task ? <Badge tone={STATUS_TONE[task.status]}>{status}</Badge> : null}{task?.owner ? <span className="graph-agent">{ownerLabel(task.owner).who}</span> : null}</span>
    </button>
    <span className="graph-drag-handle" aria-hidden="true">⋮⋮</span>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </>;
}
const nodeTypes = { task: TaskNode, group: TaskNode };

type AgentData = Record<string, unknown> & { graph: AgentGraphNode; cooldowns: QuotaCooldown[]; requests: RunRequest[]; tasks: Task[]; assign: (task: Task, machine: Machine, profileId: string | null) => void; canAssign: (task: Task, machine: Machine) => boolean; mayAssign: boolean; open: (task: Task) => void; pick: (task: Task) => void; phone: boolean; any: string };
function AgentNode({ data }: NodeProps<Node<AgentData>>) {
  const { graph, cooldowns, requests, tasks, assign, canAssign, open, any } = data;
  const t = useT();
  const machine = graph.machine!;
  if (graph.kind === "machine") return <div className="graph-machine" data-graph-machine={machine.id}><span className={machine.online ? "graph-running" : "graph-offline"} />{machine.machine}<small>{machine.online ? t("graph.online") : t("graph.offline")}</small><Handle type="source" position={Position.Right} isConnectable={false} /></div>;
  if (graph.kind === "profile") {
    const profile = machine.profiles.find((p) => p.id === graph.profileId);
    const card = profile ? profileCard(machine, profile, cooldowns, Date.now()) : null;
    const state = card?.state ?? (machine.online ? "ready" : "offline");
    const pending = requests.filter((request) => request.machineId === machine.id && request.status === "pending" && (!profile || !request.profileId || request.profileId === profile.id)).length;
    const places = card ? card.max - card.running - pending : machine.profiles.reduce((n, p) => n + (p.maxConcurrent ?? 1), 0) - machine.runs.length - pending;
    const target = graph.profileId ?? "any";
    return <div className="graph-profile" data-graph-profile={`${machine.id}:${target}`} data-graph-state={state} onDragOver={(e) => { if (e.dataTransfer.types.includes("application/x-hive-task")) e.preventDefault(); }} onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("application/x-hive-task"); const task = tasks.find((item) => `${item.project}:${item.id}` === id); if (task && canAssign(task, machine)) assign(task, machine, graph.profileId ?? null); }}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <strong>{profile?.label ?? any}</strong><span className="graph-profile-state">{t(`graph.state.${state}`)}</span>
      <span>{t("graph.quota", { session: profile?.sessionPercent == null ? "—" : `${Math.round(profile.sessionPercent)}%`, week: profile?.weekPercent == null ? "—" : `${Math.round(profile.weekPercent)}%` })}</span>
      <span>{t("graph.places", { count: Math.max(0, places) })}</span>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>;
  }
  const task = graph.task!;
  return <><Handle type="target" position={Position.Left} isConnectable={false} /><button type="button" className={`nodrag graph-task graph-${task.status}`} data-graph-agent-task={task.id} aria-label={`${task.id}, ${task.title}, ${t(`taskStatus.${task.status}`)}`} onClick={() => data.phone && data.mayAssign ? data.pick(task) : open(task)}><span className="graph-task-top">{task.id}{graph.run ? <span className="graph-running" title={t("graph.running")} /> : null}</span><span className="graph-task-title">{task.title}</span><span className="graph-task-meta"><Badge tone={STATUS_TONE[task.status]}>{t(`taskStatus.${task.status}`)}</Badge></span></button>{data.phone || !data.mayAssign ? null : <span className="graph-drag-handle" aria-hidden="true">⋮⋮</span>}<Handle type="source" position={Position.Right} isConnectable={false} /></>;
}
/** The right a gate asks for, as Features names it to whoever lacks it. */
const gateRight = (gate: Pick<SdlcGateRecord, "gate">): "codeReview" | "taskManage" | "runDispatch" => (gate.gate === "review" || gate.gate === "merge" ? "codeReview" : gate.gate === "tasks" ? "taskManage" : "runDispatch");
// Fix and merge gates do not send work back the way the others do, so their buttons keep the words the task panel uses.
const passLabel = (gate: SdlcGateRecord): MessageKey => (gate.gate === "fix" ? "flow.taskPass.fix" : gate.gate === "merge" ? "flow.taskPass.merge" : "graph.pass");
const changesLabel = (gate: SdlcGateRecord): MessageKey => (gate.gate === "fix" ? "flow.taskChanges.fix" : gate.gate === "merge" ? "flow.taskChanges.merge" : "graph.changes");

type SdlcData = Record<string, unknown> & { graph: SdlcGraphNode; may: (gate: SdlcGateRecord) => boolean; decide: (gate: SdlcGateRecord, decision: "pass" | "changes") => void; busy: boolean };
function SdlcNode({ data }: NodeProps<Node<SdlcData>>) {
  const { graph, may, decide, busy } = data;
  const t = useT();
  const flow = graph.flow;
  const href = featureHref({ project: flow.project, flow, spec: null });
  if (graph.kind === "flow") {
    return <>
      <a className="nodrag graph-task graph-flow" href={href} data-graph-flow={flow.taskId} aria-label={`${t("flow.title", { task: flow.taskId })}, ${flow.project}, ${t(`flow.state.${flow.state}`, { step: t(`flow.step.${flow.step}`), gate: flow.gate ? t(`sdlc.gate.${flow.gate.gate}`) : "" })}`}>
        <span className="graph-task-top"><span>{flow.taskId}</span></span>
        <span className="graph-task-title">{flow.dir ? `specs/${flow.dir}` : flow.taskId}</span>
        <span className="graph-task-meta"><span>{flow.project}</span><span>{flow.machine}</span></span>
      </a>
      <span className="graph-drag-handle" aria-hidden="true">⋮⋮</span>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>;
  }
  const step = graph.step!;
  const gate = graph.gates[0];
  const state = t(`graph.stepState.${graph.state}`);
  // Who the gate waits for: a person with the right the hub checks, named the way Features names it.
  const who = gate ? t("graph.needs", { right: t(`features.right.${gateRight(gate)}`) }) : null;
  const other = gate && gate.taskId !== flow.taskId ? gate.taskId : null;
  const label = [flow.taskId, t(`graph.step.${step}`), state, other, who].filter(Boolean).join(", ");
  return <>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <div className={`graph-step graph-step-${graph.state}`} data-graph-step={`${flow.taskId}:${step}`} data-graph-step-state={graph.state}>
      <a className="nodrag graph-step-open" href={href} aria-label={label}>
        <strong>{t(`graph.step.${step}`)}</strong>
        <span className="graph-step-state">{state}{other ? ` · ${other}` : ""}{graph.gates.length > 1 ? ` · ${t("graph.moreGates", { count: graph.gates.length - 1 })}` : ""}</span>
        {who ? <span className="graph-step-who">{who}</span> : step === "review" || step === "merge" ? <span className="graph-step-who">{t("graph.flowTasks", { count: graph.tasks.length })}</span> : null}
      </a>
      {gate && may(gate) ? <span className="nodrag graph-step-actions">
        <button type="button" disabled={busy} data-graph-pass={gate.id} onClick={() => decide(gate, "pass")}>{t(passLabel(gate))}</button>
        <button type="button" disabled={busy} data-graph-changes={gate.id} onClick={() => decide(gate, "changes")}>{t(changesLabel(gate))}</button>
      </span> : null}
    </div>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </>;
}

type SystemData = Record<string, unknown> & { graph: SystemGraphNode; open: (project: string) => void };
function SystemNode({ data }: NodeProps<Node<SystemData>>) {
  const { graph, open } = data;
  const t = useT();
  const counts = t("graph.tasksOpen", { open: graph.open, total: graph.total });
  const runs = t("graph.runs", { count: graph.runs });
  const agents = graph.agents.length ? t("graph.agents", { names: graph.agents.join(", ") }) : t("graph.noAgent");
  return <>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <button type="button" className="nodrag graph-service" data-graph-service={graph.project} aria-label={`${graph.project}, ${counts}, ${runs}, ${agents}`} onClick={() => open(graph.project)}>
      <span className="graph-service-name">{graph.runs ? <span className="graph-running" title={t("graph.running")} /> : null}{graph.project}</span>
      <span>{counts}</span>
      <span>{runs}</span>
      <span className="graph-service-agents">{agents}</span>
    </button>
    <span className="graph-drag-handle" aria-hidden="true">⋮⋮</span>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </>;
}
const allNodeTypes = { ...nodeTypes, machine: AgentNode, profile: AgentNode, agentTask: AgentNode, flow: SdlcNode, step: SdlcNode, service: SystemNode };
type Layer = "task" | "agent" | "sdlc" | "system";

function GraphBody() {
  const { client, scope, me, projects, setScope } = useHive();
  const t = useT();
  const allow = useCan();
  const action = useAction();
  const phone = useIsMobile();
  const reactFlow = useReactFlow();
  const scopeId = scopeKey(scope);
  const [chosen, setLayer] = useState<Layer>("task");
  // All projects shows only the system layer (spec 51, Phạm vi); one project has no other service to compare with.
  const layer: Layer = scope.kind === "all" ? "system" : chosen === "system" && scope.kind !== "system" ? "task" : chosen;
  const [asking, setAsking] = useState<SdlcGateRecord | null>(null);
  const [changeNote, setChangeNote] = useState("");
  const storageKey = `xdev-hive.graph.${layer}.${scopeId}`;
  const [oldDone, setOldDone] = useState(true);
  const [openOnly, setOpenOnly] = useState<boolean | null>(null);
  const [mine, setMine] = useState(false);
  const [agent, setAgent] = useState("");
  const [picked, setPicked] = useState<Task | null>(null);
  const [target, setTarget] = useState("");
  // Positions of nodes already on the canvas: dragged ones (saved) and laid-out ones (this visit only), so a refresh
  // only lays out nodes that are new.
  const placed = useRef<Record<string, Point>>(readPositions(storageKey));
  const fitted = useRef("");
  const [saved, setSaved] = useState(0);
  const [dragging, setDragging] = useState<Record<string, Point>>({});
  const poll = usePoll(5000);
  const scopeArgs = scopeFilter(scope);
  const tasks = useQuery(() => client.call("tasks.list", scopeArgs), [client, scopeId, poll]);
  const flows = useQuery(() => client.call("sdlc.flows", { ...scopeArgs, limit: 200 }).catch(() => []), [client, scopeId, poll]);
  const runs = useQuery(() => client.call("runs.list", { ...scopeArgs, limit: 200 }).catch(() => []), [client, scopeId, poll]);
  const machines = useQuery(() => client.call("machines.list", {}), [client, poll]);
  const cooldowns = useQuery(() => client.call("cooldowns.list", {}).catch(() => []), [client, poll]);
  const requests = useQuery(() => client.call("runs.requests", { limit: 200 }).catch(() => []), [client, poll]);
  // Only the layer on screen asks for what it alone draws.
  const flowTasks = useQuery<SdlcFlowTask[]>(() => layer === "sdlc" ? client.call("sdlc.flowTasks", scopeArgs).catch(() => []) : Promise.resolve([]), [client, scopeId, poll, layer]);
  const history = useQuery<SdlcGateRecord[]>(() => layer === "sdlc" ? client.call("sdlc.gates", { ...scopeArgs, limit: 200 }).catch(() => []) : Promise.resolve([]), [client, scopeId, poll, layer]);
  const summaries = useQuery<ProjectSummary[]>(() => layer === "system" ? client.call("projects.list", {}).catch(() => []) : Promise.resolve([]), [client, poll, layer]);
  const queues = useQuery(async () => Object.fromEntries(await Promise.all((machines.data ?? []).map(async (m) => [m.id, await client.call("tasks.agentQueue", { machineId: m.id })] as const))) as Record<string, TaskAgentQueueItem[]>, [client, machines.data, poll]);
  useEffect(() => { placed.current = readPositions(storageKey); setDragging({}); setSaved((n) => n + 1); }, [storageKey]);
  // A phone shows only what is still open by default (spec 51, Mobile); the person can turn it off.
  const onlyOpen = openOnly ?? phone;
  const all = tasks.data ?? [];
  const agents = useMemo(() => [...new Set(all.map((task) => task.owner ? ownerLabel(task.owner).who : "").filter(Boolean))].sort(), [all]);
  const filtered = useMemo(() => all.filter((task) => (!onlyOpen || task.status !== "done") && (!mine || !!me.user && !!task.owner && ownerLabel(task.owner).who === me.user.username) && (!agent || !!task.owner && ownerLabel(task.owner).who === agent)), [all, onlyOpen, mine, me.user, agent]);
  // Laying out before the flows arrive would fix loose positions for tasks that then move into a spec group, where
  // the same coordinates are read relative to the group: which query answered first decided the picture.
  const taskReady = !!tasks.data && !!flows.data;
  // A system's services, or every project in use: archived ones would only add empty nodes.
  const serviceNames = useMemo(() => scope.kind === "system" ? scope.projects : summaries.data?.length ? summaries.data.filter((s) => !s.state).map((s) => s.project) : projects, [scope, summaries.data, projects]);
  const graph = useMemo(() => {
    if (layer === "task" && !taskReady) return { nodes: [], edges: [] };
    const laid = layer === "task" ? layoutGraph(taskGraph(filtered, flows.data ?? [], oldDone), placed.current)
      : layer === "agent" ? agentGraph((machines.data ?? []).filter((m) => scope.kind !== "project" || m.projects.includes(scope.project)), queues.data ?? {}, all, placed.current)
      : layer === "sdlc" ? sdlcGraph(flows.data ?? [], flowTasks.data ?? [], history.data ?? [], placed.current)
      : systemGraph(serviceNames, summaries.data ?? [], all, machines.data ?? [], placed.current);
    for (const node of laid.nodes) placed.current[node.id] ??= node.position;
    return laid;
  // `saved` re-runs the layout after a reset or a scope change; a drag alone never does.
  }, [layer, taskReady, filtered, flows.data, flowTasks.data, history.data, summaries.data, serviceNames, oldDone, machines.data, queues.data, all, scope, saved]);
  const running = useMemo(() => new Set((runs.data ?? []).filter((run) => OPEN_RUN.has(run.status) && run.taskId).map((run) => `${run.project}:${run.taskId}`)), [runs.data]);
  const openTask = useCallback((task: Task) => { window.location.hash = `#/tasks?task=${encodeURIComponent(task.id)}`; }, []);
  const taskNodes: Node<TaskData>[] = useMemo(() => layer === "task" ? (graph as ReturnType<typeof taskGraph>).nodes.map((node) => ({
    id: node.id, type: node.kind === "group" ? "group" : "task", position: dragging[node.id] ?? node.position, width: node.width, height: node.height, parentId: node.parentId,
    dragHandle: ".graph-drag-handle", draggable: node.kind !== "count" && node.kind !== "group", selectable: false, style: { width: node.width, height: node.height },
    ...fixedSize(node.width, node.height, node.kind === "count" || node.kind === "group" ? [] : undefined),
    data: { graph: node, running: running.has(node.id), open: openTask },
  })) : [], [layer, graph, dragging, running, openTask]);
  const canAssign = useCallback((task: Task, machine: Machine) => task.status !== "done" && allow(task.project, "runDispatch") && machine.acceptsRuns && machine.projects.includes(task.project), [allow]);
  const assign = useCallback((task: Task, machine: Machine, profileId: string | null) => void action.run(async () => {
    if (!canAssign(task, machine)) return;
    await client.call("tasks.assign", { id: task.id, machineId: machine.id, profileId });
    setPicked(null); setTarget(""); fitted.current = ""; tasks.reload(); queues.reload(); machines.reload();
  }), [action, canAssign, client, tasks, queues, machines]);
  const agentNodes: Node<AgentData>[] = useMemo(() => layer === "agent" ? (graph as ReturnType<typeof agentGraph>).nodes.map((node) => ({
    id: node.id, type: node.kind, position: dragging[node.id] ?? node.position, width: node.width, height: node.height, draggable: node.kind === "agentTask" && !phone && !!node.task && allow(node.task.project, "runDispatch"), dragHandle: ".graph-drag-handle", selectable: false, style: { width: node.width, height: node.height },
    ...fixedSize(node.width, node.height, node.kind === "machine" ? ["source"] : undefined),
    data: { graph: node, cooldowns: cooldowns.data ?? [], requests: requests.data ?? [], tasks: all, assign, canAssign, mayAssign: !!node.task && allow(node.task.project, "runDispatch"), open: openTask, pick: setPicked, phone, any: t("assignment.any") },
  })) : [], [layer, graph, dragging, cooldowns.data, requests.data, all, assign, canAssign, allow, openTask, phone, t]);
  const decide = useCallback((gate: SdlcGateRecord, decision: "pass" | "changes", note = "") => {
    // Changes at a Spec Kit gate re-run the step from the person's note, so the note is asked for before sending.
    if (decision === "changes" && noteRequired(gate) && !note.trim()) { setAsking(gate); setChangeNote(""); return; }
    void action.run(async () => {
      await client.call("sdlc.decide", { gateId: gate.id, decision, note });
      setAsking(null); setChangeNote(""); flows.reload(); flowTasks.reload(); history.reload();
    });
  }, [action, client, flows, flowTasks, history]);
  const may = useCallback((gate: SdlcGateRecord) => mayDecide(allow, gate), [allow]);
  const sdlcNodes: Node<SdlcData>[] = useMemo(() => layer === "sdlc" ? (graph as ReturnType<typeof sdlcGraph>).nodes.map((node) => ({
    id: node.id, type: node.kind, position: dragging[node.id] ?? node.position, width: node.width, height: node.height, draggable: node.kind === "flow", dragHandle: ".graph-drag-handle", selectable: false, style: { width: node.width, height: node.height },
    data: { graph: node, may, decide, busy: action.busy },
  })) : [], [layer, graph, dragging, may, decide, action.busy]);
  const openProject = useCallback((project: string) => { setScope({ kind: "project", project }); setLayer("task"); }, [setScope]);
  const systemNodes: Node<SystemData>[] = useMemo(() => layer === "system" ? (graph as ReturnType<typeof systemGraph>).nodes.map((node) => ({
    id: node.id, type: "service", position: dragging[node.id] ?? node.position, width: node.width, height: node.height, dragHandle: ".graph-drag-handle", selectable: false, style: { width: node.width, height: node.height },
    data: { graph: node, open: openProject },
  })) : [], [layer, graph, dragging, openProject]);
  const nodes = layer === "task" ? taskNodes : layer === "agent" ? agentNodes : layer === "sdlc" ? sdlcNodes : systemNodes;
  useEffect(() => {
    const key = `${scopeId}:${layer}`;
    // onlyRenderVisibleElements leaves a node outside the view (and its edges) out of the page, so fitting matters.
    // React Flow's fitView prop fits only its first render; the canvas stays mounted across layers and scopes, so each
    // one fits once when its nodes arrive, and a later refresh leaves the viewport where the person put it.
    if ((layer === "task" && !taskReady) || (layer === "agent" && !queues.data) || !nodes.length || fitted.current === key) return;
    fitted.current = key;
    requestAnimationFrame(() => void reactFlow.fitView(FIT));
  }, [nodes.length, layer, taskReady, queues.data, reactFlow, scopeId]);
  const edges: Edge[] = useMemo(() => {
    if (layer === "task") return (graph as ReturnType<typeof taskGraph>).edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: "smoothstep", className: edge.complete ? "graph-edge-complete" : "graph-edge-open" }));
    // A step not reached yet holds nothing back, so it gets the plain line, not the warning colour of an open dependency.
    if (layer === "sdlc") return (graph as ReturnType<typeof sdlcGraph>).edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: "smoothstep", className: edge.complete ? "graph-edge-complete" : "graph-edge-agent" }));
    if (layer === "system") return (graph as ReturnType<typeof systemGraph>).edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: "smoothstep", label: String(edge.open), ariaLabel: t("graph.openDeps", { count: edge.open }), className: edge.open ? "graph-edge-open" : "graph-edge-complete" }));
    return (graph as ReturnType<typeof agentGraph>).edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: "smoothstep", className: edge.running ? "graph-edge-running" : "graph-edge-agent" }));
  }, [layer, graph, t]);
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const moved = changes.filter((change): change is Extract<NodeChange, { type: "position" }> => change.type === "position" && !!change.position);
    if (moved.length) setDragging((old) => ({ ...old, ...Object.fromEntries(moved.map((change) => [change.id, change.position!])) }));
  }, []);
  const onDragStop = useCallback((_: unknown, node: Node) => {
    if (layer === "agent" && node.type === "agentTask") {
      const task = (node.data as AgentData).graph.task;
      const centre = { x: node.position.x + (node.width ?? 228) / 2, y: node.position.y + (node.height ?? 94) / 2 };
      const hit = reactFlow.getNodes().find((candidate) => candidate.type === "profile" && centre.x >= candidate.position.x && centre.x <= candidate.position.x + (candidate.width ?? 236) && centre.y >= candidate.position.y && centre.y <= candidate.position.y + (candidate.height ?? 116));
      const destination = hit && (hit.data as AgentData).graph;
      if (task && destination?.machine && canAssign(task, destination.machine)) { assign(task, destination.machine, destination.profileId ?? null); setDragging({}); return; }
    }
    placed.current[node.id] = node.position;
    const stored = { ...readPositions(storageKey), [node.id]: node.position };
    writePositions(storageKey, stored);
  }, [storageKey, layer, reactFlow, canAssign, assign]);
  const reset = () => {
    clearPositions(storageKey);
    placed.current = {};
    setDragging({});
    setSaved((n) => n + 1);
    requestAnimationFrame(() => void reactFlow.fitView(FIT));
  };
  if (scope.kind === "shared") return <div className="graph-pick"><p>{t("graph.pickProject")}</p><div>{projects.map((project) => <button key={project} type="button" onClick={() => setScope({ kind: "project", project })}>{project}</button>)}</div></div>;
  return <div className="graph-page">
    <div className="graph-toolbar">
      <div className="graph-layers" role="group" aria-label={t("graph.layers")}>
        {([["task", "Task"], ["agent", "Agent"], ["sdlc", "SDLC"], ["system", t("graph.system")]] as const).map(([id, name]) => {
          const off = scope.kind === "all" ? id !== "system" : id === "system" && scope.kind !== "system";
          return <button type="button" key={id} aria-pressed={layer === id} data-graph-layer={id} disabled={off} title={off ? t(scope.kind === "all" ? "graph.pickProject" : "graph.systemHint") : undefined} onClick={() => setLayer(id)}>{name}</button>;
        })}
      </div>
      <div className="graph-tools">
        {layer === "task" ? <div className="graph-filters">
          <label><input type="checkbox" checked={oldDone} onChange={(e) => setOldDone(e.target.checked)} />{t("graph.hideOldDone")}</label>
          <label><input type="checkbox" checked={onlyOpen} onChange={(e) => setOpenOnly(e.target.checked)} />{t("graph.openOnly")}</label>
          <label><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} disabled={!me.user} />{t("graph.mine")}</label>
          <select aria-label={t("graph.byAgent")} value={agent} onChange={(e) => setAgent(e.target.value)}><option value="">{t("graph.allAgents")}</option>{agents.map((name) => <option key={name}>{name}</option>)}</select>
        </div> : null}
        <div className="graph-actions">
          <button type="button" onClick={() => void reactFlow.fitView(FIT)}>{t("graph.fit")}</button>
          <button type="button" onClick={reset}>{t("graph.reset")}</button>
          <a href="#/tasks">{t("graph.list")}</a>
        </div>
      </div>
    </div>
    <ErrorNote error={tasks.error} />
    <ErrorNote error={layer === "agent" ? machines.error ?? queues.error ?? action.error : layer === "sdlc" ? flows.error ?? action.error : null} />
    {scope.kind === "all" ? <p className="graph-hint">{t("graph.allHint")}</p> : null}
    {layer === "sdlc" && flows.data && !flows.data.length ? <p className="graph-hint">{t("graph.noFlows")}</p> : null}
    <div className="graph-workspace">
    {layer === "agent" ? <aside className="graph-unassigned" aria-label={t("graph.unassigned")}><h2>{t("graph.unassigned")}</h2><p>{phone ? t("graph.tapHint") : t("graph.dragHint")}</p><div className="graph-unassigned-list">{all.filter((task) => !task.agent && task.status !== "done").map((task) => <button key={`${task.project}:${task.id}`} type="button" draggable={!phone && allow(task.project, "runDispatch")} data-graph-unassigned={task.id} onDragStart={(e) => e.dataTransfer.setData("application/x-hive-task", `${task.project}:${task.id}`)} onClick={() => allow(task.project, "runDispatch") ? setPicked(task) : openTask(task)}><strong>{task.id}</strong><span>{task.title}</span></button>)}</div></aside> : null}
    <div className="graph-canvas" data-graph-canvas>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={allNodeTypes} onNodesChange={onNodesChange} onNodeDragStop={onDragStop} fitView fitViewOptions={FIT} onlyRenderVisibleElements nodesConnectable={false} elementsSelectable={false} minZoom={0.2} maxZoom={2} attributionPosition="bottom-left" aria-label={t("nav.graph")}>
        <Background color="var(--border-subtle)" gap={20} />
        <Controls showInteractive={false} position={phone ? "bottom-right" : "bottom-left"} />
        {phone ? null : <MiniMap pannable zoomable ariaLabel={t("graph.minimap")} nodeColor="var(--border-strong)" maskColor="color-mix(in srgb, var(--bg-sunken) 70%, transparent)" />}
      </ReactFlow>
    </div>
    </div>
    {asking ? <div className="graph-picker" role="dialog" aria-label={t("graph.changes")} onKeyDown={(e) => { if (e.key === "Escape") setAsking(null); }}><strong>{asking.taskId} · {t(`sdlc.gate.${asking.gate}`)}</strong><label>{t("flow.notePlaceholder")}<textarea autoFocus data-graph-change-note rows={3} maxLength={2000} value={changeNote} onChange={(e) => setChangeNote(e.target.value)} /></label><div><button type="button" onClick={() => setAsking(null)}>{t("graph.cancel")}</button><button type="button" data-graph-send-changes disabled={!changeNote.trim() || action.busy} onClick={() => decide(asking, "changes", changeNote)}>{t("graph.changes")}</button></div></div> : null}
    {picked ? <div className="graph-picker" role="dialog" aria-label={t("graph.chooseAgent")} onKeyDown={(e) => { if (e.key === "Escape") setPicked(null); }}><strong>{picked.id} · {picked.title}</strong><label>{t("graph.chooseAgent")}<select autoFocus data-graph-agent-select value={target} onChange={(e) => setTarget(e.target.value)}><option value="">{t("assignment.choose")}</option>{(machines.data ?? []).filter((machine) => canAssign(picked, machine)).flatMap((machine) => [<option key={`${machine.id}:any`} value={JSON.stringify([machine.id, null])}>{machine.machine} · {t("assignment.any")}</option>, ...machine.profiles.filter((profile) => profile.enabled).map((profile) => <option key={`${machine.id}:${profile.id}`} value={JSON.stringify([machine.id, profile.id])}>{machine.machine} · {profile.label}</option>)])}</select></label><div><button type="button" onClick={() => setPicked(null)}>{t("graph.cancel")}</button><button type="button" data-graph-assign disabled={!target || action.busy} onClick={() => { const [id, profileId] = JSON.parse(target) as [string, string | null]; const machine = machines.data?.find((item) => item.id === id); if (machine) assign(picked, machine, profileId); }}>{t("graph.assign")}</button></div></div> : null}
  </div>;
}

export function GraphPage() { return <ReactFlowProvider><GraphBody /></ReactFlowProvider>; }
