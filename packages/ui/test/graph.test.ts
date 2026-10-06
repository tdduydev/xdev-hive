import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Machine, Task } from "@xdev-hive/core";
import { agentGraph, taskGraph, layoutGraph, type GraphNode } from "#ui/lib/graph.ts";
const task = (id: string, patch: Partial<Task> = {}): Task => ({ id, project: "shop", title: id, status: "todo", owner: null, leaseUntil: null, note: null, updatedAt: "2026-10-06T00:00:00Z", dependsOn: [], waitingOn: [], agent: null, ...patch });
const NOW = Date.parse("2026-10-06T12:00:00Z");
const machine = { id: "runner.m", machine: "m", online: true, acceptsRuns: true, projects: ["shop"], profiles: [{ id: "p", label: "Plan", kind: "codex", enabled: true, installed: true, account: null, cooldownUntil: null, runs: 0, rateLimited: 0, maxConcurrent: 2 }], runs: [{ runId: "R1", project: "shop", taskId: "B", taskTitle: "B", role: "implement", status: "running", profileId: "p", since: "2026-10-06T10:00:00Z" }] } as Machine;
// Absolute position: a child of a group is placed relative to it, as React Flow draws it.
const abs = (nodes: GraphNode[], node: GraphNode) => {
  const parent = node.parentId ? nodes.find((other) => other.id === node.parentId) : undefined;
  return { x: node.position.x + (parent?.position.x ?? 0), y: node.position.y + (parent?.position.y ?? 0) };
};

