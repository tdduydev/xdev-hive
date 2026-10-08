import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SqliteHive, migrationIndex } from "#core/node.ts";
import { HiveError, type Actor } from "#core/index.ts";

const admin: Actor = { name: "qa", role: "admin" };
const spec = "# Feature\n## Acceptance criteria\n- AC-1: A member can share verification\n";
const source = { specDir: "001-feature", specBranch: "ai/APP-1" };
const scope = { project: "app", taskId: "APP-1", specHash: createHash("sha256").update(spec).digest("hex"), commitSha: "b".repeat(40) };
const result = { ...scope, ...source, criterionId: "AC-1", criterion: "AC-1: A member can share verification", outcome: "passed" as const, note: "Verified after reload" };
async function publish(hive: SqliteHive, commit = scope.commitSha, text = spec) {
  await hive.call("specs.push", { project: scope.project, features: [{ dir: source.specDir, branch: source.specBranch, commit, files: { spec: text, plan: null, tasks: null } }] }, admin);
}

it("retains the verified file after reload, retention cleanup and attempted replacement", async t => {
  const directory = mkdtempSync(join(tmpdir(), "hive-evidence-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "hive.db");
  let now = Date.parse("2026-10-01T00:00:00Z");
  let hive = new SqliteHive(file, { now: () => new Date(now) });
  t.after(() => hive.close());
  hive.seed("hub");
  await hive.call("tasks.create", { id: scope.taskId, project: scope.project, title: "Feature" }, admin);
  await publish(hive);
  const runner: Actor = { name: "runner.test", role: "agent" };
  const upload = { project: scope.project, taskId: scope.taskId, runId: "R-1", name: "report.md", data: Buffer.from("Verified bytes").toString("base64") };
  const artifact = await hive.call("artifacts.put", upload, runner);
  await hive.call("evidence.record", { ...result, artifactIds: [artifact.id] }, admin);
  await hive.call("tasks.update", { id: scope.taskId, status: "done" }, admin);
  hive.close();
  now += 40 * 24 * 60 * 60 * 1000;
  hive = new SqliteHive(file, { now: () => new Date(now) });
  assert.deepEqual(await hive.pruneArtifacts(), { removed: 0, bytes: 0 });
  const pinned = (e: unknown) => e instanceof HiveError && e.key === "errors.evidenceArtifactPinned";
  await assert.rejects(hive.call("artifacts.remove", { id: artifact.id }, admin), pinned);
  await assert.rejects(hive.call("artifacts.put", { ...upload, data: Buffer.from("Changed bytes").toString("base64") }, runner), pinned);
  assert.equal((await hive.call("artifacts.get", { id: artifact.id }, admin))?.data, upload.data);
  assert.equal((await hive.call("evidence.list", scope, admin))[0]?.artifacts[0]?.sha256, artifact.sha256);
});

it("keeps an append-only shared history bound to the exact spec and code revisions", async t => {
  const hive = new SqliteHive(":memory:");
  t.after(() => hive.close());
  await hive.call("tasks.create", { id: "APP-1", project: "app", title: "Feature" }, admin);
  await publish(hive);
  const first = await hive.call("evidence.record", result, admin);
  await hive.call("evidence.record", { ...result, outcome: "failed", note: "Second verification failed" }, admin);
  const rows = await hive.call("evidence.list", scope, admin);
  assert.deepEqual(rows.map(r => r.outcome), ["failed", "passed"]);
  assert.equal(rows[1]?.recordedBy, "qa");
  assert.equal(rows[1]?.id, first.id);
  assert.deepEqual(await hive.call("evidence.list", { ...scope, commitSha: "c".repeat(40) }, admin), []);
  assert.deepEqual(await hive.call("evidence.list", { ...scope, specHash: "d".repeat(64) }, admin), []);
  assert.throws(() => hive.db.prepare("UPDATE acceptance_evidence SET outcome = 'passed' WHERE id = ?").run(first.id), /immutable/);
});

it("refuses unauthorized verification and cross-project or cross-task evidence", async t => {
  const hive = new SqliteHive(":memory:");
  t.after(() => hive.close());
  await hive.call("tasks.create", { id: "APP-1", project: "app", title: "Feature" }, admin);
  await publish(hive);
  await assert.rejects(hive.call("evidence.record", result, { name: "reader", role: "viewer" }), e => e instanceof HiveError && e.code === "forbidden");
  await assert.rejects(hive.call("evidence.record", { ...result, project: "other" }, admin), e => e instanceof HiveError && e.code === "not_found");
  await assert.rejects(hive.call("evidence.record", { ...result, artifactIds: [999] }, admin), e => e instanceof HiveError && e.code === "not_found");
  for (const [project, taskId] of [["app", "APP-2"], ["other", "OTHER-1"]]) {
    await hive.call("tasks.create", { id: taskId!, project: project!, title: "Another task" }, admin);
    const artifact = await hive.call("artifacts.put", { project: project!, taskId: taskId!, runId: `R-${taskId}`, name: "report.md", data: Buffer.from("Other task result").toString("base64") }, admin);
    await assert.rejects(hive.call("evidence.record", { ...result, artifactIds: [artifact.id] }, admin), e => e instanceof HiveError && e.code === "not_found");
  }
  assert.deepEqual(await hive.call("evidence.list", scope, admin), []);
});

it("lets project QA verify while members read and outsiders cannot discover results", async t => {
  const hive = new SqliteHive(":memory:");
  t.after(() => hive.close());
  await hive.call("tasks.create", { id: scope.taskId, project: scope.project, title: "Feature" }, admin);
  await publish(hive);
  const qa: Actor = { name: "verifier", role: "member", access: { projects: { app: "qa" } } };
  const member: Actor = { name: "member", role: "member", access: { projects: { app: "member" } } };
  const outsider: Actor = { name: "outsider", role: "member", access: { projects: { other: "qa" } } };
  await hive.call("evidence.record", result, qa);
  assert.equal((await hive.call("evidence.list", scope, member))[0]?.recordedBy, qa.name);
  assert.equal((await hive.call("admin.audit", {}, admin)).find(row => row.action === "evidence.record")?.actor, qa.name);
  await assert.rejects(hive.call("evidence.record", result, member), e => e instanceof HiveError && e.code === "forbidden");
  await assert.rejects(hive.call("evidence.list", scope, outsider), e => e instanceof HiveError && e.code === "not_found");
  await assert.rejects(hive.call("evidence.record", result, outsider), e => e instanceof HiveError && e.code === "not_found");
});

it("derives revisions on the hub and refuses stale spec/code without carrying results forward", async t => {
  const hive = new SqliteHive(":memory:");
  t.after(() => hive.close());
  await hive.call("tasks.create", { id: scope.taskId, project: scope.project, title: "Feature" }, admin);
  await publish(hive);
  assert.deepEqual(await hive.call("evidence.context", { project: scope.project, taskId: scope.taskId, ...source }, admin), { ...scope, ...source, specText: spec });
  await assert.rejects(hive.call("evidence.record", { ...result, criterion: "Invented criterion" }, admin), e => e instanceof HiveError && e.key === "errors.evidenceCriterionMissing");
  await assert.rejects(hive.call("evidence.record", { ...result, criterionId: "AC-999" }, admin), e => e instanceof HiveError && e.key === "errors.evidenceCriterionMissing");
  await hive.call("evidence.record", result, admin);
  await publish(hive, "c".repeat(40), spec + "- New requirement\n");
  await assert.rejects(hive.call("evidence.record", result, admin), e => e instanceof HiveError && e.key === "errors.evidenceRevisionChanged");
  const next = await hive.call("evidence.context", { project: scope.project, taskId: scope.taskId, ...source }, admin);
  assert.equal(next?.commitSha, "c".repeat(40));
  assert.notEqual(next?.specHash, scope.specHash);
  assert.deepEqual(await hive.call("evidence.list", next!, admin), []);
  assert.equal((await hive.call("evidence.list", scope, admin)).length, 1);
  const history = await hive.call("evidence.list", { project: scope.project, taskId: scope.taskId, ...source }, admin);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.commitSha, scope.commitSha);
  assert.deepEqual(await hive.call("evidence.list", { project: scope.project, taskId: scope.taskId, ...source, specDir: "002-other" }, admin), []);
  await publish(hive, "abcd1234");
  assert.equal(await hive.call("evidence.context", { project: scope.project, taskId: scope.taskId, ...source }, admin), null);
});

it("adds evidence to an existing database without losing tasks or specifications", async t => {
  const directory = mkdtempSync(join(tmpdir(), "hive-evidence-migration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "hive.db");
  const before = new SqliteHive(file, { migrateTo: migrationIndex("CREATE TABLE acceptance_evidence(") });
  await before.call("tasks.create", { id: scope.taskId, project: scope.project, title: "Existing task" }, admin);
  await publish(before);
  before.close();
  const after = new SqliteHive(file);
  t.after(() => after.close());
  assert.equal((await after.call("tasks.list", { project: scope.project }, admin))[0]?.title, "Existing task");
  assert.equal((await after.call("specs.get", { project: scope.project, dir: source.specDir, branch: source.specBranch }, admin))?.files.spec, spec);
  await after.call("evidence.record", result, admin);
  assert.equal((await after.call("evidence.list", scope, admin)).length, 1);
});

it("removes evidence with an explicitly deleted project and keeps other projects intact", async t => {
  const hive = new SqliteHive(":memory:", { backup: async () => ({ file: "/backups/hub.db" }) });
  t.after(() => hive.close());
  hive.seed("hub");
  await hive.call("tasks.create", { id: scope.taskId, project: scope.project, title: "Feature" }, admin);
  await hive.call("tasks.create", { id: "OTHER-1", project: "other", title: "Keep this" }, admin);
  await publish(hive);
  const artifact = await hive.call("artifacts.put", { project: scope.project, taskId: scope.taskId, runId: "R-1", name: "report.md", data: Buffer.from("Verified").toString("base64") }, admin);
  await hive.call("evidence.record", { ...result, artifactIds: [artifact.id] }, admin);
  await hive.call("projects.archive", { project: scope.project }, admin);
  await hive.call("projects.delete", { project: scope.project, confirm: scope.project }, admin);
  assert.equal(hive.db.prepare("SELECT COUNT(*) AS n FROM acceptance_evidence").get()?.n, 0);
  assert.equal(await hive.call("artifacts.get", { id: artifact.id }, admin), null);
  assert.equal((await hive.call("tasks.list", { project: "other" }, admin))[0]?.id, "OTHER-1");
});

it("finds old feature tasks beyond the board cap without exposing another project's dependencies", async t => {
  let now = Date.parse("2026-10-01T00:00:00Z");
  const hive = new SqliteHive(":memory:", { now: () => new Date(now) });
  t.after(() => hive.close());
  await hive.call("systems.save", { name: "suite", projects: [scope.project, "other"] }, admin);
  await hive.call("tasks.create", { id: "PRIVATE-1", project: "other", title: "Private dependency" }, admin);
  await hive.call("tasks.create", { id: scope.taskId, project: scope.project, title: "Old feature task", dependsOn: ["PRIVATE-1"] }, admin);
  for (let i = 0; i < 501; i++) {
    now += 1000;
    await hive.call("tasks.create", { id: `UNRELATED-${i}`, project: scope.project, title: "Unrelated newer work" }, admin);
  }
  const member: Actor = { name: "member", role: "member", access: { projects: { app: "member" } } };
  assert.ok(!(await hive.call("tasks.list", { project: scope.project }, member)).some(task => task.id === scope.taskId));
  const tasks = await hive.call("evidence.tasks", { project: scope.project, ...source }, member);
  assert.deepEqual(tasks.map(task => task.id), [scope.taskId]);
  assert.ok(!tasks[0]?.dependsOn.includes("PRIVATE-1"));
  await assert.rejects(hive.call("evidence.tasks", { project: "other", ...source }, member), e => e instanceof HiveError && e.code === "not_found");
});
