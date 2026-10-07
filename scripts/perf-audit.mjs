// Run with node scripts/perf-audit.mjs > .xdev-hive/artifacts/perf.json.
// --measure-migration seeds the preceding schema, then times its upgrade on the populated database.
// Every database is synthetic and removed on exit; no hub or machine is contacted.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { SqliteHive, migrationIndex } from "@xdev-hive/core/node";
import { buildInbox } from "@xdev-hive/ui/lib/inbox";
import { allPipelineFlows, stepCounts, FAST_KINDS } from "@xdev-hive/ui/lib/pipeline";

const dir = mkdtempSync(path.join(tmpdir(), "hive-perf-"));
const file = path.join(dir, "audit.db");
const now = new Date("2026-10-07T05:00:00.000Z");
const actor = { name: "audit", role: "admin" };
const measureMigration = process.argv.includes("--measure-migration");
let hive = new SqliteHive(file, { now: () => now, ...(measureMigration ? { migrateTo: migrationIndex("CREATE INDEX tasks_list_at") } : {}) });
let db = hive.db;
const project = (i) => `perf-${i % 10}`;
const machine = (i) => `runner@perf-${Math.floor(i / 10) % 200}`;
const task = (i) => `PERF-${i % 20_000}`;
const at = (i) => new Date(now.getTime() - (50_000 - i) * 1000).toISOString();
const round = (n) => Math.round(n * 1000) / 1000;
const call = (method, input = {}) => hive.call(method, input, actor);

