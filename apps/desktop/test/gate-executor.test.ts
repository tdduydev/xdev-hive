import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Actor, GateJob, GateTemplate, HiveBackend } from "@xdev-hive/core";
import { SqliteHive, gateTemplateHash } from "@xdev-hive/core/node";
import { ResourceLocks } from "#desktop/main/resource-locks.ts";
import { GateExecutor, readGatePolicy } from "#desktop/main/runner/gate.ts";

const person: Actor = { name: "duy", role: "member", account: "duy", humanSession: "s", access: { projects: { app: "manage" } } };
const machine: Actor = { name: "runner.mini@duy", role: "agent", account: "duy" };
const HUB_TOKEN = "hivetok-canary-0123456789abcdef";
const RUN_TOKEN = `hiverun_${"C".repeat(40)}`;

// The gate's own script: what each template mode does stands for a real check (pass, a failing test, a dirty tree…).
const SCRIPT = `
import fs from "node:fs"; import path from "node:path"; import { execFileSync } from "node:child_process";
const [mode, out] = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.GATE_MARKER, "ran"), mode + "\\n");
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5e8b8c40000000049454e44ae426082", "hex");
fs.writeFileSync(path.join(out, "shot.png"), png);
const result = (ok, checks) => fs.writeFileSync(path.join(out, "result.json"), JSON.stringify({ ok, checks, summary: "token ${RUN_TOKEN}" }));
console.log("log line with ${HUB_TOKEN}");
if (mode === "pass") result(true, [{ name: "smoke", ok: true }]);
if (mode === "fail") { result(true); process.exit(1); }
if (mode === "notok") result(true, [{ name: "e2e", ok: false }]);
if (mode === "dirty") { fs.writeFileSync("README.md", "changed"); result(true); }
if (mode === "env") {
  fs.writeFileSync(path.join(out, "env.json"), JSON.stringify({ env: process.env, remotes: execFileSync("git", ["remote"], { encoding: "utf8" }) }));
  fs.writeFileSync(path.join(out, "leak.txt"), "fine\\nghp_" + "a".repeat(36) + "\\n${HUB_TOKEN}\\n");
  fs.symlinkSync("/etc/hosts", path.join(out, "link.txt"));
  result(true);
}
if (mode === "sleep") setTimeout(() => result(true), 60_000);
if (mode === "shortenv") {
  console.log("short " + process.env.GATE_VALUE);
  fs.writeFileSync(path.join(out, "env.txt"), "short " + process.env.GATE_VALUE);
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify({ ok: true, summary: process.env.GATE_VALUE, checks: [{ name: process.env.GATE_VALUE, ok: true }] }));
}
`;

const template = (id: string, mode: string, over: Partial<GateTemplate> = {}): GateTemplate => ({
  id, version: 1, label: id, argv: ["node", "gate.mjs", mode, "{artifactDir}"], env: ["GATE_MARKER"], timeoutMinutes: 5, gui: false,
  resultFile: "result.json", artifacts: [{ glob: "*.png", required: true }, { glob: "*.json", required: false }, { glob: "*.txt", required: false }], autoApprove: false, ...over,
});
const TEMPLATES = [template("pass", "pass"), template("fail", "fail"), template("notok", "notok"), template("dirty", "dirty"), template("env", "env"), template("sleep", "sleep", { timeoutMinutes: 1 })];

