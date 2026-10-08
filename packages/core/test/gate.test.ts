import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  SqliteHive, migrationIndex, canonicalJson, gateGlobMatch, gateManifestHash, gateManifestSchema, gateOutcome, gateTemplateHash, gateTemplateSchema, expandGateArgv,
  type Actor, type GateManifest, type GateReceipt,
} from "#core/node.ts";

const person: Actor = { name: "duy", role: "member", account: "duy", humanSession: "sess-1", access: { projects: { app: "manage" } } };
const viewer: Actor = { name: "vi", role: "member", account: "vi", humanSession: "sess-2", access: { projects: { app: "view" } } };
const machine: Actor = { name: "runner.mini@duy", role: "agent", account: "duy" };
const other: Actor = { name: "runner.other@duy", role: "agent", account: "duy" };
const SHA = "a".repeat(40);
const manifest: GateManifest = {
  id: "desktop-smoke", version: 1, argv: ["npm", "run", "smoke", "-w", "@xdev-hive/desktop", "--", "{artifactDir}"], env: ["GH_TOKEN"],
  timeoutMinutes: 20, gui: true, resultFile: "result.json", artifacts: [{ glob: "*.png", required: true }], autoApprove: false,
};
const hash = gateManifestHash(manifest);
const cap = (m: GateManifest = manifest, h = hash, manifests = [{ hash: h, manifest: m as unknown }]) => ({
  protocol: 1, enabled: true, guiReady: true, busy: false,
  projects: [{ name: "app", autoApprove: false, templates: [{ id: m.id, version: m.version, hash: h, label: "Desktop smoke" }] }], manifests,
});
const beat = (h: SqliteHive, gate: unknown, who = machine) => h.call("machines.heartbeat", { machine: "mini", instance: "aabbccdd", projects: ["app"], gate }, who);

let clock = Date.parse("2026-10-08T00:00:00Z");
async function fixture(opts: { on?: boolean } = {}) {
  clock = Date.parse("2026-10-08T00:00:00Z");
  const h = new SqliteHive(":memory:", { gateJobs: opts.on ?? true, now: () => new Date(clock) });
  const reply = await beat(h, cap());
  assert.deepEqual(reply.gate, { ack: [hash], want: [] });
  return h;
}
const create = (h: SqliteHive, extra: Record<string, unknown> = {}, who = person) =>
  h.call("gate.create", { project: "app", machineId: machine.name, templateId: manifest.id, templateHash: hash, sha: SHA, ref: "main", purpose: "manual", idempotencyKey: "k1", ...extra }, who);

function receipt(jobId: string, over: Partial<GateReceipt> = {}): GateReceipt {
  return {
    jobId, project: "app", machineId: machine.name, templateId: manifest.id, templateHash: hash, sha: SHA, checkedSha: SHA, treeClean: true,
    startedAt: "2026-10-08T00:00:01Z", finishedAt: "2026-10-08T00:01:00Z", exitCode: 0, signal: null, timedOut: false,
    result: { ok: true, checks: [{ name: "smoke", ok: true }] }, artifacts: [], logSha256: "b".repeat(64), logTail: "", app: "0.147.0",
    os: { platform: "darwin", release: "25.0.0" }, gui: "aqua", outcome: "passed", reason: null, ...over,
  };
}
async function running(h: SqliteHive) {
  const job = await create(h);
  await h.call("gate.approve", { id: job.id, version: job.version, pass: true }, person);
  const taken = (await h.call("gate.take", { project: "app" }, machine))!;
  await h.call("gate.progress", { id: job.id, leaseToken: taken.leaseToken, step: "clone" }, machine);
  return taken;
}
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5e8b8c40000000049454e44ae426082", "hex");

