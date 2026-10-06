import dagre from "@dagrejs/dagre";
import type { SdlcFlow, Task } from "@xdev-hive/core";

export type GraphNode = { id: string; kind: "task" | "foreign" | "count" | "group"; task?: Task; label: string; project?: string; count?: number; position: { x: number; y: number }; width: number; height: number; parentId?: string };
export type GraphEdge = { id: string; source: string; target: string; complete: boolean };
export type GraphModel = { nodes: GraphNode[]; edges: GraphEdge[] };
const SIZE = { width: 228, height: 94 };
const key = (project: string, id: string) => `${project}:${id}`;

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
  const edges: GraphEdge[] = [];
  for (const task of visible) {
    const target = key(task.project, task.id);
    if (!byKey.has(target)) continue;
    for (const dep of task.dependsOn ?? []) {
      const project = task.depProjects?.[dep] ?? task.project;
      const source = key(project, dep);
      if (!byKey.has(source)) {
        const known = tasks.find((candidate) => candidate.id === dep && candidate.project === project);
        nodes.push({ id: source, kind: "foreign", label: known?.title ?? dep, project, task: known, position: { x: 0, y: 0 }, ...SIZE });
        byKey.set(source, nodes.at(-1)!);
      }
      edges.push({ id: `${source}->${target}`, source, target, complete: !task.waitingOn?.includes(dep) });
    }
  }
  const groups = [...new Set(nodes.map((node) => node.parentId).filter((id): id is string => !!id))];
  for (const id of groups) nodes.unshift({ id, kind: "group", label: id.split(":").slice(2).join(":"), position: { x: 0, y: 0 }, width: SIZE.width + 48, height: SIZE.height + 70 });
  return { nodes, edges };
}

/** Each group is laid out independently; preserving old coordinates prevents live updates from moving a dragged node. */
export function layoutGraph(model: GraphModel, previous: Record<string, { x: number; y: number }> = {}): GraphModel {
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

export function readPositions(storageKey: string): Record<string, { x: number; y: number }> {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}
export function writePositions(storageKey: string, positions: Record<string, { x: number; y: number }>): void {
  try { localStorage.setItem(storageKey, JSON.stringify(positions)); } catch { /* A private browser still keeps positions for this visit. */ }
}
export function clearPositions(storageKey: string): void {
  try { localStorage.removeItem(storageKey); } catch { /* A private browser has nothing persistent to clear. */ }
}
