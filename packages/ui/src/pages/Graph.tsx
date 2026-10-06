import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, useReactFlow, ReactFlowProvider, type NodeProps, type Node, type NodeChange, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import type { Task } from "@xdev-hive/core";
import { Badge, ErrorNote, STATUS_TONE } from "#ui/components/common.tsx";
import { useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { useIsMobile } from "#ui/lib/hooks/use-mobile.ts";
import { layoutGraph, taskGraph, readPositions, writePositions, clearPositions, type GraphNode, type Point } from "#ui/lib/graph.ts";
import { scopeFilter, scopeKey } from "#ui/lib/scope.ts";
import { ownerLabel } from "#ui/lib/tasks.ts";
import "./Graph.css";

type TaskData = Record<string, unknown> & { graph: GraphNode; running: boolean; open: (task: Task) => void };
// A queued run is already the agent's: the dot tells the viewer not to hand the task to someone else.
const OPEN_RUN = new Set(["queued", "running"]);
// Above 1 a two-node project fills the screen with oversized cards.
const FIT = { padding: 0.15, maxZoom: 1, duration: 0 };

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

function GraphBody() {
  const { client, scope, me, projects, setScope } = useHive();
  const t = useT();
  const phone = useIsMobile();
  const reactFlow = useReactFlow();
  const scopeId = scopeKey(scope);
  const storageKey = `xdev-hive.graph.task.${scopeId}`;
  const [oldDone, setOldDone] = useState(true);
  const [openOnly, setOpenOnly] = useState<boolean | null>(null);
  const [mine, setMine] = useState(false);
  const [agent, setAgent] = useState("");
  // Positions of nodes already on the canvas: dragged ones (saved) and laid-out ones (this visit only), so a refresh
  // only lays out nodes that are new.
  const placed = useRef<Record<string, Point>>(readPositions(storageKey));
  const [saved, setSaved] = useState(0);
  const [dragging, setDragging] = useState<Record<string, Point>>({});
  const poll = usePoll(5000);
  const scopeArgs = scopeFilter(scope);
  const tasks = useQuery(() => client.call("tasks.list", scopeArgs), [client, scopeId, poll]);
  const flows = useQuery(() => client.call("sdlc.flows", { ...scopeArgs, limit: 200 }).catch(() => []), [client, scopeId, poll]);
  const runs = useQuery(() => client.call("runs.list", { ...scopeArgs, limit: 200 }).catch(() => []), [client, scopeId, poll]);
  useEffect(() => { placed.current = readPositions(storageKey); setDragging({}); setSaved((n) => n + 1); }, [storageKey]);
  // A phone shows only what is still open by default (spec 51, Mobile); the person can turn it off.
  const onlyOpen = openOnly ?? phone;
  const all = tasks.data ?? [];
  const agents = useMemo(() => [...new Set(all.map((task) => task.owner ? ownerLabel(task.owner).who : "").filter(Boolean))].sort(), [all]);
  const filtered = useMemo(() => all.filter((task) => (!onlyOpen || task.status !== "done") && (!mine || !!me.user && !!task.owner && ownerLabel(task.owner).who === me.user.username) && (!agent || !!task.owner && ownerLabel(task.owner).who === agent)), [all, onlyOpen, mine, me.user, agent]);
  const graph = useMemo(() => {
    const laid = layoutGraph(taskGraph(filtered, flows.data ?? [], oldDone), placed.current);
    for (const node of laid.nodes) placed.current[node.id] ??= node.position;
    return laid;
  // `saved` re-runs the layout after a reset or a scope change; a drag alone never does.
  }, [filtered, flows.data, oldDone, saved]);
  const running = useMemo(() => new Set((runs.data ?? []).filter((run) => OPEN_RUN.has(run.status) && run.taskId).map((run) => `${run.project}:${run.taskId}`)), [runs.data]);
  const openTask = useCallback((task: Task) => { window.location.hash = `#/tasks?task=${encodeURIComponent(task.id)}`; }, []);
  const nodes: Node<TaskData>[] = useMemo(() => graph.nodes.map((node) => ({
    id: node.id, type: node.kind === "group" ? "group" : "task", position: dragging[node.id] ?? node.position, width: node.width, height: node.height, parentId: node.parentId,
    dragHandle: ".graph-drag-handle", draggable: node.kind !== "count" && node.kind !== "group", selectable: false, style: { width: node.width, height: node.height },
    data: { graph: node, running: running.has(node.id), open: openTask },
  })), [graph, dragging, running, openTask]);
  const edges: Edge[] = useMemo(() => graph.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: "smoothstep", className: edge.complete ? "graph-edge-complete" : "graph-edge-open" })), [graph]);
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const moved = changes.filter((change): change is Extract<NodeChange, { type: "position" }> => change.type === "position" && !!change.position);
    if (moved.length) setDragging((old) => ({ ...old, ...Object.fromEntries(moved.map((change) => [change.id, change.position!])) }));
  }, []);
  const onDragStop = useCallback((_: unknown, node: Node) => {
    placed.current[node.id] = node.position;
    const stored = { ...readPositions(storageKey), [node.id]: node.position };
    writePositions(storageKey, stored);
  }, [storageKey]);
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
        <button type="button" aria-pressed="true" data-graph-layer="task">Task</button>
        {(["Agent", "SDLC", t("graph.system")] as const).map((name) => <button type="button" disabled aria-pressed="false" title={t("graph.soon")} key={name}>{name} · {t("graph.soon")}</button>)}
      </div>
      <div className="graph-tools">
        <div className="graph-filters">
          <label><input type="checkbox" checked={oldDone} onChange={(e) => setOldDone(e.target.checked)} />{t("graph.hideOldDone")}</label>
          <label><input type="checkbox" checked={onlyOpen} onChange={(e) => setOpenOnly(e.target.checked)} />{t("graph.openOnly")}</label>
          <label><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} disabled={!me.user} />{t("graph.mine")}</label>
          <select aria-label={t("graph.byAgent")} value={agent} onChange={(e) => setAgent(e.target.value)}><option value="">{t("graph.allAgents")}</option>{agents.map((name) => <option key={name}>{name}</option>)}</select>
        </div>
        <div className="graph-actions">
          <button type="button" onClick={() => void reactFlow.fitView(FIT)}>{t("graph.fit")}</button>
          <button type="button" onClick={reset}>{t("graph.reset")}</button>
          <a href="#/tasks">{t("graph.list")}</a>
        </div>
      </div>
    </div>
    <ErrorNote error={tasks.error} />
    <div className="graph-canvas" data-graph-canvas>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onNodeDragStop={onDragStop} fitView fitViewOptions={FIT} onlyRenderVisibleElements nodesConnectable={false} elementsSelectable={false} minZoom={0.2} maxZoom={2} attributionPosition="bottom-left" aria-label={t("nav.graph")}>
        <Background color="var(--border-subtle)" gap={20} />
        <Controls showInteractive={false} position={phone ? "bottom-right" : "bottom-left"} />
        {phone ? null : <MiniMap pannable zoomable ariaLabel={t("graph.minimap")} nodeColor="var(--border-strong)" maskColor="color-mix(in srgb, var(--bg-sunken) 70%, transparent)" />}
      </ReactFlow>
    </div>
  </div>;
}

export function GraphPage() { return <ReactFlowProvider><GraphBody /></ReactFlowProvider>; }