describe("gate contract (69h1)", () => {
  it("hashes the manifest canonically, without the label, and keeps placeholders closed", () => {
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: null }] }), '{"a":[2,{"c":null,"d":1}],"b":1}');
    const t = gateTemplateSchema.parse({ ...manifest, label: "x" });
    assert.equal(gateTemplateHash(t), hash);
    assert.equal(gateTemplateHash({ ...t, label: "y" }), hash, "a label is outside the hash");
    assert.notEqual(gateManifestHash({ ...manifest, autoApprove: true }), hash, "turning on auto-approve changes the hash");
    for (const argv of [["{sha}"], ["x", "{sha}{jobId}"], ["x", "{sha}-{sha}"], ["x", "--a={artifactDir}/{jobId}"]]) assert.equal(gateManifestSchema.safeParse({ ...manifest, argv }).success, false, argv.join(" "));
    assert.ok(gateManifestSchema.safeParse({ ...manifest, argv: ["/bin/sh", "-c", "printf '{\"ok\":true}' > \"$1/r.json\"", "gate", "{artifactDir}"] }).success, "a script's own braces stay literal");
    assert.deepEqual(expandGateArgv(["x", "--out={artifactDir}/r", "{sha}"], { sha: SHA, jobId: "gj_x" }), ["x", "--out={artifactDir}/r", SHA]);
    assert.ok(gateGlobMatch("*.png", "a.png") && !gateGlobMatch("*.png", "d/a.png") && gateGlobMatch("**/*.png", "d/e/a.png") && gateGlobMatch("**/*.png", "a.png"));
    assert.ok(!gateGlobMatch("a.(png)", "a.png") && gateGlobMatch("a.(png)", "a.(png)"), "a glob is never a regular expression");
  });
  it("is red when the command or its result says so, even with every screenshot (AC09)", () => {
    const base = { exitCode: 0, signal: null, timedOut: false, cancelled: false, resultExpected: true, result: { ok: true }, missingRequired: 0, headMatches: true, treeClean: true } as const;
    assert.deepEqual(gateOutcome(base), { outcome: "passed", reason: null });
    assert.equal(gateOutcome({ ...base, exitCode: 1 }).reason, "exitNonZero");
    assert.equal(gateOutcome({ ...base, result: { ok: false } }).reason, "resultNotOk");
    assert.equal(gateOutcome({ ...base, result: { ok: true, checks: [{ name: "e2e", ok: false }] } }).reason, "resultNotOk");
    assert.equal(gateOutcome({ ...base, result: "invalid" }).reason, "resultInvalid");
    assert.equal(gateOutcome({ ...base, result: null }).reason, "resultInvalid");
    assert.equal(gateOutcome({ ...base, treeClean: false }).reason, "treeChanged");
    assert.equal(gateOutcome({ ...base, missingRequired: 1 }).reason, "artifactMissing");
    assert.equal(gateOutcome({ ...base, timedOut: true, exitCode: null, signal: "SIGTERM" }).reason, "timeout");
  });
});

