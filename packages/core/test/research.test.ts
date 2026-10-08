import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { HiveError, type Actor, type ResearchInput } from "#core/index.ts";
import { SqliteHive, migrationIndex } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const machine: Actor = { name: "runner.mini@mini", role: "agent" };
const manager: Actor = { name: "lan", role: "member", access: { projects: { app: "manage" } } };
const reader: Actor = { name: "dev", role: "member", access: { projects: { app: "contribute" } } };
const outsider: Actor = { name: "other", role: "member", access: { projects: { other: "manage" } } };
const input: ResearchInput = { project: "app", topic: "So sánh lưu trữ", questions: ["Chọn phương án nào?"], scope: "service", sources: ["repo", "hive", "web"], format: "comparison", machineId: machine.name, profileId: null };
const profile = { id: "claude-1", label: "Claude", kind: "claude", enabled: true, installed: true, research: true, account: null, cooldownUntil: null, runs: 0, rateLimited: 0 };
async function beat(hive: SqliteHive, research = true) {
  return hive.call("machines.heartbeat", { machine: "mini", instance: "aabbccdd", projects: ["app", "other"], profiles: [{ ...profile, research }], acceptsRuns: true }, machine);
}
async function report(hive: SqliteHive, id: number, requestId: number) {
  await hive.call("runs.requestResult", { id: requestId, status: "accepted", runId: "R-research" }, machine);
  const artifact = await hive.call("artifacts.put", { project: "app", taskId: `research-${id}`, runId: "R-research", name: "report.md", data: Buffer.from("# Báo cáo\nChọn SQLite.\n").toString("base64") }, machine);
  return artifact;
}

