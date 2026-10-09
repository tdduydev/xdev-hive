import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import type { Actor } from "#core/index.ts";
import { SqliteHive, migrationIndex } from "#core/node.ts";

const admin: Actor = { name: "admin", role: "admin" };
const at = "2026-10-07T05:00:00.000Z";
const task = (h: SqliteHive, id: string, project = "app", status = "review") => h.db.prepare("INSERT INTO tasks(id, project, title, status, kind, updated_at) VALUES (?, ?, ?, ?, 'small-fix', ?)").run(id, project, id, status, at);
const run = (h: SqliteHive, id: string, taskId: string, over: { project?: string; machine?: string; created?: string; status?: string; summary?: string; error?: string; mr?: string; plan?: string } = {}) => h.db.prepare("INSERT INTO run_records(machine_id, run_id, machine, project, task_id, task_title, role, status, summary, error, mr, plan, created_at, updated_at) VALUES (?, ?, 'synthetic', ?, ?, ?, 'implement', ?, ?, ?, ?, ?, ?, ?)").run(over.machine ?? "m", id, over.project ?? "app", taskId, taskId, over.status ?? "done", over.summary ?? "Please confirm result", over.error ?? null, over.mr ?? null, over.plan ?? null, over.created ?? at, at);

it("includes unassigned release incidents only for service settings managers, with scope and pagination", async () => {
  const h = new SqliteHive(":memory:");
  try {
    task(h, "OPS-release-1", "app", "todo");
    task(h, "OPS-release-log-2-app", "app", "doing");
    task(h, "OPS-release-closed", "app", "done");
    task(h, "OPS-release-hidden", "hidden", "todo");
    task(h, "OPS-releaseXordinary", "app", "todo");
    const lead: Actor = { name: "lead", role: "member", access: { projects: { app: "lead", hidden: "reviewer" } } };
    const first = await h.call("inbox.source", { source: "tasks", limit: 1 }, lead);
    const second = await h.call("inbox.source", { source: "tasks", limit: 1, offset: 1 }, lead);
    assert.equal(first.total, 2);
    assert.equal(second.total, 2);
    assert.deepEqual(new Set([...first.tasks, ...second.tasks].map(t => t.id)), new Set(["OPS-release-1", "OPS-release-log-2-app"]));
    assert.equal((await h.call("inbox.source", { source: "tasks", project: "hidden" }, lead)).total, 0);
    assert.equal((await h.call("inbox.source", { source: "tasks" }, { ...lead, access: { projects: { app: "reviewer" } } })).total, 0);
    await h.call("tasks.update", { id: "OPS-release-1", status: "done" }, admin);
    assert.equal((await h.call("inbox.source", { source: "tasks" }, lead)).total, 1);
  } finally { h.close(); }
});

it("paginates actionable tasks after rights and scope, keeps holds and hides dependencies", async () => {
  const h = new SqliteHive(":memory:");
  try {
    for (let i = 0; i < 1201; i++) task(h, `A-${String(i).padStart(4, "0")}`);
    for (let i = 0; i < 600; i++) task(h, `Z-${i}`, "hidden");
    task(h, "hold", "app", "doing");
    task(h, "done-hold", "app", "done");
    h.db.exec("UPDATE tasks SET agent_machine = 'm', agent_by = 'reader', agent_hold = '{\"message\":\"stopped\"}' WHERE id IN ('hold', 'done-hold')");
    h.db.exec("INSERT INTO task_deps(task_id, depends_on) VALUES ('A-1200', 'Z-0')");
    const reviewer: Actor = { name: "reviewer", role: "member", access: { projects: { app: "reviewer" } } };
    const ids: string[] = [];
    for (let offset = 0; offset < 1201; offset += 500) {
      const page = await h.call("inbox.source", { source: "tasks", projects: ["app", "hidden"], offset, limit: 500 }, reviewer);
      assert.equal(page.total, 1201);
      assert.equal(page.tasks[0]!.dependsOn.includes("Z-0"), false);
      ids.push(...page.tasks.map((t) => t.id));
    }
    assert.equal(new Set(ids).size, 1201);
    assert.equal((await h.call("inbox.source", { source: "tasks", projects: [] }, admin)).total, 0);
    const reader: Actor = { name: "reader", role: "member", access: { projects: { app: "viewer" } } };
    assert.deepEqual((await h.call("inbox.source", { source: "tasks" }, reader)).tasks.map((t) => t.id), ["hold"]);
    assert.equal((await h.call("inbox.source", { source: "tasks" }, admin)).total, 1802);
    h.db.prepare("INSERT INTO project_states(project, state, at, \"by\") VALUES ('hidden', 'archived', ?, 'admin')").run(at);
    assert.equal((await h.call("inbox.source", { source: "tasks" }, admin)).total, 1202);
    assert.equal((await h.call("inbox.source", { source: "tasks", project: "hidden" }, admin)).total, 600);
  } finally { h.close(); }
});