describe("gate jobs on the hub (69h2)", () => {
  it("migrates a full database by replaying only the gate migration", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hive-gate-"));
    try {
      const file = path.join(dir, "db");
      const h = new SqliteHive(file);
      await h.call("tasks.create", { project: "app", id: "KEEP", title: "Preserved" }, { name: "admin", role: "admin" });
      const at = migrationIndex("CREATE TABLE gate_jobs");
      h.db.exec(`DROP TABLE gate_jobs; DROP TABLE gate_manifests; ALTER TABLE machines DROP COLUMN gate_capability; PRAGMA user_version = ${at}`);
      h.close();
      const upgraded = new SqliteHive(file, { migrateTo: at + 1, gateJobs: true });
      assert.equal((await upgraded.call("tasks.list", { project: "app" }, { name: "admin", role: "admin" })).length, 1);
      assert.deepEqual((await beat(upgraded, cap())).gate, { ack: [hash], want: [] });
      upgraded.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("keeps a manifest only when it hashes, parses, holds no secret and is in the same beat's index (G02)", async () => {
    const h = await fixture(); try {
      const changed = { ...manifest, version: 2 };
      const h2 = gateManifestHash(changed);
      assert.deepEqual((await beat(h, cap(changed, h2, [{ hash: h2, manifest: { ...changed, timeoutMinutes: 99 } }]))).gate, { ack: [], want: [h2] }, "a wrong hash is not kept");
      assert.deepEqual((await beat(h, cap(changed, h2, []))).gate, { ack: [], want: [h2] }, "what is missing is asked for again");
      const secret = { ...manifest, version: 3, argv: ["npm", "--token=ghp_" + "a".repeat(36)] };
      const h3 = gateManifestHash(secret);
      assert.deepEqual((await beat(h, cap(secret, h3))).gate, { ack: [], want: [h3] });
      assert.deepEqual((await beat(h, { ...cap(), projects: [], manifests: [{ hash: h2, manifest: changed }] })).gate, { ack: [], want: [] }, "outside the index");
      assert.deepEqual((await beat(h, cap(changed, h2))).gate, { ack: [h2], want: [] });
      assert.equal((await beat(h, { protocol: 9 })).gate?.ack.length, 0);
      await assert.rejects(create(h), /not ready/, "an old app's beat leaves the machine without templates");
    } finally { h.close(); }
  });
  it("lets only a person with project settings create and approve; never a bearer, run, MCP or chat (G01)", async () => {
    const h = await fixture(); try {
      for (const who of [machine, { ...person, humanSession: undefined }, { ...person, mcpCredential: true }, { ...person, chatReply: 1 },
        { ...person, runCredential: { project: "app", task: "T", run: "r", machine: "mini", readOnly: false } }, viewer] as Actor[]) await assert.rejects(create(h, {}, who), Error, JSON.stringify(who));
      const job = await create(h);
      assert.equal(job.state, "requested");
      assert.deepEqual(await create(h), job, "a retried create answers the same job");
      assert.throws(() => h.db.prepare("UPDATE gate_jobs SET sha = ? WHERE id = ?").run("b".repeat(40), job.id), /immutable/);
      await assert.rejects(create(h, { ref: "dev" }), /idempotency/);
      await assert.rejects(h.call("gate.approve", { id: job.id, version: job.version, pass: true }, machine));
      await assert.rejects(h.call("gate.approve", { id: job.id, version: job.version, pass: true }, viewer));
      assert.equal(await h.call("gate.take", { project: "app" }, machine), null, "nothing runs before a person approves");
      await assert.rejects(h.call("gate.approve", { id: job.id, version: job.version + 1, pass: true }, person), /changed/);
      const ok = await h.call("gate.approve", { id: job.id, version: job.version, pass: true }, person);
      assert.equal(ok.approval?.mode, "human");
      assert.equal(await h.call("gate.take", { project: "app" }, other), null, "another machine never gets it");
      const taken = await h.call("gate.take", { project: "app" }, machine);
      assert.equal(taken?.job.state, "claimed");
      await assert.rejects(h.call("gate.progress", { id: job.id, leaseToken: taken!.leaseToken, step: "x" }, other), /lease/);
      await assert.rejects(h.call("gate.progress", { id: job.id, leaseToken: `hivegate_${"A".repeat(43)}`, step: "x" }, machine), /lease/);
      await assert.rejects(h.call("gate.take", { project: "app" }, { ...machine, runCredential: { project: "app", task: "T", run: "r", machine: "mini", readOnly: false } }));
      assert.equal((await h.call("gate.get", { id: job.id }, { ...machine, mcpCredential: true })).id, job.id, "agents read results");
      assert.ok((await h.call("admin.audit", {}, { name: "admin", role: "admin" })).some((a) => a.action === "gate.approve"));
    } finally { h.close(); }
  });
  it("is off unless the hub turns it on", async () => {
    const h = await fixture({ on: false }); try { await assert.rejects(create(h), /HIVE_GATE_JOBS/); } finally { h.close(); }
  });
  it("accepts one receipt, idempotently, and never lets a red or changed run read as green (G03, G04)", async () => {
    const h = await fixture(); try {
      const { job, leaseToken } = await running(h);
      await assert.rejects(h.call("gate.result", { id: job.id, leaseToken, receipt: receipt(job.id, { exitCode: 1 }) }, machine), /facts/);
      await assert.rejects(h.call("gate.result", { id: job.id, leaseToken, receipt: receipt(job.id, { sha: "c".repeat(40) }) }, machine), /another job/);
      const missing = await h.call("gate.result", { id: job.id, leaseToken, receipt: receipt(job.id) }, machine);
      assert.deepEqual([missing.state, missing.reason], ["failed", "artifactMissing"], "a required screenshot is part of green");
      assert.deepEqual(await h.call("gate.result", { id: job.id, leaseToken, receipt: receipt(job.id) }, machine), missing, "the same receipt again");
      await assert.rejects(h.call("gate.result", { id: job.id, leaseToken, receipt: receipt(job.id, { outcome: "failed", reason: "exitNonZero", exitCode: 1 }) }, machine), /another receipt/);
      await assert.rejects(h.call("gate.cancel", { id: job.id }, person), /ended/);
    } finally { h.close(); }
  });
  it("passes with its screenshots uploaded under the job, and a passed job stays passed", async () => {
    const h = await fixture(); try {
      const { job, leaseToken } = await running(h);
      const up = await h.call("gate.artifact", { id: job.id, leaseToken, name: "smoke.png", data: png.toString("base64") }, machine);
      const bad = receipt(job.id, { artifacts: [{ name: "smoke.png", type: "image/png", bytes: png.length, sha256: "d".repeat(64), required: true }] });
      const wrong = await h.call("gate.result", { id: job.id, leaseToken, receipt: bad }, machine);
      assert.deepEqual([wrong.state, wrong.reason], ["error", "uploadFailed"]);
      const { job: j2, leaseToken: t2 } = await running2(h);
      await h.call("gate.artifact", { id: j2.id, leaseToken: t2, name: "smoke.png", data: png.toString("base64") }, machine);
      const good = await h.call("gate.result", { id: j2.id, leaseToken: t2, receipt: receipt(j2.id, { artifacts: [{ name: "smoke.png", type: "image/png", bytes: up.bytes, sha256: up.sha256, required: true }] }) }, machine);
      assert.equal(good.state, "passed");
      await assert.rejects(h.call("gate.artifact", { id: j2.id, leaseToken: t2, name: "late.png", data: png.toString("base64") }, machine), /not running/);
      const files = await h.call("artifacts.list", { project: "app", runId: j2.id }, person);
      assert.deepEqual(files.map((f) => f.name), ["smoke.png"]);
    } finally { h.close(); }
  });
  it("caps the lease at claim + timeout + 10 min however often the machine renews, then makes it uncertain (G06, G10)", async () => {
    const h = await fixture(); try {
      const { job, leaseToken } = await running(h);
      let last = "";
      for (let i = 0; i < 40; i++) { clock += 60_000; last = (await h.call("gate.progress", { id: job.id, leaseToken, step: "run" }, machine)).leaseUntil!; }
      assert.equal(last, new Date(Date.parse(job.claimedAt!) + (20 + 10) * 60_000).toISOString());
      clock = Date.parse(last) + 1;
      assert.deepEqual((await h.call("gate.get", { id: job.id }, person)).state, "uncertain");
      assert.equal(await h.call("gate.take", { project: "app" }, machine), null, "an uncertain job is never taken again");
      const late = await h.call("gate.result", { id: job.id, leaseToken, receipt: receipt(job.id, { outcome: "failed", reason: "exitNonZero", exitCode: 1 }) }, machine);
      assert.deepEqual([late.state, late.receipt?.outcome], ["uncertain", "failed"], "a late receipt is kept as evidence, the state is not reopened");
      const done = await h.call("gate.reconcile", { id: job.id, outcome: "failed", note: "checked the machine" }, person);
      assert.deepEqual([done.state, done.reason], ["failed", "reconciled"]);
    } finally { h.close(); }
  });
  it("cancels a running job at its next progress; expires one never taken", async () => {
    const h = await fixture(); try {
      const { job, leaseToken } = await running(h);
      await h.call("gate.cancel", { id: job.id, reason: "wrong sha" }, person);
      assert.equal((await h.call("gate.progress", { id: job.id, leaseToken, step: "run" }, machine)).state, "cancelled");
      const kept = await h.call("gate.result", { id: job.id, leaseToken, receipt: receipt(job.id, { outcome: "cancelled", reason: "cancelled", exitCode: null, signal: "SIGTERM" }) }, machine);
      assert.equal(kept.state, "cancelled");
      const fresh = await create(h, { idempotencyKey: "k-exp", expiresInMinutes: 5 });
      clock += 6 * 60_000;
      assert.deepEqual((await h.call("gate.get", { id: fresh.id }, person)).state, "expired");
    } finally { h.close(); }
  });
  it("refuses a draining or duplicate machine at take", async () => {
    const h = await fixture(); try {
      const job = await create(h);
      await h.call("gate.approve", { id: job.id, version: job.version, pass: true }, person);
      await h.call("machines.heartbeat", { machine: "mini", instance: "aabbccdd", projects: ["app"], updateDraining: true, gate: cap() }, machine);
      assert.equal(await h.call("gate.take", { project: "app" }, machine), null);
    } finally { h.close(); }
  });
});

async function running2(h: SqliteHive) {
  const job = await create(h, { idempotencyKey: "k2" });
  await h.call("gate.approve", { id: job.id, version: job.version, pass: true }, person);
  const taken = (await h.call("gate.take", { project: "app" }, machine))!;
  await h.call("gate.progress", { id: job.id, leaseToken: taken.leaseToken, step: "clone" }, machine);
  return taken;
}
