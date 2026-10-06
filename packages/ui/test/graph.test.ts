import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Task } from "@xdev-hive/core";
import { taskGraph, layoutGraph } from "#ui/lib/graph.ts";
const task = (id: string, patch: Partial<Task> = {}): Task => ({ id, project: "shop", title: id, status: "todo", owner: null, leaseUntil: null, note: null, updatedAt: "2026-10-06T00:00:00Z", dependsOn: [], waitingOn: [], ...patch });

describe("task graph", () => {
  it("draws task dependencies in the right direction, with completed edges muted", () => {
    const graph = taskGraph([task("A", { status: "done" }), task("B", { status: "doing", dependsOn: ["A"], waitingOn: [] }), task("C", { status: "blocked", dependsOn: ["B"], waitingOn: ["B"] }), task("D", { status: "review" }), task("E")], [], false);
    assert.deepEqual(graph.edges.map(({ source, target, complete }) => [source, target, complete]), [["shop:A", "shop:B", true], ["shop:B", "shop:C", false]]);
    assert.equal(graph.nodes.find((node) => node.id === "shop:C")?.task?.status, "blocked");
    assert.deepEqual(new Set(graph.nodes.filter((node) => node.task).map((node) => node.task!.status)), new Set(["todo", "doing", "review", "done", "blocked"]));
  });
  it("groups a feature's tasks under its specs directory", () => {
    const graph = taskGraph([task("S001-T001", { note: "Spec Kit · specs/001-cart/tasks.md" })]);
    assert.equal(graph.nodes.find((node) => node.id === "shop:S001-T001")?.parentId, "group:shop:001-cart");
    assert.equal(graph.nodes.find((node) => node.id === "group:shop:001-cart")?.label, "001-cart");
  });
  it("shows a cross-project dependency with its project", () => {
    const graph = taskGraph([task("B", { depProjects: { EXT: "api" }, dependsOn: ["EXT"], waitingOn: ["EXT"] })]);
    assert.equal(graph.nodes.find((node) => node.id === "api:EXT")?.project, "api");
    assert.equal(graph.edges[0]?.source, "api:EXT");
  });
  it("collapses completed tasks by feature above 300", () => {
    const tasks = Array.from({ length: 302 }, (_, i) => task(`T-${i}`, { status: "done", note: "specs/cart/tasks.md" }));
    const graph = taskGraph(tasks, [], false);
    assert.equal(graph.nodes.find((node) => node.kind === "count")?.count, 302);
    assert.equal(graph.nodes.filter((node) => node.kind === "task").length, 0);
  });
  it("lays out separate nodes without overlap and retains dragged positions after an update", () => {
    const tasks = [task("A"), task("B", { dependsOn: ["A"], waitingOn: ["A"] })];
    const first = layoutGraph(taskGraph(tasks));
    const a = first.nodes.find((node) => node.id === "shop:A")!;
    const b = first.nodes.find((node) => node.id === "shop:B")!;
    assert.ok(a.position.x + a.width <= b.position.x);
    const next = layoutGraph(taskGraph([...tasks, task("C")]), { "shop:A": { x: 700, y: 200 } });
    assert.deepEqual(next.nodes.find((node) => node.id === "shop:A")?.position, { x: 700, y: 200 });
  });
});