describe("research from chat", () => {
  it("proposes, confirms once, queues without a board task, saves an artifact and a pending draft", async () => {
    const hive = new SqliteHive(":memory:");
    try {
      await beat(hive);
      const sent = await hive.call("chat.send", { project: "app", machineId: machine.name, text: "Nghiên cứu lưu trữ" }, manager);
      const leader = { ...manager, chatReply: sent.reply.id };
      const { machineId: _, ...request } = input;
      const action = await hive.call("chat.propose", { action: { ...request, kind: "research.start" }, reason: "Đọc trước khi lập kế hoạch" }, leader);
      assert.equal(action.status, "proposed");
      assert.equal(hive.db.prepare("SELECT COUNT(*) AS n FROM research_runs").get()!.n, 0);
      const made = await hive.call("chat.decide", { actionId: action.id, accept: true }, manager);
      const id = made.result!.researchId!;
      assert.equal(made.status, "done");
      await assert.rejects(hive.call("chat.decide", { actionId: action.id, accept: true }, manager), { code: "conflict" });
      assert.deepEqual(await hive.call("tasks.list", { project: "app" }, admin), []);
      const [run] = (await beat(hive)).runRequests!;
      assert.equal(run!.role, "research");
      const artifact = await report(hive, id, run!.id);
      const done = await hive.call("research.finish", { id, artifactId: artifact.id, sources: ["README.md", "project/app/architecture"], recommendations: "Tạo task với test." }, machine);
      assert.equal(done.status, "done");
      assert.equal(done.artifactId, artifact.id);
      assert.equal(done.docKey, `project/app/research/research-${id}`);
      assert.equal(await hive.call("docs.get", { key: done.docKey }, manager), null, "approval required before publishing");
      const drafts = await hive.call("proposals.list", {}, manager);
      const draft = drafts.find(p => p.id === done.proposalId)!;
      assert.equal(draft.status, "pending");
      assert.equal(draft.baseVersion, 0);
      assert.match(draft.content, /Chọn SQLite/);
      assert.equal(hive.db.prepare("SELECT on_behalf FROM proposals WHERE id = ?").get(draft.id)!.on_behalf, manager.name);
      assert.deepEqual(await hive.call("research.finish", { id, artifactId: artifact.id, sources: [], recommendations: "" }, machine), done, "retries do not duplicate the draft");
      await assert.rejects(hive.call("research.get", { id }, outsider), { code: "not_found" });
      await assert.rejects(hive.call("research.finish", { id, artifactId: artifact.id, sources: [], recommendations: "" }, { name: "runner.other@other", role: "agent" }), { code: "forbidden" });
      const audit = await hive.call("admin.audit", {}, admin);
      assert.ok(audit.some(a => a.action === "research.start"));
      assert.ok(audit.some(a => a.action === "proposals.create" && a.target === done.docKey));
    } finally { hive.close(); }
  });

  it("checks dispatch rights, runner capability, scope, archived projects and report ownership", async () => {
    const hive = new SqliteHive(":memory:");
    try {
      await beat(hive, false);
      await assert.rejects(hive.call("research.start", input, manager), /research-capable/);
      await beat(hive);
      await assert.rejects(hive.call("research.start", input, reader), { code: "forbidden" });
      await assert.rejects(hive.call("research.start", { ...input, scope: "hub" }, manager), { code: "forbidden" });
      await assert.rejects(hive.call("research.start", { ...input, scope: "system", system: "unknown" }, manager), { code: "bad_request" });
      await hive.call("systems.save", { name: "shop", projects: ["app", "other"] }, admin);
      const scoped = { name: "lead", role: "member", access: { projects: { app: "manage", other: "view" }, systems: { shop: "manage" } } } as Actor;
      const system = await hive.call("research.start", { ...input, scope: "system", system: "shop" }, scoped);
      assert.equal(system.docKey, `system/shop/research/research-${system.id}`);
      assert.deepEqual(system.projects, ["app", "other"]);
      const own = await hive.call("research.start", input, manager);
      const artifact = await report(hive, own.id, own.requestId);
      const foreign = await hive.call("artifacts.put", { project: "app", taskId: `research-${own.id}`, runId: "R-other", name: "report.md", data: Buffer.from("Wrong run").toString("base64") }, machine);
      await assert.rejects(hive.call("research.finish", { id: own.id, artifactId: foreign.id, sources: [], recommendations: "" }, machine), { code: "bad_request" });
      await assert.rejects(hive.call("research.finish", { id: own.id, artifactId: artifact.id, sources: [], recommendations: "GITLAB_TOKEN=glpat-" + "x".repeat(24) }, machine), HiveError);
      assert.equal((await hive.call("research.get", { id: own.id }, manager)).proposalId, null);
      await hive.call("projects.archive", { project: "app" }, admin);
      await assert.rejects(hive.call("research.start", input, manager), { code: "conflict" });
    } finally { hive.close(); }
  });

  it("upgrades an existing full database by only the research migration", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hive-research-"));
    const file = path.join(dir, "hive.db");
    try {
      const current = new SqliteHive(file);
      await current.call("tasks.create", { id: "KEEP", project: "app", title: "Keep" }, admin);
      const version = migrationIndex("CREATE TABLE research_runs(");
      // The terminal and machine identity migrations came later and replay too.
      current.db.exec("DROP TABLE acceptance_evidence; ALTER TABLE run_records DROP COLUMN head_sha");
      current.db.exec(`DROP TABLE research_runs; DROP TABLE terminal_audit_chunks; DROP TABLE terminal_stepups; DROP TABLE terminal_tickets; DROP TABLE terminal_sessions; ALTER TABLE machines DROP COLUMN terminal_capability; ALTER TABLE machines DROP COLUMN token_id; PRAGMA user_version = ${version}`);
      current.close();
      const upgraded = new SqliteHive(file);
      try {
        assert.equal((await upgraded.call("tasks.list", { project: "app" }, admin))[0]!.id, "KEEP");
        await beat(upgraded);
        assert.equal((await upgraded.call("research.start", input, manager)).status, "pending");
      } finally { upgraded.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps multi-service evidence private across requests, runs, artifacts and drafts", async () => {
    const hive = new SqliteHive(":memory:");
    try {
      await beat(hive);
      await hive.call("systems.save", { name: "shop", projects: ["app", "other"] }, admin);
      const research = await hive.call("research.start", { ...input, scope: "system", system: "shop" }, admin);
      assert.equal((await hive.call("runs.requests", { project: "app" }, manager)).length, 0);
      const artifact = await report(hive, research.id, research.requestId);
      await hive.call("machines.heartbeat", { machine: "mini", instance: "aabbccdd", runs: [{ runId: "R-research", project: "app", taskId: `research-${research.id}`, taskTitle: input.topic, role: "research", status: "running", profileId: profile.id, since: "2026-10-07T01:00:00Z" }] }, machine);
      assert.equal((await hive.call("machines.list", {}, manager))[0]!.runs.length, 0);
      assert.equal((await hive.call("machines.list", {}, admin))[0]!.runs.length, 1);
      await hive.call("runs.push", { machine: "mini", runs: [{ runId: "R-research", project: "app", taskId: `research-${research.id}`, taskTitle: input.topic, role: "research", status: "running", profileId: profile.id, log: "Evidence from other", createdAt: "2026-10-07T01:00:00Z" }] }, machine);
      const done = await hive.call("research.finish", { id: research.id, artifactId: artifact.id, sources: ["other/secret-scope.md"], recommendations: "Scoped findings" }, machine);
      await assert.rejects(hive.call("research.get", { id: research.id }, manager), { code: "not_found" });
      assert.equal((await hive.call("runs.list", { project: "app" }, manager)).length, 0);
      assert.equal(await hive.call("runs.get", { machineId: machine.name, runId: "R-research" }, manager), null);
      assert.equal((await hive.call("artifacts.list", { project: "app" }, manager)).length, 0);
      await assert.rejects(hive.call("artifacts.get", { id: artifact.id }, manager), { code: "not_found" });
      assert.equal((await hive.call("proposals.list", {}, manager)).length, 0);
      await assert.rejects(hive.call("proposals.approve", { id: done.proposalId! }, manager), { code: "not_found" });
      assert.equal((await hive.call("research.get", { id: research.id }, admin)).status, "done");
      assert.equal((await hive.call("artifacts.list", { project: "app" }, admin)).length, 1);
      assert.equal((await hive.call("proposals.list", {}, admin)).length, 1);
    } finally { hive.close(); }
  });
});