describe("task graph", () => {
  it("draws task dependencies in the right direction, with completed edges muted", () => {
    const graph = taskGraph([task("A", { status: "done" }), task("B", { status: "doing", dependsOn: ["A"], waitingOn: [] }), task("C", { status: "blocked", dependsOn: ["B"], waitingOn: ["B"] }), task("D", { status: "review" }), task("E")], [], false, NOW);
    assert.deepEqual(graph.edges.map(({ source, target, complete }) => [source, target, complete]), [["shop:A", "shop:B", true], ["shop:B", "shop:C", false]]);
    assert.equal(graph.nodes.find((node) => node.id === "shop:C")?.task?.status, "blocked");
    assert.deepEqual(new Set(graph.nodes.filter((node) => node.task).map((node) => node.task!.status)), new Set(["todo", "doing", "review", "done", "blocked"]));
  });
  it("hides tasks done more than 7 days ago by default, without leaving a stray node for them", () => {
    const graph = taskGraph([task("OLD", { status: "done", updatedAt: "2026-09-01T00:00:00Z" }), task("NEW", { dependsOn: ["OLD"] })], [], true, NOW);
    assert.deepEqual(graph.nodes.map((node) => node.id), ["shop:NEW"]);
    assert.deepEqual(graph.edges, []);
  });
  it("groups a feature's tasks under its specs directory", () => {
    const graph = taskGraph([task("S001-T001", { note: "Spec Kit · specs/001-cart/tasks.md" }), task("LOOSE")], [], true, NOW);
    assert.equal(graph.nodes.find((node) => node.id === "shop:S001-T001")?.parentId, "group:shop:001-cart");
    assert.equal(graph.nodes.find((node) => node.id === "group:shop:001-cart")?.label, "001-cart");
    assert.equal(graph.nodes.find((node) => node.id === "shop:LOOSE")?.parentId, undefined);
    // React Flow needs a parent before its children.
    assert.equal(graph.nodes[0]?.kind, "group");
  });
  it("shows a cross-project dependency as a faded node with its project", () => {
    const graph = taskGraph([task("B", { depProjects: { EXT: "api" }, dependsOn: ["EXT"], waitingOn: ["EXT"] })], [], true, NOW);
    const ext = graph.nodes.find((node) => node.id === "api:EXT");
    assert.equal(ext?.kind, "foreign");
    assert.equal(ext?.project, "api");
    assert.deepEqual(graph.edges.map(({ source, target, complete }) => [source, target, complete]), [["api:EXT", "shop:B", false]]);
  });
  it("connects a service's task to the real node when both services are in scope (system)", () => {
    const graph = taskGraph([task("EXT", { project: "api" }), task("B", { depProjects: { EXT: "api" }, dependsOn: ["EXT"], waitingOn: ["EXT"] })], [], true, NOW);
    assert.equal(graph.nodes.find((node) => node.id === "api:EXT")?.kind, "task");
    assert.equal(graph.nodes.filter((node) => node.kind === "foreign").length, 0);
  });
  it("collapses completed tasks per feature above 300, and points a done dependency at the count", () => {
    const tasks = [...Array.from({ length: 302 }, (_, i) => task(`T-${i}`, { status: "done", note: "specs/cart/tasks.md" })), task("NEXT", { note: "specs/cart/tasks.md", dependsOn: ["T-1"] })];
    const graph = taskGraph(tasks, [], false, NOW);
    const count = graph.nodes.find((node) => node.kind === "count");
    assert.equal(count?.count, 302);
    assert.equal(count?.parentId, "group:shop:cart");
    assert.deepEqual(graph.nodes.filter((node) => node.kind === "task").map((node) => node.id), ["shop:NEXT"]);
    assert.deepEqual(graph.edges.map(({ source, target }) => [source, target]), [["count:group:shop:cart", "shop:NEXT"]]);
  });
  it("lays out with dagre left to right without overlapping nodes, across groups and loose tasks", () => {
    const tasks = [
      task("A"), task("B", { dependsOn: ["A"] }), task("C", { dependsOn: ["A"] }), task("D", { dependsOn: ["B", "C"] }),
      task("F1", { note: "specs/001-x/tasks.md" }), task("F2", { note: "specs/001-x/tasks.md", dependsOn: ["F1"] }), task("F3", { note: "specs/001-x/tasks.md", dependsOn: ["F1"] }),
    ];
    const { nodes } = layoutGraph(taskGraph(tasks, [], true, NOW));
    const cards = nodes.filter((node) => node.kind !== "group").map((node) => ({ id: node.id, ...abs(nodes, node), width: node.width, height: node.height }));
    for (const [i, a] of cards.entries()) for (const b of cards.slice(i + 1)) {
      const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
      assert.ok(apart, `${a.id} overlaps ${b.id}`);
    }
    const at = (id: string) => cards.find((card) => card.id === id)!;
    assert.ok(at("shop:A").x + at("shop:A").width <= at("shop:B").x, "a dependency sits left of the task that needs it");
    assert.ok(at("shop:B").x + at("shop:B").width <= at("shop:D").x);
  });
  it("keeps positions already on the canvas when data changes, and lays out only the new node", () => {
    const tasks = [task("A"), task("B", { dependsOn: ["A"], waitingOn: ["A"] })];
    const first = layoutGraph(taskGraph(tasks, [], true, NOW));
    const placed = Object.fromEntries(first.nodes.map((node) => [node.id, node.position]));
    placed["shop:A"] = { x: 700, y: 200 };
    const next = layoutGraph(taskGraph([...tasks, task("C")], [], true, NOW), placed);
    assert.deepEqual(next.nodes.find((node) => node.id === "shop:A")?.position, { x: 700, y: 200 });
    assert.deepEqual(next.nodes.find((node) => node.id === "shop:B")?.position, first.nodes.find((node) => node.id === "shop:B")?.position);
    const c = next.nodes.find((node) => node.id === "shop:C")!;
    assert.ok(Number.isFinite(c.position.x) && Number.isFinite(c.position.y));
  });
});

describe("agent graph", () => {
  it("keeps other projects in a machine queue outside the selected scope", () => {
    const foreign = task("OTHER", { project: "other", agent: { machineId: machine.id, machine: machine.machine, profileId: "p", order: 0, by: "admin", at: "2026-10-06T00:00:00Z", hold: null } });
    const model = agentGraph([machine], { [machine.id]: [{ task: foreign, waiting: null }] }, []);
    assert.equal(model.nodes.filter((node) => node.kind === "agentTask").length, 0);
  });
  it("connects machine, profile, active run and the first three queued tasks in hub order", () => {
    const tasks = ["A", "B", "C", "D", "E"].map((id, index) => task(id, { agent: { machineId: machine.id, machine: machine.machine, profileId: "p", order: index, by: "admin", at: "2026-10-06T00:00:00Z", hold: null } }));
    const model = agentGraph([machine], { [machine.id]: tasks.map((item) => ({ task: item, waiting: null })) }, tasks);
    assert.deepEqual(model.nodes.filter((node) => node.kind === "agentTask").map((node) => node.task?.id), ["B", "A", "C"]);
    assert.equal(model.edges.filter((edge) => edge.running).length, 1);
    assert.equal(model.edges.filter((edge) => edge.source.startsWith("machine:")).length, 1);
  });
});
