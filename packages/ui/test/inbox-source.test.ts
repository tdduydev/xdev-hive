import assert from "node:assert/strict";
import { it } from "node:test";
import type { HiveClient } from "#ui/client.ts";
import { allInboxSources, allDispatchTasks } from "#ui/lib/inbox-source.ts";
import { buildInbox } from "#ui/lib/inbox.ts";
import { SqliteHive } from "@xdev-hive/core/node";

it("loads every actionable page into the shared Today/sidebar list and dispatch link", async () => {
  const hive = new SqliteHive(":memory:");
  const actor = { name: "test", role: "admin" as const };
  const call: HiveClient["call"] = (method, input) => hive.call(method, input, actor);
  try {
    const at = "2026-10-07T05:00:00.000Z";
    const add = hive.db.prepare("INSERT INTO tasks(id, project, title, status, kind, updated_at) VALUES (?, 'app', ?, ?, 'small-fix', ?)");
    const addRun = hive.db.prepare("INSERT INTO run_records(machine_id, run_id, machine, project, task_id, task_title, role, status, summary, created_at, updated_at) VALUES ('machine', ?, 'machine', 'app', ?, ?, 'implement', 'done', 'Please confirm', ?, ?)");
    for (let i = 0; i < 1101; i++) {
      add.run(`review-${i}`, `Review ${i}`, "review", at);
      add.run(`fast-${i}`, `Fast ${i}`, "todo", at);
      addRun.run(`R-${i}`, `review-${i}`, `Review ${i}`, at, at);
    }
    const source = await allInboxSources({ call }, { project: "app" });
    const items = buildInbox({ reviewTasks: source.tasks, hubRuns: source.runs });
    assert.equal(items.filter((i) => i.kind === "review").length, 1101);
    assert.equal(items.filter((i) => i.kind === "waitingRun").length, 1101);
    assert.equal(new Set(items.map((i) => i.key)).size, 2202);
    assert.equal((await allInboxSources({ call }, { projects: [] })).tasks.length, 0);
    assert.equal((await allInboxSources({ call }, { project: "app" }, false)).runs.length, 0);
    await call("sdlc.setProject", { project: "app", settings: { gates: {}, fastLaneKinds: ["small-fix"] } });
    const aggregate = await call("sdlc.dispatch", { project: "app", limit: 1 });
    const dispatch = await allDispatchTasks({ call }, { project: "app" });
    assert.equal(aggregate.total, 1101);
    assert.equal(dispatch.length, aggregate.total);
    assert.equal(new Set(dispatch.map((t) => t.id)).size, 1101);
    assert.ok(dispatch.every((t) => t.id.startsWith("fast-")));
  } finally { hive.close(); }
});

it("propagates a later page failure instead of showing a partial total", async () => {
  let calls = 0;
  const call = (async () => {
    if (++calls > 1) throw new Error("page failed");
    return { tasks: [], runs: [], total: 501 };
  }) as HiveClient["call"];
  await assert.rejects(allInboxSources({ call }, {}, false), /page failed/);
});
