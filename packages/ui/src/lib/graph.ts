import dagre from "@dagrejs/dagre";
import type { Machine, MachineRun, SdlcFlow, Task, TaskAgentQueueItem } from "@xdev-hive/core";

export type Point = { x: number; y: number };
export type GraphNode = { id: string; kind: "task" | "foreign" | "count" | "group"; task?: Task; label: string; project?: string; count?: number; position: Point; width: number; height: number; parentId?: string };
export type GraphEdge = { id: string; source: string; target: string; complete: boolean };
export type GraphModel = { nodes: GraphNode[]; edges: GraphEdge[] };
export type AgentGraphNode = { id: string; kind: "machine" | "profile" | "agentTask"; label: string; position: Point; width: number; height: number; machine?: Machine; profileId?: string | null; task?: Task; run?: MachineRun };
export type AgentGraphEdge = { id: string; source: string; target: string; running: boolean };
export type AgentGraphModel = { nodes: AgentGraphNode[]; edges: AgentGraphEdge[] };
const SIZE = { width: 228, height: 94 };
const key = (project: string, id: string) => `${project}:${id}`;

/** The queue response supplies hub order; active runs lead each profile and appear only once. */
export function agentGraph(machines: Machine[], queues: Record<string, TaskAgentQueueItem[]>, tasks: Task[], previous: Record<string, Point> = {}): AgentGraphModel {
  const nodes: AgentGraphNode[] = [];
  const edges: AgentGraphEdge[] = [];
  const known = new Map(tasks.map((task) => [key(task.project, task.id), task]));
  let top = 24;
  for (const machine of machines) {
    const machineId = `machine:${machine.id}`;
    nodes.push({ id: machineId, kind: "machine", label: machine.machine, machine, position: previous[machineId] ?? { x: 24, y: top }, width: 190, height: 72 });
    const profiles = [...machine.profiles.map((profile) => ({ id: profile.id, label: profile.label })), { id: null, label: "" }];
    let row = top;
    for (const profile of profiles) {
      const assigned = (queues[machine.id] ?? []).filter(({ task }) => known.has(key(task.project, task.id)) && task.agent?.profileId === profile.id && task.status !== "done");
      const runs = machine.runs.filter((run) => run.profileId === profile.id && known.has(key(run.project, run.taskId)));
      if (profile.id === null && !assigned.length && !runs.length) continue;
      const profileId = `profile:${machine.id}:${profile.id ?? "any"}`;
      nodes.push({ id: profileId, kind: "profile", label: profile.label, machine, profileId: profile.id, position: previous[profileId] ?? { x: 284, y: row }, width: 236, height: 116 });
      edges.push({ id: `${machineId}->${profileId}`, source: machineId, target: profileId, running: false });
      const shown = new Set<string>();
      const lines = [
        ...runs.map((run) => ({ task: known.get(key(run.project, run.taskId))!, run })),
        ...assigned.map(({ task }) => ({ task, run: undefined })),
      ].filter(({ task }) => { const id = key(task.project, task.id); if (shown.has(id)) return false; shown.add(id); return true; }).slice(0, 3);
      lines.forEach(({ task, run }, index) => {
        const id = `agent-task:${machine.id}:${profile.id ?? "any"}:${key(task.project, task.id)}`;
        nodes.push({ id, kind: "agentTask", label: task.title, task, run, position: previous[id] ?? { x: 590, y: row + index * 104 }, width: 228, height: 94 });
        edges.push({ id: `${profileId}->${id}`, source: profileId, target: id, running: run?.status === "running" });
      });
      row += Math.max(142, lines.length * 104 + 24);
    }
    top = Math.max(top + 142, row + 36);
  }
  return { nodes, edges };
}

