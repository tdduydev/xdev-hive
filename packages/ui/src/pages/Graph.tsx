import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, useReactFlow, ReactFlowProvider, type NodeProps, type Node, type NodeChange, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import type { Machine, QuotaCooldown, RunRequest, Task, TaskAgentQueueItem } from "@xdev-hive/core";
import { Badge, ErrorNote, STATUS_TONE } from "#ui/components/common.tsx";
import { useAction, useCan, useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { useIsMobile } from "#ui/lib/hooks/use-mobile.ts";
import { agentGraph, layoutGraph, taskGraph, readPositions, writePositions, clearPositions, type AgentGraphNode, type GraphNode, type Point } from "#ui/lib/graph.ts";
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
const allNodeTypes = { ...nodeTypes, machine: AgentNode, profile: AgentNode, agentTask: AgentNode };

function GraphBody() {
  const { client, scope, me, projects, setScope } = useHive();
  const t = useT();
  const allow = useCan();
  const action = useAction();
  const phone = useIsMobile();
  const reactFlow = useReactFlow();
  const scopeId = scopeKey(scope);
  const [layer, setLayer] = useState<"task" | "agent">("task");
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
  const graph = useMemo(() => {
    if (layer === "task" && !taskReady) return { nodes: [], edges: [] };
    const laid = layer === "task" ? layoutGraph(taskGraph(filtered, flows.data ?? [], oldDone), placed.current) : agentGraph((machines.data ?? []).filter((m) => scope.kind !== "project" || m.projects.includes(scope.project)), queues.data ?? {}, all, placed.current);
    for (const node of laid.nodes) placed.current[node.id] ??= node.position;
    return laid;
  // `saved` re-runs the layout after a reset or a scope change; a drag alone never does.
  }, [layer, taskReady, filtered, flows.data, oldDone, machines.data, queues.data, all, scope, saved]);
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
  // The `fitView` prop fits only the first nodes React Flow sees; fit again once a layer's whole picture is in, since
  // onlyRenderVisibleElements leaves a node outside the view (and its edges) out of the page.
  const shown = layer === "task" ? taskNodes.length : agentNodes.length;
  const ready = layer === "task" ? taskReady : !!queues.data;
  useEffect(() => {
    const key = `${scopeId}:${layer}`;
    if (!ready || !shown || fitted.current === key) return;
    fitted.current = key;
    requestAnimationFrame(() => void reactFlow.fitView(FIT));
  }, [shown, layer, ready, reactFlow, scopeId]);
  const edges: Edge[] = useMemo(() => layer === "task" ? (graph as ReturnType<typeof taskGraph>).edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: "smoothstep", className: edge.complete ? "graph-edge-complete" : "graph-edge-open" })) : (graph as ReturnType<typeof agentGraph>).edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: "smoothstep", className: edge.running ? "graph-edge-running" : "graph-edge-agent" })), [layer, graph]);
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
  if (scope.kind === "all" || scope.kind === "shared") return <div className="graph-pick"><p>{t("graph.pickProject")}</p><div>{projects.map((project) => <button key={project} type="button" onClick={() => setScope({ kind: "project", project })}>{project}</button>)}</div></div>;
  return <div className="graph-page">
    <div className="graph-toolbar">
      <div className="graph-layers" role="group" aria-label={t("graph.layers")}>
        <button type="button" aria-pressed={layer === "task"} data-graph-layer="task" onClick={() => setLayer("task")}>Task</button>
        <button type="button" aria-pressed={layer === "agent"} data-graph-layer="agent" onClick={() => setLayer("agent")}>Agent</button>
        {(["SDLC", t("graph.system")] as const).map((name) => <button type="button" disabled aria-pressed="false" title={t("graph.soon")} key={name}>{name} · {t("graph.soon")}</button>)}
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
    <ErrorNote error={layer === "agent" ? machines.error ?? queues.error ?? action.error : null} />
    <div className="graph-workspace">
    {layer === "agent" ? <aside className="graph-unassigned" aria-label={t("graph.unassigned")}><h2>{t("graph.unassigned")}</h2><p>{phone ? t("graph.tapHint") : t("graph.dragHint")}</p><div className="graph-unassigned-list">{all.filter((task) => !task.agent && task.status !== "done").map((task) => <button key={`${task.project}:${task.id}`} type="button" draggable={!phone && allow(task.project, "runDispatch")} data-graph-unassigned={task.id} onDragStart={(e) => e.dataTransfer.setData("application/x-hive-task", `${task.project}:${task.id}`)} onClick={() => allow(task.project, "runDispatch") ? setPicked(task) : openTask(task)}><strong>{task.id}</strong><span>{task.title}</span></button>)}</div></aside> : null}
    <div className="graph-canvas" data-graph-canvas>
      <ReactFlow nodes={layer === "task" ? taskNodes : agentNodes} edges={edges} nodeTypes={allNodeTypes} onNodesChange={onNodesChange} onNodeDragStop={onDragStop} fitView fitViewOptions={FIT} onlyRenderVisibleElements nodesConnectable={false} elementsSelectable={false} minZoom={0.2} maxZoom={2} attributionPosition="bottom-left" aria-label={t("nav.graph")}>
        <Background color="var(--border-subtle)" gap={20} />
        <Controls showInteractive={false} position={phone ? "bottom-right" : "bottom-left"} />
        {phone ? null : <MiniMap pannable zoomable ariaLabel={t("graph.minimap")} nodeColor="var(--border-strong)" maskColor="color-mix(in srgb, var(--bg-sunken) 70%, transparent)" />}
      </ReactFlow>
    </div>
    </div>
    {picked ? <div className="graph-picker" role="dialog" aria-label={t("graph.chooseAgent")} onKeyDown={(e) => { if (e.key === "Escape") setPicked(null); }}><strong>{picked.id} · {picked.title}</strong><label>{t("graph.chooseAgent")}<select autoFocus data-graph-agent-select value={target} onChange={(e) => setTarget(e.target.value)}><option value="">{t("assignment.choose")}</option>{(machines.data ?? []).filter((machine) => canAssign(picked, machine)).flatMap((machine) => [<option key={`${machine.id}:any`} value={JSON.stringify([machine.id, null])}>{machine.machine} · {t("assignment.any")}</option>, ...machine.profiles.filter((profile) => profile.enabled).map((profile) => <option key={`${machine.id}:${profile.id}`} value={JSON.stringify([machine.id, profile.id])}>{machine.machine} · {profile.label}</option>)])}</select></label><div><button type="button" onClick={() => setPicked(null)}>{t("graph.cancel")}</button><button type="button" data-graph-assign disabled={!target || action.busy} onClick={() => { const [id, profileId] = JSON.parse(target) as [string, string | null]; const machine = machines.data?.find((item) => item.id === id); if (machine) assign(picked, machine, profileId); }}>{t("graph.assign")}</button></div></div> : null}
  </div>;
}

export function GraphPage() { return <ReactFlowProvider><GraphBody /></ReactFlowProvider>; }
