import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { type Actor } from "#core/index.ts";
import { SqliteHive, migrationIndex } from "#core/node.ts";

const admin: Actor = { name: "perf-test", role: "admin" };
const now = () => new Date("2026-10-07T05:00:00.000Z");

describe("large hub list reads", () => {
  it("reads machine names once per task batch and refreshes them on the next call", async () => {
    const hive = new SqliteHive(":memory:", { now });
    const db = hive.db;
    const prepare = db.prepare;
    let reads = 0;
    try {
      db.prepare("INSERT INTO machines(id, machine, instance, last_seen) VALUES ('runner@one', 'one', 'synthetic', ?)").run(now().toISOString());
      const add = db.prepare("INSERT INTO tasks(id, project, title, status, agent_machine, updated_at) VALUES (?, 'app', ?, 'todo', ?, ?)");
      for (let i = 0; i < 600; i++) add.run(`T-${i}`, `Task ${i}`, i % 2 ? "runner@one" : "runner@missing", new Date(now().getTime() + i).toISOString());
      db.prepare("INSERT INTO task_deps(task_id, depends_on) VALUES ('T-599', 'T-598')").run();
      db.prepare = function (sql) {
        if (sql === "SELECT id, machine FROM machines") reads++;
        return prepare.call(this, sql);
      };
      const list = await hive.call("tasks.list", { project: "app" }, admin);
      assert.equal(list.length, 500);
      assert.equal(reads, 1, "machine lookup must not scale with the number of tasks");
      assert.equal(list[0]!.id, "T-599");
      assert.equal(list[0]!.agent!.machine, "one");
      assert.equal(list[1]!.agent!.machine, "runner@missing");
      assert.deepEqual(list[0]!.dependsOn, ["T-598"]);
      assert.deepEqual(list[0]!.waitingOn, ["T-598"]);
      db.prepare("UPDATE machines SET machine = 'renamed' WHERE id = 'runner@one'").run();
      const next = await hive.call("tasks.list", { project: "app" }, admin);
      assert.equal(next[0]!.agent!.machine, "renamed", "the map is only shared within one batch");
      assert.equal(reads, 2);
      assert.deepEqual(await hive.call("tasks.list", { project: "missing" }, admin), []);
      assert.equal(reads, 2, "an empty batch needs no machine map");
    } finally {
      db.prepare = prepare;
      hive.close();
    }
  });

  it("upgrades a populated hub and uses indexes for list ordering and request housekeeping", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hive-perf-indexes-"));
    const file = path.join(dir, "hive.db");
    let hive: SqliteHive | undefined;
    try {
      const version = migrationIndex("CREATE INDEX tasks_list_at");
      hive = new SqliteHive(file, { now });
      // Keep later schema changes: only the list-index migration is rewound and replayed.
      hive.db.exec(`DROP INDEX tasks_list_at; DROP INDEX run_records_created;
        DROP INDEX run_requests_pending_at; DROP INDEX run_requests_retention_at; PRAGMA user_version = ${version}`);
      const addTask = hive.db.prepare("INSERT INTO tasks(id, project, title, status, updated_at) VALUES (?, ?, ?, ?, ?)");
      addTask.run("T-1", "app", "First", "todo", "2026-10-06T00:00:00.000Z");
      addTask.run("T-2", "other", "Other", "review", "2026-10-07T00:00:00.000Z");
      addTask.run("T-3", "app", "Last", "review", "2026-10-07T01:00:00.000Z");
      const addRun = hive.db.prepare("INSERT INTO run_records(machine_id, run_id, machine, project, task_id, task_title, role, status, created_at, updated_at) VALUES ('runner', ?, 'machine', ?, 'T-1', 'First', 'implement', 'done', ?, ?)");
      addRun.run("R-old", "app", "2026-10-01T00:00:00.000Z", now().toISOString());
      addRun.run("R-a", "app", "2026-10-07T00:00:00.000Z", now().toISOString());
      addRun.run("R-b", "other", "2026-10-07T00:00:00.000Z", now().toISOString());
      const beforeTasks = await hive.call("tasks.list", {}, admin);
      const beforeRuns = await hive.call("runs.list", {}, admin);
      hive.close();
      hive = new SqliteHive(file, { now, migrateTo: version + 1 });
      assert.ok(Number(hive.db.prepare("PRAGMA user_version").get()!.user_version) >= version + 1, "the audit migration has run");
      assert.deepEqual(await hive.call("tasks.list", {}, admin), beforeTasks);
      assert.deepEqual(await hive.call("runs.list", {}, admin), beforeRuns);
      assert.deepEqual(beforeRuns.map((r) => r.runId), ["R-b", "R-a", "R-old"], "runs order by creation, with run id as tie breaker");
      assert.deepEqual((await hive.call("tasks.list", { project: "app", status: "review" }, admin)).map((t) => t.id), ["T-3"]);
      assert.deepEqual((await hive.call("tasks.list", { projects: ["other"] }, admin)).map((t) => t.id), ["T-2"]);
      assert.deepEqual((await hive.call("runs.list", { project: "app", limit: 1 }, admin)).map((r) => r.runId), ["R-a"]);
      assert.deepEqual((await hive.call("runs.list", { projects: ["other"] }, admin)).map((r) => r.runId), ["R-b"]);

      // Capture the real handler SQL so the plan assertions follow future query changes.
      const sql: string[] = [];
      const db = hive.db;
      const prepare = db.prepare;
      db.prepare = function (query) { sql.push(query); return prepare.call(this, query); };
      try {
        await hive.call("tasks.list", {}, admin);
        await hive.call("runs.list", {}, admin);
        await hive.call("runs.requests", {}, admin);
      } finally { db.prepare = prepare; }
      const explain = (query: string, args: Array<string | number | null>) => db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...args).map((r) => String(r.detail));
      const taskPlan = explain(sql.find((q) => q.startsWith("SELECT * FROM tasks WHERE"))!, [null, null, null]);
      const runPlan = explain(sql.find((q) => q.startsWith("SELECT r.*"))!, [null, 200, null]);
      assert.ok(taskPlan.some((s) => s.includes("tasks_list_at")));
      assert.ok(!taskPlan.some((s) => s.includes("TEMP B-TREE FOR ORDER BY")));
      assert.ok(runPlan.some((s) => s.includes("run_records_created")));
      const outerSort = db.prepare(`EXPLAIN QUERY PLAN ${sql.find((q) => q.startsWith("SELECT r.*"))!}`).all(null, 200, null);
      assert.ok(!outerSort.some((r) => r.parent === 0 && String(r.detail).includes("TEMP B-TREE FOR ORDER BY")), "the request selection subquery may sort, the run history must not");
      assert.ok(explain(sql.find((q) => q.startsWith("UPDATE run_requests SET status = 'expired'"))!, [now().toISOString(), now().toISOString()]).some((s) => s.includes("run_requests_pending_at")));
      assert.ok(explain(sql.find((q) => q.startsWith("DELETE FROM run_requests WHERE status <> 'pending'"))!, [now().toISOString()]).some((s) => s.includes("run_requests_retention_at")));
    } finally {
      hive?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps expiration and retention semantics, including requests pinned by waiting plans", async () => {
    const hive = new SqliteHive(":memory:", { now });
    try {
      const add = hive.db.prepare("INSERT INTO run_requests(id, machine_id, machine, project, task_id, task_title, role, status, requested_by, requested_at, updated_at) VALUES (?, 'runner', 'machine', 'app', 'T-1', 'First', 'implement', ?, 'audit', ?, ?)");
      const recent = now().toISOString();
      const late = "2026-10-07T04:00:00.000Z";
      const old = "2026-09-01T00:00:00.000Z";
      add.run(1, "pending", late, late);
      add.run(2, "pending", recent, recent);
      add.run(3, "accepted", old, old);
      add.run(4, "accepted", old, old);
      add.run(5, "pending", old, old);
      hive.db.prepare("INSERT INTO implementation_plans(project, task_id, machine_id, request_id, status, created_at) VALUES ('app', 'T-1', 'runner', 4, 'waiting', ?)").run(old);
      const requests = await hive.call("runs.requests", { project: "app" }, admin);
      assert.deepEqual(requests.map((r) => [r.id, r.status]), [[5, "expired"], [4, "accepted"], [2, "pending"], [1, "expired"]]);
      assert.equal(hive.db.prepare("SELECT COUNT(*) AS n FROM run_requests WHERE id = 3").get()!.n, 0);
      assert.equal(hive.db.prepare("SELECT status FROM implementation_plans WHERE request_id = 4").get()!.status, "waiting");
    } finally { hive.close(); }
  });
});