describe("gate executor (69h2)", () => {
  let dir: string, repo: string, data: string, marker: string, hub: SqliteHive, sha: string, offSha: string;
  let policy = { enabled: true, osUser: os.userInfo().username, projects: { app: { autoApprove: false, templates: TEMPLATES } } };
  let failResults = 0;
  const backend: HiveBackend = {
    call: (async (method: string, input: unknown, actor: Actor) => {
      if (method === "gate.result" && failResults > 0) { failResults--; throw new Error("socket hang up"); }
      return hub.call(method as never, input as never, actor);
    }) as HiveBackend["call"],
  } as HiveBackend;
  const writePolicy = () => { writeFileSync(path.join(data, "gate-jobs.json"), JSON.stringify(policy), { mode: 0o600 }); chmodSync(path.join(data, "gate-jobs.json"), 0o600); };
  const executor = (over: Partial<ConstructorParameters<typeof GateExecutor>[0]> = {}) => new GateExecutor({
    backend: () => backend, actor: () => machine, projects: () => [{ name: "app", repo }], allowed: () => true, locks: new ResourceLocks(),
    env: () => ({ ...process.env, GATE_MARKER: marker, HIVE_RUN_TOKEN: RUN_TOKEN, ANTHROPIC_API_KEY: "sk-ant-canary-0123456789abcdefghij", HIVE_TOKEN: HUB_TOKEN }),
    secretEnv: () => ["ANTHROPIC_API_KEY"], known: () => [HUB_TOKEN], version: "0.0.0-test", gui: async () => "none", log: () => undefined,
    progressMs: 50, minuteMs: 400, ...over,
  }, data);
  const beat = async (g: GateExecutor) => {
    const reply = await hub.call("machines.heartbeat", { machine: "mini", instance: "aabbccdd", projects: ["app"], gate: g.capability() }, machine);
    g.onHub(reply.gate);
  };
  const job = async (g: GateExecutor, id: string, over: { sha?: string; ref?: string; key?: string } = {}) => {
    await beat(g);
    const t = policy.projects.app.templates.find((x) => x.id === id)!;
    const j = await hub.call("gate.create", { project: "app", machineId: machine.name, templateId: id, templateHash: gateTemplateHash(t), sha: over.sha ?? sha, ref: over.ref ?? "main", purpose: "evidence", idempotencyKey: over.key ?? id }, person);
    await hub.call("gate.approve", { id: j.id, version: j.version, pass: true }, person);
    return j;
  };
  const run = async (g: GateExecutor, j: GateJob) => { await g.poll(); await g.settle(); return hub.call("gate.get", { id: j.id }, person); };
  const ran = () => (existsSync(path.join(marker, "ran")) ? readFileSync(path.join(marker, "ran"), "utf8").trim().split("\n") : []);

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "hive-gate-"));
    repo = path.join(dir, "repo"); data = path.join(dir, "data"); marker = path.join(dir, "marker");
    for (const d of [data, marker]) execFileSync("mkdir", ["-p", d]);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=f", "-c", "user.email=f@example.test", ...a], { cwd: repo, encoding: "utf8" }).trim();
    writeFileSync(path.join(repo, "gate.mjs"), SCRIPT); writeFileSync(path.join(repo, "README.md"), "fixture\n");
    git("add", "."); git("commit", "-qm", "fixture"); sha = git("rev-parse", "HEAD");
    git("checkout", "-qb", "side"); writeFileSync(path.join(repo, "side.txt"), "x"); git("add", "."); git("commit", "-qm", "side"); offSha = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    hub = new SqliteHive(":memory:", { gateJobs: true });
    writePolicy();
  });
  after(() => { hub.close(); rmSync(dir, { recursive: true, force: true }); });

  it("passes a green run in a clean clone, uploads its screenshots and leaves no clone (G08 shape)", async () => {
    const g = executor();
    const done = await run(g, await job(g, "pass"));
    assert.deepEqual([done.state, done.reason], ["passed", null], JSON.stringify(done.receipt));
    assert.equal(done.receipt?.checkedSha, sha);
    assert.equal(done.receipt?.result?.summary?.includes(RUN_TOKEN), false, "the summary is filtered");
    assert.equal(done.receipt?.logTail.includes(HUB_TOKEN), false, "the log tail is filtered");
    const files = await hub.call("artifacts.list", { project: "app", runId: done.id }, person);
    assert.deepEqual(files.map((f) => f.name).sort(), ["result.json", "shot.png"]);
    assert.equal(readdirSync(path.join(data, "gate", "receipts")).length, 0);
    assert.ok(!readdirSync(path.join(data, "gate")).some((d) => existsSync(path.join(data, "gate", d, "clone"))), "the clone goes once the hub has the receipt");
  });
  it("is red for a failing test or a not-ok result although every screenshot is there (AC09, G04)", async () => {
    const g = executor();
    const fail = await run(g, await job(g, "fail"));
    assert.deepEqual([fail.state, fail.reason, fail.receipt?.exitCode], ["failed", "exitNonZero", 1]);
    assert.ok(fail.receipt?.artifacts.some((a) => a.name === "shot.png"), "screenshots do not make it green");
    const notok = await run(g, await job(g, "notok"));
    assert.deepEqual([notok.state, notok.reason], ["failed", "resultNotOk"]);
    const dirty = await run(g, await job(g, "dirty"));
    assert.deepEqual([dirty.state, dirty.reason], ["failed", "treeChanged"]);
  });
  it("builds the env from scratch, leaves no remote and filters text artifacts (G05)", async () => {
    const g = executor();
    const done = await run(g, await job(g, "env"));
    assert.equal(done.state, "passed", JSON.stringify(done.receipt));
    const files = await hub.call("artifacts.list", { project: "app", runId: done.id }, person);
    assert.ok(!files.some((f) => f.name === "link.txt"), "a link is never followed");
    const read = async (name: string) => Buffer.from((await hub.call("artifacts.get", { id: files.find((f) => f.name === name)!.id }, person))!.data, "base64").toString("utf8");
    const seen = JSON.parse(await read("env.json")) as { env: Record<string, string>; remotes: string };
    for (const n of ["HIVE_RUN_TOKEN", "HIVE_TOKEN", "ANTHROPIC_API_KEY", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"]) assert.equal(seen.env[n], undefined, n);
    // It came through (the script wrote its marker there); its value is one the text filter hides.
    assert.equal(seen.env.GATE_MARKER, "[hidden]");
    assert.deepEqual([seen.env.HIVE_GATE_SHA, seen.env.HIVE_GATE_JOB, seen.env.TERM], [sha, done.id, "dumb"]);
    assert.equal(seen.remotes.trim(), "", "no remote to push to");
    const leak = await read("leak.txt");
    assert.ok(leak.startsWith("fine\n") && !leak.includes("ghp_") && !leak.includes(HUB_TOKEN), leak);
  });
  it("runs nothing when the local template changed after approval, or the SHA is not on the ref (G02, G03)", async () => {
    const g = executor();
    const before = ran().length;
    const j = await job(g, "pass", { key: "changed" });
    policy = { ...policy, projects: { app: { autoApprove: false, templates: TEMPLATES.map((t) => (t.id === "pass" ? { ...t, version: 2 } : t)) } } };
    writePolicy();
    const changed = await run(g, j);
    assert.deepEqual([changed.state, changed.reason], ["error", "templateChanged"]);
    policy = { ...policy, projects: { app: { autoApprove: false, templates: TEMPLATES } } };
    writePolicy();
    const off = await run(g, await job(g, "pass", { sha: offSha, key: "off" }));
    assert.deepEqual([off.state, off.reason], ["error", "shaNotOnRef"]);
    const onSide = await run(g, await job(g, "pass", { sha: offSha, ref: "side", key: "side" }));
    assert.equal(onSide.state, "passed", "the same SHA on its own branch is fine");
    assert.equal(ran().length, before + 1, "only the last one spawned anything");
  });
  it("redacts short env values in artifacts, result diagnostics and log tails", async () => {
    policy = { ...policy, projects: { app: { autoApprove: false, templates: [...TEMPLATES, template("shortenv", "shortenv", { env: ["GATE_MARKER", "GATE_VALUE", "GATE_EMPTY"] })] } } };
    writePolicy();
    const g = executor({ env: () => ({ ...process.env, GATE_MARKER: marker, GATE_VALUE: "c4n4ry7", GATE_EMPTY: "" }) });
    const done = await run(g, await job(g, "shortenv"));
    assert.equal(done.state, "passed");
    assert.equal(done.receipt?.result?.summary, "[hidden]");
    assert.equal(done.receipt?.result?.checks?.[0]?.name, "[hidden]");
    assert.ok(done.receipt?.logTail.includes("short [hidden]"));
    const files = await hub.call("artifacts.list", { project: "app", runId: done.id }, person);
    const artifact = files.find((f) => f.name === "env.txt")!;
    const stored = await hub.call("artifacts.get", { id: artifact.id }, person);
    assert.ok(stored);
    const text = Buffer.from(stored.data, "base64").toString("utf8");
    assert.equal(text, "short [hidden]");
    policy = { ...policy, projects: { app: { autoApprove: false, templates: TEMPLATES } } };
    writePolicy();
  });
  it("kills at the template's timeout and at a cancel from the hub (G06)", async () => {
    const g = executor();
    const slow = await run(g, await job(g, "sleep", { key: "t1" }));
    assert.deepEqual([slow.state, slow.reason, slow.receipt?.timedOut], ["failed", "timeout", true]);
    const j = await job(g, "sleep", { key: "t2" });
    await g.poll();
    while ((await hub.call("gate.get", { id: j.id }, person)).state !== "running") await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 150));
    await hub.call("gate.cancel", { id: j.id, reason: "stop" }, person);
    await g.settle();
    const c = await hub.call("gate.get", { id: j.id }, person);
    assert.deepEqual([c.state, c.receipt?.outcome], ["cancelled", "cancelled"]);
  });
  it("resends a receipt whose reply was lost, without running the command again", async () => {
    const g = executor();
    const before = ran().length;
    const j = await job(g, "pass", { key: "lost" });
    failResults = 1;
    await run(g, j);
    assert.equal((await hub.call("gate.get", { id: j.id }, person)).state, "running");
    assert.equal(readdirSync(path.join(data, "gate", "receipts")).length, 1);
    await g.poll(); await g.settle();
    assert.equal((await hub.call("gate.get", { id: j.id }, person)).state, "passed");
    assert.equal(ran().length, before + 1);
  });
  it("does not take while the project is busy or held, and a GUI template needs a GUI", async () => {
    const busy = executor({ allowed: () => false });
    const j = await job(busy, "pass", { key: "busy" });
    await busy.poll(); await busy.settle();
    assert.equal((await hub.call("gate.get", { id: j.id }, person)).state, "approved");
    const locks = new ResourceLocks();
    locks.acquire("app", "gate", "gate", "other");
    const held = executor({ locks });
    await held.poll(); await held.settle();
    assert.equal((await hub.call("gate.get", { id: j.id }, person)).state, "approved");
    await hub.call("gate.cancel", { id: j.id }, person);
    policy = { ...policy, projects: { app: { autoApprove: false, templates: [...TEMPLATES, template("gui", "pass", { gui: true })] } } };
    writePolicy();
    const g = executor();
    const noGui = await run(g, await job(g, "gui"));
    assert.deepEqual([noGui.state, noGui.reason], ["error", "noGui"]);
  });
  it("reads the policy only from a private file of this user, without secrets", () => {
    const file = path.join(dir, "p.json");
    const write = (p: unknown, mode = 0o600) => { writeFileSync(file, JSON.stringify(p)); chmodSync(file, mode); };
    write(policy);
    assert.equal(Object.keys(readGatePolicy(file, new Set()).projects.app!.templates).length > 0, true);
    write(policy, 0o644);
    assert.throws(() => readGatePolicy(file, new Set()));
    write({ ...policy, projects: { app: { templates: [template("x", "pass", { env: ["HIVE_TOKEN"] })] } } });
    assert.throws(() => readGatePolicy(file, new Set()));
    write({ ...policy, projects: { app: { templates: [template("x", "pass", { env: ["ANTHROPIC_API_KEY"] })] } } });
    assert.throws(() => readGatePolicy(file, new Set(["ANTHROPIC_API_KEY"])));
    write({ ...policy, projects: { app: { templates: [template("x", "pass", { argv: ["curl", `ghp_${"a".repeat(36)}`] })] } } });
    assert.throws(() => readGatePolicy(file, new Set()));
    write({ ...policy, osUser: "someone-else" });
    assert.throws(() => readGatePolicy(file, new Set()));
  });
});