/** Build before layout so dependencies from another visible service connect to the real task. */
export function taskGraph(tasks: Task[], flows: SdlcFlow[] = [], hideOldDone = true, now = Date.now()): GraphModel {
  const cutoff = now - 7 * 86400_000;
  const visible = tasks.filter((task) => !hideOldDone || task.status !== "done" || Date.parse(task.updatedAt) >= cutoff);
  const collapsed = visible.length > 300;
  const flowByProject = new Map<string, SdlcFlow[]>();
  for (const flow of flows) if (flow.dir) flowByProject.set(flow.project, [...(flowByProject.get(flow.project) ?? []), flow]);
  const groupOf = (task: Task) => {
    const dir = /specs\/([^/\s)]+)/.exec(task.note ?? "")?.[1] ?? flowByProject.get(task.project)?.find((flow) => flow.taskId === task.id)?.dir;
    return dir ? `group:${task.project}:${dir}` : undefined;
  };
  const nodes: GraphNode[] = [];
  const counted = new Map<string, number>();
  for (const task of visible) {
    const group = groupOf(task);
    if (collapsed && task.status === "done") { counted.set(group ?? `loose:${task.project}`, (counted.get(group ?? `loose:${task.project}`) ?? 0) + 1); continue; }
    nodes.push({ id: key(task.project, task.id), kind: "task", task, label: task.title, position: { x: 0, y: 0 }, ...SIZE, parentId: group });
  }
  for (const [group, count] of counted) nodes.push({ id: `count:${group}`, kind: "count", label: `+${count}`, count, position: { x: 0, y: 0 }, ...SIZE, parentId: group.startsWith("group:") ? group : undefined });
  const byKey = new Map(nodes.map((node) => [node.id, node]));
  const known = new Map(tasks.map((task) => [key(task.project, task.id), task]));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const task of visible) {
    const target = key(task.project, task.id);
    if (!byKey.has(target)) continue;
    for (const dep of task.dependsOn ?? []) {
      const project = task.depProjects?.[dep] ?? task.project;
      let source = key(project, dep);
      const depTask = known.get(source);
      const complete = !task.waitingOn?.includes(dep);
      if (!byKey.has(source)) {
        if (project === task.project && depTask?.status === "done") {
          // A finished dependency folded into "+N" or hidden as old: point at its count, or drop the line, rather than
          // drawing the same task a second time as a stray node.
          const count = `count:${groupOf(depTask) ?? `loose:${project}`}`;
          if (!collapsed || !byKey.has(count)) continue;
          source = count;
        } else {
          // Another project's task (19d), or one the filters left out: a faded node, with the project when it differs.
          nodes.push({ id: source, kind: "foreign", label: depTask?.title ?? dep, project: project === task.project ? undefined : project, task: depTask, position: { x: 0, y: 0 }, ...SIZE });
          byKey.set(source, nodes.at(-1)!);
        }
      }
      const id = `${source}->${target}`;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({ id, source, target, complete });
    }
  }
  const groups = [...new Set(nodes.map((node) => node.parentId).filter((id): id is string => !!id))];
  for (const id of groups) nodes.unshift({ id, kind: "group", label: id.split(":").slice(2).join(":"), position: { x: 0, y: 0 }, width: SIZE.width + 48, height: SIZE.height + 70 });
  return { nodes, edges };
}

/** Each group is laid out independently; preserving old coordinates prevents live updates from moving a dragged node. */
export function layoutGraph(model: GraphModel, previous: Record<string, Point> = {}): GraphModel {
  const nodes = model.nodes.map((node) => ({ ...node, position: { ...node.position } }));
  const groups = nodes.filter((node) => node.kind === "group");
  const clusters = [...groups.map((group) => group.id), "loose"];
  let left = 32;
  for (const cluster of clusters) {
    const children = nodes.filter((node) => node.kind !== "group" && (node.parentId ?? "loose") === cluster);
    if (!children.length) continue;
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: "LR", ranksep: 70, nodesep: 32, marginx: 18, marginy: 18 });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const node of children) graph.setNode(node.id, { width: node.width, height: node.height });
    for (const edge of model.edges) if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) graph.setEdge(edge.source, edge.target);
    dagre.layout(graph);
    const bounds = graph.graph();
    const group = groups.find((node) => node.id === cluster);
    if (group) {
      group.position = previous[group.id] ?? { x: left, y: 30 };
      group.width = Math.max(276, (bounds.width ?? 0) + 36);
      group.height = Math.max(156, (bounds.height ?? 0) + 70);
    }
    for (const node of children) {
      const point = graph.node(node.id);
      node.position = previous[node.id] ?? { x: point.x - node.width / 2 + (group ? 18 : left), y: point.y - node.height / 2 + (group ? 44 : 30) };
    }
    left += Math.max(300, (bounds.width ?? 0) + 72);
  }
  return { nodes, edges: model.edges };
}

export function readPositions(storageKey: string): Record<string, Point> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    if (!value || typeof value !== "object") return {};
    // An entry edited by hand or left by an older build would put a node at NaN, which React Flow cannot draw.
    return Object.fromEntries(Object.entries(value).filter(([, p]) => Number.isFinite(p?.x) && Number.isFinite(p?.y)).map(([id, p]) => [id, { x: p.x, y: p.y }]));
  } catch { return {}; }
}
export function writePositions(storageKey: string, positions: Record<string, Point>): void {
  try { localStorage.setItem(storageKey, JSON.stringify(positions)); } catch { /* A private browser still keeps positions for this visit. */ }
}
export function clearPositions(storageKey: string): void {
  try { localStorage.removeItem(storageKey); } catch { /* A private browser has nothing persistent to clear. */ }
}
