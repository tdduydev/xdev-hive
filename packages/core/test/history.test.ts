import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SqliteHive } from "#core/node.ts";
import type { Actor } from "#core/index.ts";

const admin: Actor = { name: "admin", role: "admin" };
const reader: Actor = { name: "reader", role: "member", access: { projects: { app: "viewer" } } };
const at = "2026-10-08T00:00:00.000Z";
function fixture() {
  const hive = new SqliteHive(":memory:");
  for (const project of ["app", "hidden"]) {
    hive.db.prepare("INSERT INTO run_records(machine_id, run_id, machine, project, task_id, task_title, role, status, summary, created_at, updated_at) VALUES (?, ?, 'mini', ?, 'T-1', 'Đối soát 100%_', 'implement', 'succeeded', 'needle run', ?, ?)").run('mini', project, project, at, at);
    hive.db.prepare("INSERT INTO sdlc_gates(project, task_id, gate, mode, status, note, created_at) VALUES (?, 'T-1', 'merge', 'human', 'passed', 'needle gate', ?)").run(project, at);
    const thread = hive.db.prepare("INSERT INTO chat_threads(project, title, machine_id, machine, created_by, created_at, updated_at) VALUES (?, 'Discussion', 'mini', 'mini', 'lan', ?, ?)").run(project, at, at);
    hive.db.prepare("INSERT INTO chat_messages(thread_id, role, author, text, created_at, updated_at) VALUES (?, 'user', 'lan', 'needle chat', ?, ?)").run(thread.lastInsertRowid, at, at);
  }
  hive.audit(admin, "needle audit", "hidden");
  const thread = hive.db.prepare("INSERT INTO chat_threads(project, title, machine_id, machine, created_by, created_at, updated_at) VALUES ('*', 'Hub secret', 'mini', 'mini', 'admin', ?, ?)").run(at, at);
  hive.db.prepare("INSERT INTO chat_messages(thread_id, role, author, text, created_at, updated_at) VALUES (?, 'user', 'admin', 'needle hub', ?, ?)").run(thread.lastInsertRowid, at, at);
  return hive;
}

describe("history.list", () => {
  it("filters grants, hub chat and audit before pagination, with stable ties", async () => {
    const hive = fixture();
    try {
      const all = await hive.call("history.list", { query: "needle" }, reader);
      assert.equal(all.entries.length, 3);
      assert.ok(all.entries.every(e => e.project === "app" && e.kind !== "audit"));
      const paged = [];
      for (let offset = 0; offset < 3; offset++) {
        const page = await hive.call("history.list", { query: "needle", offset, limit: 1 }, reader);
        assert.equal(page.hasMore, offset < 2);
        paged.push(...page.entries);
      }
      assert.deepEqual(paged, all.entries);
      assert.equal((await hive.call("history.list", { project: "hidden" }, reader)).entries.length, 0);
      const elevated = await hive.call("history.list", {}, admin);
      assert.ok(elevated.entries.some(e => e.kind === "audit"));
      assert.ok(elevated.entries.some(e => e.project === "*"));
      const projectAdmin: Actor = { ...reader, role: "admin" };
      assert.ok((await hive.call("history.list", {}, projectAdmin)).entries.every(e => e.project === "app"));
      const unrestricted: Actor = { name: "viewer", role: "viewer" };
      assert.ok((await hive.call("history.list", {}, unrestricted)).entries.every(e => e.kind !== "audit" && e.project !== "*"));
    } finally { hive.close(); }
  });
  it("searches Vietnamese case and literal wildcards, narrows source/task/date/scope", async () => {
    const hive = fixture();
    try {
      const result = await hive.call("history.list", { projects: ["app"], query: "đỐI SOÁT 100%_", kind: "run", taskId: "T-1", since: at, until: at }, admin);
      assert.equal(result.entries.length, 1);
      assert.match(result.entries[0]!.href, /^#\/runs\?run=mini%2Fapp$/);
      assert.equal((await hive.call("history.list", { projects: [], query: "needle" }, admin)).entries.length, 0);
      assert.equal((await hive.call("history.list", { since: "2027-01-01T00:00:00.000Z" }, reader)).entries.length, 0);
      assert.equal((await hive.call("history.list", { taskId: "missing" }, reader)).entries.length, 0);
      assert.equal((await hive.call("history.list", { project: "app", kind: "audit" }, admin)).entries.length, 0);
    } finally { hive.close(); }
  });
  it("hides research runs whose source projects are outside the caller grants", async () => {
    const hive = fixture();
    try {
      hive.db.prepare("INSERT INTO research_runs(id, project, input, projects, request_id, doc_key) VALUES (1, 'app', ?, ?, 1, 'project/app/research')").run(JSON.stringify({ scope: "project" }), JSON.stringify(["app", "hidden"]));
      hive.db.prepare("UPDATE run_records SET task_id = 'research-1', role = 'research' WHERE project = 'app'").run();
      assert.equal((await hive.call("history.list", { kind: "run", limit: 1 }, reader)).entries.length, 0);
      assert.equal((await hive.call("history.list", { kind: "run", project: "app" }, admin)).entries.length, 1);
    } finally { hive.close(); }
  });
  it("hides archived projects unless requested by name", async () => {
    const hive = fixture();
    try {
      await hive.call("projects.archive", { project: "app" }, admin);
      assert.equal((await hive.call("history.list", {}, reader)).entries.length, 0);
      assert.equal((await hive.call("history.list", { project: "app" }, reader)).entries.length, 3);
    } finally { hive.close(); }
  });
});
