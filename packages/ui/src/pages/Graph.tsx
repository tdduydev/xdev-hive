import { useCallback, useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, Controls, Handle, Position, useReactFlow, ReactFlowProvider, type NodeProps, type Node, type NodeChange, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import type { Task } from "@xdev-hive/core";
import { Badge, ErrorNote, STATUS_TONE } from "#ui/components/common.tsx";
import { useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { layoutGraph, taskGraph, readPositions, writePositions, clearPositions, type GraphNode } from "#ui/lib/graph.ts";
import { scopeFilter, scopeKey } from "#ui/lib/scope.ts";
import { ownerLabel } from "#ui/lib/tasks.ts";
import "./Graph.css";

type TaskData = Record<string, unknown> & { graph: GraphNode; running: boolean; open: (task: Task) => void };
const colors: Record<string, string> = { todo: "neutral", doing: "running", review: "warning", done: "success", blocked: "danger" };

function TaskNode({ data }: NodeProps<Node<TaskData>>) {
  const { graph, running, open } = data;
  const t = useT();
  if (graph.kind === "group") return <div className="graph-group-title">specs/{graph.label}</div>;
  if (graph.kind === "count") return <div className="graph-count">+{graph.count} {t("graph.completed")}</div>;
  const task = graph.task;
  return <>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <button type="button" className={`nodrag graph-task graph-${task?.status ?? "foreign"}`} aria-label={task ? `${task.id}, ${task.title}, ${t(`taskStatus.${task.status}`)}` : `${graph.project}, ${graph.label}`} onClick={() => task && open(task)} data-graph-task={task?.id ?? graph.id}>
      <span className="graph-task-top"><span>{task?.id ?? graph.id.split(":").at(-1)}</span>{running ? <span className="graph-running" aria-label={t("graph.running")} title={t("graph.running")} /> : null}</span>
      <span className="graph-task-title">{graph.label}</span>
      <span className="graph-task-meta">{graph.project ? <span>{graph.project}</span> : null}{task ? <Badge tone={STATUS_TONE[task.status]}>{t(`taskStatus.${task.status}`)}</Badge> : null}{task?.owner ? <span className="graph-agent">{ownerLabel(task.owner).who}</span> : null}</span>
    </button>
    <span className="graph-drag-handle" aria-hidden="true">⋮⋮</span>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </>;
}
const nodeTypes = { task: TaskNode, group: TaskNode };

function GraphBody() {
  const { client, scope, me, projects, setScope } = useHive();
  const t = useT();
  const reactFlow = useReactFlow();
  const scopeId = scopeKey(scope);
  const storageKey = `xdev-hive.graph.task.${scopeId}`;
  const [oldDone, setOldDone] = useState(true);
  const [mine, setMine] = useState(false);
  const [agent, setAgent] = useState("");
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>(() => readPositions(storageKey));
  const [livePositions, setLivePositions] = useState<Record<string, { x: number; y: number }>>({});
  const poll = usePoll(5000);
  const scopeArgs = scopeFilter(scope);
  const tasks = useQuery(() => client.call("tasks.list", scopeArgs), [client, scopeId, poll]);
  const flows = useQuery(() => client.call("sdlc.flows", { ...scopeArgs, limit: 200 }).catch(() => []), [client, scopeId, poll]);
  const runs = useQuery(() => client.call("runs.list", { ...scopeArgs, limit: 200 }).catch(() => []), [client, scopeId, poll]);
  useEffect(() => { setPositions(readPositions(storageKey)); setLivePositions({}); }, [storageKey]);
  const all = tasks.data ?? [];
  const agents = [...new Set(all.map((task) => task.owner ? ownerLabel(task.owner).who : "").filter(Boolean))].sort();
  const filtered = all.filter((task) => (!mine || !!me.user && task.owner === me.user.username) && (!agent || !!task.owner && ownerLabel(task.owner).who === agent));
  const graph = useMemo(() => layoutGraph(taskGraph(filtered, flows.data ?? [], oldDone), { ...positions, ...livePositions }), [filtered, flows.data, oldDone, positions, livePositions]);
  const running = new Set((runs.data ?? []).filter((run) => ["running", "starting"].includes(run.status)).map((run) => `${run.project}:${run.taskId}`));
  const openTask = (task: Task) => { window.location.hash = `#/tasks?task=${encodeURIComponent(task.id)}`; };
  const nodes: Node<TaskData>[] = graph.nodes.map((node) => ({ id: node.id, type: node.kind === "group" ? "group" : "task", position: node.position, width: node.width, height: node.height, parentId: node.parentId, dragHandle: ".graph-drag-handle", draggable: node.kind !== "count" && node.kind !== "group", selectable: false, style: { width: node.width, height: node.height }, data: { graph: node, running: running.has(node.id), open: openTask } }));
  const edges: Edge[] = graph.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: "smoothstep", className: edge.complete ? "graph-edge-complete" : "graph-edge-open", animated: false }));
  const onDragStop = useCallback((_: unknown, node: Node) => {
    const next = { ...positions, [node.id]: node.position };
    setPositions(next);
    writePositions(storageKey, next);
  }, [positions, storageKey]);
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const moved = changes.filter((change): change is Extract<NodeChange, { type: "position" }> => change.type === "position" && !!change.position);
    if (moved.length) setLivePositions((old) => Object.fromEntries([...Object.entries(old), ...moved.map((change) => [change.id, change.position!])]));
  }, []);
  const reset = () => { clearPositions(storageKey); setPositions({}); setLivePositions({}); requestAnimationFrame(() => void reactFlow.fitView({ padding: 0.15, duration: 0 })); };
  // Only newly arriving nodes get Dagre coordinates; an update does not move nodes already on the canvas.
  useEffect(() => {
    setLivePositions((old) => {
      const next = { ...old };
      for (const node of graph.nodes) if (!(node.id in next)) next[node.id] = node.position;
      return Object.keys(next).length === Object.keys(old).length ? old : next;
    });
  }, [tasks.data, flows.data]);
  if (scope.kind === "all" || scope.kind === "shared") return <div className="graph-pick"><p>{t("graph.pickProject")}</p><div>{projects.map((project) => <button key={project} type="button" onClick={() => setScope({ kind: "project", project })}>{project}</button>)}</div></div>;
  return <div className="graph-page">
    <div className="graph-toolbar">
      <div className="graph-layers" role="group" aria-label={t("graph.layers")}><button type="button" aria-pressed="true" data-graph-layer="task">Task</button>{(["Agent", "SDLC", t("graph.system")] as const).map((name) => <button type="button" disabled title={t("graph.soon")} key={name}>{name} · {t("graph.soon")}</button>)}</div>
      <div className="graph-filters"><label><input type="checkbox" checked={oldDone} onChange={(e) => setOldDone(e.target.checked)} />{t("graph.hideOldDone")}</label><label><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} disabled={!me.user} />{t("graph.mine")}</label><select aria-label={t("graph.byAgent")} value={agent} onChange={(e) => setAgent(e.target.value)}><option value="">{t("graph.allAgents")}</option>{agents.map((name) => <option key={name}>{name}</option>)}</select></div>
      <div className="graph-actions"><button type="button" onClick={() => void reactFlow.fitView({ padding: 0.15, duration: 0 })}>{t("graph.fit")}</button><button type="button" onClick={reset}>{t("graph.reset")}</button><a href="#/tasks">{t("graph.list")}</a></div>
    </div>
    <ErrorNote error={tasks.error} />
    <div className="graph-canvas" data-graph-canvas><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onNodeDragStop={onDragStop} fitView fitViewOptions={{ padding: 0.15 }} onlyRenderVisibleElements nodesConnectable={false} elementsSelectable={false} minZoom={0.2} maxZoom={2} attributionPosition="bottom-left"><Background color="var(--border-subtle)" gap={20} /><Controls showInteractive={false} /></ReactFlow></div>
  </div>;
}

export function GraphPage() { return <ReactFlowProvider><GraphBody /></ReactFlowProvider>; }