it("selects latest per project/task across machines before checking signals and paginating", async () => {
  const h = new SqliteHive(":memory:");
  try {
    for (let i = 0; i < 601; i++) run(h, `R-${i}`, `T-${i}`);
    run(h, "old", "answered");
    run(h, "new", "answered", { machine: "other", created: "2026-10-08T00:00:00.000Z", summary: "All complete" });
    run(h, "plan", "plan", { plan: '{"phase":"plan"}' });
    run(h, "quota", "quota", { summary: "", status: "rate_limited" });
    run(h, "error", "error", { summary: "", error: "usage limit reached" });
    run(h, "ci", "ci", { summary: "", mr: '{"pipeline":"failed"}' });
    run(h, "vi", "vi", { summary: "cần bạn xác nhận" });
    run(h, "hidden", "T-0", { project: "hidden" });
    run(h, "tie-a", "tie", { machine: "m" });
    run(h, "tie-z", "tie", { machine: "other", summary: "Done" });
    const lead: Actor = { name: "lead", role: "member", access: { projects: { app: "lead", hidden: "viewer" } } };
    const first = await h.call("inbox.source", { source: "runs", limit: 500 }, lead);
    const last = await h.call("inbox.source", { source: "runs", limit: 500, offset: 500 }, lead);
    assert.equal(first.total, 605);
    assert.equal(first.runs.length, 500);
    assert.equal(last.runs.length, 105);
    const rows = [...first.runs, ...last.runs];
    assert.equal(new Set(rows.map((r) => r.taskId)).size, 605);
    assert.equal(rows.some((r) => ["answered", "tie", "plan"].includes(r.taskId)), false);
    assert.ok(rows.every((r) => r.project === "app" && !("log" in r)));
    assert.equal((await h.call("inbox.source", { source: "runs" }, { ...lead, access: { projects: { app: "reviewer" } } })).total, 0);
    assert.equal((await h.call("inbox.source", { source: "runs", projects: ["hidden"] }, admin)).total, 1);
    const plan = h.db.prepare("EXPLAIN QUERY PLAN SELECT machine_id, run_id, ROW_NUMBER() OVER (PARTITION BY project, task_id ORDER BY created_at DESC, run_id DESC, machine_id DESC) AS rank FROM run_records WHERE project IN ('app')").all();
    assert.ok(plan.some((r) => String(r.detail).includes("run_records_task_latest")));
  } finally { h.close(); }
});

it("aggregates dispatch beyond the board limit and excludes owned, done and disabled kinds", async () => {
  const h = new SqliteHive(":memory:");
  try {
    for (let i = 0; i < 1201; i++) task(h, `T-${i}`, "app", "todo");
    task(h, "done", "app", "done");
    task(h, "hidden", "hidden", "todo");
    task(h, "wrong-kind", "app", "todo");
    h.db.exec("UPDATE tasks SET kind = 'feature' WHERE id = 'wrong-kind'");
    await h.call("sdlc.setProject", { project: "app", settings: { gates: {}, fastLaneKinds: ["small-fix"] } }, admin);
    h.db.prepare("INSERT INTO sdlc_flows(task_id, project, step, state, machine_id, created_by, created_at, updated_at) VALUES ('T-0', 'app', 'import', 'gate', 'missing', 'admin', ?, ?)").run(at, at);
    h.db.prepare("INSERT INTO sdlc_flow_tasks(task_id, flow_task, project, stage, created_by, updated_at) VALUES ('T-1', 'T-0', 'app', 'queued', 'admin', ?)").run(at);
    h.db.prepare("INSERT INTO sdlc_flow_tasks(task_id, flow_task, project, stage, created_by, updated_at) VALUES ('T-2', 'T-0', 'app', 'build', 'admin', ?)").run(at);
    const actor: Actor = { name: "reader", role: "member", access: { projects: { app: "viewer" } } };
    const rows = [];
    for (let offset = 0; offset < 1200; offset += 500) {
      const page = await h.call("sdlc.dispatch", { project: "app", limit: 500, offset }, actor);
      assert.equal(page.total, 1200);
      rows.push(...page.tasks);
    }
    assert.equal(new Set(rows.map((t) => t.id)).size, 1200);
    assert.equal(rows.some((t) => t.id === "T-2"), false);
    await h.call("sdlc.setProject", { project: "app", settings: { gates: {}, fastLaneKinds: [] } }, admin);
    assert.equal((await h.call("sdlc.dispatch", {}, actor)).total, 2);
    assert.equal((await h.call("sdlc.dispatch", { projects: [] }, admin)).total, 0);
    await assert.rejects(h.call("sdlc.dispatch", { project: "hidden" }, actor), { code: "not_found" });
  } finally { h.close(); }
});

it("appends and applies the latest-run index to a populated full schema", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hive-inbox-migration-"));
  const file = path.join(dir, "hive.db");
  let h = new SqliteHive(file);
  try {
    run(h, "old", "T-1");
    const version = migrationIndex("CREATE INDEX run_records_task_latest");
    h.db.exec(`DROP INDEX run_records_task_latest; PRAGMA user_version = ${version};`);
    h.close();
    h = new SqliteHive(file, { migrateTo: version + 1 });
    assert.equal(h.db.prepare("PRAGMA user_version").get()!.user_version, version + 1);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM run_records").get()!.n, 1);
    assert.ok(h.db.prepare("SELECT name FROM sqlite_master WHERE name = 'run_records_task_latest'").get());
  } finally { h.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("returns each listed review task's newest run so Today can merge its MR", async () => {
  const h = new SqliteHive(":memory:");
  try {
    task(h, "R1");
    task(h, "T1", "app", "todo");
    run(h, "old", "R1", { created: "2026-10-07T04:00:00.000Z" });
    run(h, "new", "R1", { mr: JSON.stringify({ iid: 7, status: "opened" }) });
    run(h, "other", "T1");
    const page = await h.call("inbox.source", { source: "tasks" }, admin);
    assert.deepEqual(page.runs.map((r) => r.runId), ["new"]);
  } finally { h.close(); }
});