try {
  const seedStart = performance.now();
  db.exec("BEGIN");
  const addMachine = db.prepare("INSERT INTO machines(id, machine, instance, last_seen, projects, accepts_runs, runs) VALUES (?, ?, 'synthetic', ?, ?, 1, ?)");
  for (let i = 0; i < 200; i++) addMachine.run(`runner@perf-${i}`, `perf-${i}`, now.toISOString(), JSON.stringify(Array.from({ length: 10 }, (_, j) => project(j))), "[]");
  const addTask = db.prepare("INSERT INTO tasks(id, project, title, status, kind, note, updated_at) VALUES (?, ?, ?, ?, 'small-fix', ?, ?)");
  const addDep = db.prepare("INSERT INTO task_deps(task_id, depends_on) VALUES (?, ?)");
  for (let i = 0; i < 20_000; i++) {
    addTask.run(task(i), project(i), `Synthetic task ${i}`, ["todo", "doing", "review", "done"][Math.floor(i / 10) % 4], "Synthetic handover. ".repeat(50), at(i));
    if (i >= 10) addDep.run(task(i), task(i - 10));
  }
  const addRun = db.prepare("INSERT INTO run_records(machine_id, run_id, machine, project, task_id, task_title, role, status, summary, log, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'implement', 'done', ?, ?, ?, ?)");
  const addRequest = db.prepare("INSERT INTO run_requests(machine_id, machine, project, task_id, task_title, role, status, run_id, requested_by, requested_at, updated_at, selection) VALUES (?, ?, ?, ?, ?, 'implement', 'accepted', ?, 'audit', ?, ?, ?)");
  for (let i = 0; i < 50_000; i++) {
    const runId = `R-${String(i).padStart(6, "0")}`;
    // The newest run for every task waits for input, including tasks outside the inbox's first page.
    addRun.run(machine(i), runId, machine(i).split("@")[1], project(i), task(i), `Synthetic task ${i % 20_000}`, "Please confirm synthetic result. ".repeat(10), "Synthetic log\n".repeat(150), at(i), at(i));
    addRequest.run(machine(i), machine(i).split("@")[1], project(i), task(i), `Synthetic task ${i % 20_000}`, runId, at(i), at(i), JSON.stringify({ reason: "synthetic audit" }));
  }
  const addMemory = db.prepare("INSERT INTO memory(project, kind, content, author, status, created_at) VALUES (?, 'gotcha', ?, 'audit', ?, ?)");
  for (let i = 0; i < 5000; i++) addMemory.run(project(i), `Synthetic benchmark memory ${i}. ` + "SQLite audit context. ".repeat(20), i % 11 === 0 ? "pending" : "approved", at(i));
  const addDoc = db.prepare("INSERT INTO docs(key, scope, project, title, content, version, updated_by, updated_at) VALUES (?, 'project', ?, ?, ?, 1, 'audit', ?)");
  for (let i = 0; i < 2000; i++) addDoc.run(`project/${project(i)}/doc-${i}`, project(i), `Synthetic doc ${i}`, "Synthetic document. ".repeat(200), at(i));
  const addFlow = db.prepare("INSERT INTO sdlc_flows(task_id, project, step, state, machine_id, created_by, created_at, updated_at) VALUES (?, ?, 'specify', 'done', ?, 'audit', ?, ?)");
  for (let i = 0; i < 2000; i++) addFlow.run(task(i), project(i), machine(i), at(i), at(i));
  const addFlowTask = db.prepare("INSERT INTO sdlc_flow_tasks(task_id, flow_task, project, stage, created_by, updated_at) VALUES (?, ?, ?, 'done', 'audit', ?)");
  for (let i = 2000; i < 3000; i++) addFlowTask.run(task(i), task(i - 2000), project(i), at(i));
  db.exec("COMMIT");
  const seedMs = round(performance.now() - seedStart);
  let migration = null;
  if (measureMigration) {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const beforeBytes = statSync(file).size;
    hive.close();
    const start = performance.now();
    hive = new SqliteHive(file, { now: () => now });
    db = hive.db;
    const ms = round(performance.now() - start);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    migration = { ms, beforeBytes, afterBytes: statSync(file).size };
  }
  const counts = Object.fromEntries(["tasks", "run_records", "run_requests", "memory", "docs", "machines", "task_deps", "sdlc_flows", "sdlc_flow_tasks"].map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
  assert.deepEqual(counts, { tasks: 20_000, run_records: 50_000, run_requests: 50_000, memory: 5000, docs: 2000, machines: 200, task_deps: 19_990, sdlc_flows: 2000, sdlc_flow_tasks: 1000 });

  const inbox = async (filter = {}) => {
    // Same hub sources and limits as packages/ui/src/shell/inbox.tsx; alerts are outside SqliteHive.
    const [proposals, cleanup, reviewTasks, memory, plans, gates, leader, hubRuns] = await Promise.all([
      call("proposals.list", { status: "pending" }), call("memory.cleanupProposals"), call("tasks.list", filter),
      call("memory.list", { limit: 500, ...filter, ...(Object.keys(filter).length ? { includeShared: true } : {}) }), call("runs.plans", { status: "waiting", limit: 200, ...filter }),
      call("sdlc.gates", { limit: 100, ...filter }), call("chat.pending", filter), call("runs.list", { limit: 200, ...filter }),
    ]);
    const sources = { proposals, cleanup, reviewTasks, assignedTasks: reviewTasks, memory, plans, gates, leader, hubRuns, principal: actor.name };
    return { sources, items: buildInbox(sources) };
  };
  const pipeline = async () => {
    const client = { call };
    const [flows, tasks, work, gates] = await Promise.all([
      allPipelineFlows(client, { project: "perf-0" }), call("sdlc.flowTasks", { project: "perf-0" }),
      call("tasks.list", { project: "perf-0" }), call("sdlc.gates", { project: "perf-0", limit: 200 }),
    ]);
    const counts = stepCounts(flows, tasks);
    const owned = new Set([...flows.map((f) => f.taskId), ...tasks.map((t) => t.taskId)]);
    counts.dispatch += work.filter((t) => !owned.has(t.id) && t.status === "todo" && FAST_KINDS.includes(t.kind)).length;
    return { sources: { flows, tasks, work, gates }, counts };
  };
  const cases = [];
  for (const [scope, filter] of [["all", {}], ["project", { project: "perf-0" }], ["system", { projects: ["perf-0", "perf-1", "perf-2"] }]]) {
    for (const [method, extra] of [["tasks.list", {}], ["runs.list", { limit: 200 }], ["runs.requests", { limit: 200 }]]) cases.push([`${method}/${scope}`, () => call(method, { ...filter, ...extra })]);
  }
  cases.push(["tasks.list/review", () => call("tasks.list", { project: "perf-0", status: "review" })],
    ["machines.list", () => call("machines.list")], ["docs.list/all", () => call("docs.list")], ["docs.list/project", () => call("docs.list", { project: "perf-0" })],
    ["memory.search/fts", () => call("memory.search", { project: "perf-0", query: "benchmark" })],
    ["memory.search/latest", () => call("memory.search", { project: "perf-0" })],
    ["inbox/all", () => inbox()], ["inbox/project", () => inbox({ project: "perf-0" })], ["pipeline/perf-0", pipeline]);

  const measurements = [];
  const plans = {};
  for (const [name, run] of cases) {
    process.stderr.write(`Measuring ${name}\n`);
    await run();
    const samples = [];
    const serialize = [];
    let result, bytes, sourceBytes;
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      result = await run();
      samples.push(performance.now() - start);
      const jsonStart = performance.now();
      bytes = Buffer.byteLength(JSON.stringify(result));
      serialize.push(performance.now() - jsonStart);
      sourceBytes = result.sources ? Object.values(result.sources).reduce((n, rows) => n + (typeof rows === "object" ? Buffer.byteLength(JSON.stringify(rows)) : 0), 0) : bytes;
    }
    // Trace a separate call so instrumentation does not inflate the timing samples.
    const prepare = db.prepare;
    const queries = new Map();
    db.prepare = function (sql) {
      const stmt = prepare.call(this, sql);
      for (const action of ["all", "get", "run"]) {
        const original = stmt[action];
        stmt[action] = function (...args) {
          const info = queries.get(sql) ?? { count: 0, ms: 0, args };
          const start = performance.now();
          try { return original.apply(this, args); }
          finally { info.count++; info.ms += performance.now() - start; queries.set(sql, info); }
        };
      }
      return stmt;
    };
    try { await run(); } finally { db.prepare = prepare; }
    const slow = [...queries.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8);
    plans[name] = slow.map(([sql, info]) => ({ sql, count: info.count, totalMs: round(info.ms), plan: /^(SELECT|UPDATE|DELETE)/i.test(sql.trim()) ? db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...info.args) : [] }));
    samples.sort((a, b) => a - b);
    serialize.sort((a, b) => a - b);
    measurements.push({ name, medianMs: round(samples[2]), maxMs: round(samples[4]), jsonMedianMs: round(serialize[2]), bytes, sourceBytes, rows: Array.isArray(result) ? result.length : result.items?.length ?? result.counts, sqlCalls: [...queries.values()].reduce((n, q) => n + q.count, 0) });
  }
  const allInbox = await inbox();
  const projectPipeline = await pipeline();
  const correctness = {
    reviewTasksInDb: db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'review'").get().n,
    reviewItemsInInbox: allInbox.items.filter((i) => i.kind === "review").length,
    newestWaitingRunsInDb: db.prepare(`SELECT COUNT(*) AS n FROM (
      SELECT summary, ROW_NUMBER() OVER (PARTITION BY project, task_id ORDER BY created_at DESC, run_id DESC) AS rank
      FROM run_records) WHERE rank = 1 AND summary LIKE '%Please confirm%'`).get().n,
    waitingRunItemsInInbox: allInbox.items.filter((i) => i.kind === "waitingRun").length,
    pipelineDispatchInDb: db.prepare("SELECT COUNT(*) AS n FROM tasks t WHERE project = 'perf-0' AND status = 'todo' AND kind = 'small-fix' AND NOT EXISTS (SELECT 1 FROM sdlc_flows f WHERE f.task_id = t.id) AND NOT EXISTS (SELECT 1 FROM sdlc_flow_tasks ft WHERE ft.task_id = t.id)").get().n,
    pipelineDispatchShown: projectPipeline.counts.dispatch,
  };
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  console.log(JSON.stringify({ environment: { node: process.version, sqlite: db.prepare("SELECT sqlite_version() AS v").get().v, cpu: cpus()[0]?.model, samples: 5, warmups: 1, actor: "unrestricted admin", embeddings: false, pipelineFastLaneKinds: FAST_KINDS, transport: "in-process (no HTTP, browser or network)" }, seedMs, migration, counts, dbBytes: statSync(file).size, measurements, correctness, plans }, null, 2));
} finally {
  try { hive.close(); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
