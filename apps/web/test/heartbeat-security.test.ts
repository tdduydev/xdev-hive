import assert from "node:assert/strict";
import { it } from "node:test";
import type { Request, Response, RequestHandler } from "express";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHubApp } from "#web/app.ts";
import { TokenStore } from "#web/tokens.ts";
import { UserStore } from "#web/users.ts";

const now = "2026-10-07T06:00:00.000Z";
const until = "2026-10-07T07:00:00.000Z";
const profile = (account: string | null) => ({ id: "claude-1", label: "Claude", kind: "claude", account, installed: true, enabled: true, cooldownUntil: null, runs: 0, rateLimited: 0 });
const heartbeat = (extra = {}) => ({ machine: "test", instance: "aaaaaaaa", ...extra });
const cost = (project: string, costUsd = 10) => ({ runId: `R-${project}`, project, taskId: "T-1", profileId: "claude-1", account: null, costUsd, inputTokens: null, outputTokens: null, finishedAt: now });
const run = (project: string) => ({ runId: `R-${project}`, project, taskId: "T-1", taskTitle: "Test", role: "implement", status: "running", profileId: "claude-1", since: now });

function setup() {
  const hive = new SqliteHive(":memory:", { now: () => new Date(now) });
  const tokens = new TokenStore(hive.db);
  const users = new UserStore(hive.db);
  const owner = users.create({ username: "owner" }).user;
  const other = users.create({ username: "other" }).user;
  users.setGrants(owner.id, { app: "member", readonly: "viewer" });
  users.setGrants(other.id, { app: "lead" });
  const machine = tokens.create("owner-device", "agent", owner.id).token;
  const second = tokens.create("second-device", "agent", other.id).token;
  const stranger = tokens.create("stranger-device", "agent", other.id).token;
  const human = tokens.create("owner-web", "member", owner.id).token;
  const otherHuman = tokens.create("other-web", "member", other.id).token;
  const admin = tokens.create("hub-admin", "admin").token;
  const legacy = tokens.create("legacy-agent", "agent").token;
  const app = createHubApp({ hive, tokens, users });
  // Exercise the real Bearer authentication and RPC handler without a socket or a live hub.
  const router = (app as unknown as { router: { stack: Array<{ route?: { path: string; stack: Array<{ handle: RequestHandler }> } }> } }).router;
  const route = router.stack.find((layer) => layer.route?.path === "/api/rpc")!.route!;
  const rpc = async (credential: string, method: string, input: unknown, label?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${credential}`, ...(label ? { "x-hive-agent": label } : {}) };
    const req = { method: "POST", body: { method, input }, get: (key: string) => headers[key] };
    let status = 200, body: any, authenticated = false;
    const res = { locals: {}, status: (n: number) => { status = n; return res; }, json: (v: unknown) => { body = v; return res; } };
    route.stack[0]!.handle(req as Request, res as unknown as Response, () => { authenticated = true; });
    assert.equal(authenticated, true);
    await route.stack.at(-1)!.handle(req as Request, res as unknown as Response, () => {});
    return { status, body };
  };
  return { hive, users, owner, machine, second, stranger, human, otherHuman, admin, legacy, rpc };
}

it("heartbeat stores only visible repos and writable runs/costs, including after a grant revocation", async () => {
  const { hive, users, owner, machine, admin, legacy, rpc } = setup();
  try {
    const beat = await rpc(machine, "machines.heartbeat", heartbeat({ projects: ["app", "readonly", "hidden"], runs: [run("app"), run("readonly"), run("hidden")], costs: [cost("app", 2), cost("readonly"), cost("hidden")] }), "runner.test");
    assert.equal(beat.status, 200);
    const listed = await rpc(admin, "machines.list", {});
    assert.deepEqual(listed.body.result[0].projects, ["app", "readonly"]);
    assert.deepEqual(listed.body.result[0].runs.map((r: any) => r.project), ["app"]);
    let summary = (await rpc(admin, "costs.summary", {})).body.result;
    assert.equal(summary.total.usd30, 2);
    assert.deepEqual(summary.projects.map((p: any) => p.project), ["app"]);
    users.setGrants(owner.id, { readonly: "viewer" });
    assert.equal((await rpc(machine, "machines.heartbeat", heartbeat({ costs: [{ ...cost("app", 99), runId: "R-revoked" }, cost("hidden")] }), "runner.test")).status, 200);
    assert.deepEqual((await rpc(admin, "machines.list", {})).body.result[0].projects, ["readonly"], "omitting projects still removes revoked repos");
    summary = (await rpc(admin, "costs.summary", {})).body.result;
    assert.equal(summary.total.usd30, 2, "old accepted costs stay; unauthorized replays add nothing");
    assert.equal((await rpc(legacy, "machines.heartbeat", heartbeat({ machine: "legacy", costs: [cost("hidden", 3)], projects: ["hidden"] }), "runner.legacy")).status, 200);
    assert.equal((await rpc(admin, "costs.summary", {})).body.result.total.usd30, 5, "unrestricted legacy actors retain role permissions");
  } finally { hive.close(); }
});

it("cooldown mutations require a reporting machine, its human owner or a hub admin", async () => {
  const { hive, machine, second, stranger, human, otherHuman, admin, legacy, rpc } = setup();
  try {
    await rpc(machine, "machines.heartbeat", heartbeat({ profiles: [profile("shared-sub")] }), "runner.test");
    const set = { account: "shared-sub", until, reason: "quota" };
    assert.equal((await rpc(machine, "cooldowns.set", set, "runner.test")).status, 200);
    for (const token of [stranger, legacy, otherHuman]) {
      for (const [method, input] of [["cooldowns.set", set], ["cooldowns.set", { ...set, until: now }], ["cooldowns.clear", { account: set.account }]] as const) {
        const refused = await rpc(token, method, input, token === otherHuman ? undefined : "runner.test");
        assert.equal(refused.status, 403, "same label on a different token owns no machine");
        assert.equal(refused.body.error.key, "errors.cooldownForbidden");
      }
    }
    assert.equal((await rpc(admin, "cooldowns.list", {})).body.result.length, 1, "refused mutations leave cooldown intact");
    assert.equal((await rpc(machine, "cooldowns.clear", { account: set.account }, "claude-1.test")).status, 403, "an agent sharing the owner credential is not the reporting machine");
    assert.equal((await rpc(human, "cooldowns.clear", { account: set.account })).status, 200);
    assert.equal((await rpc(human, "cooldowns.set", set)).status, 200);
    await rpc(second, "machines.heartbeat", heartbeat({ machine: "second", profiles: [profile("shared-sub")] }), "runner.second");
    assert.equal((await rpc(second, "cooldowns.set", set, "runner.second")).status, 200, "both machines reporting the account own its cooldown");
    assert.equal((await rpc(otherHuman, "cooldowns.clear", { account: set.account })).status, 200, "each reporting machine's human owner can clear");
    assert.equal((await rpc(admin, "cooldowns.set", { ...set, account: "unreported-sub" })).status, 200);
    assert.equal((await rpc(admin, "cooldowns.clear", { account: "unreported-sub" })).status, 200);
    assert.equal((await rpc(machine, "cooldowns.set", { ...set, account: "unreported-sub" }, "runner.test")).status, 403);
  } finally { hive.close(); }
});

it("cooldown ownership follows current profile reports and cannot be claimed with onBehalf", async () => {
  const { hive, machine, human, admin, rpc } = setup();
  try {
    const report = (extra = {}) => rpc(machine, "machines.heartbeat", heartbeat(extra), "runner.test");
    await report({ profiles: [profile("sub")] });
    await assert.rejects(hive.call("cooldowns.set", { account: "sub", until, reason: "quota" }, { name: "unknown", role: "member", onBehalf: "owner" }), (e: any) => e.code === "forbidden");
    await assert.rejects(hive.call("cooldowns.set", { account: "sub", until, reason: "quota" }, { name: "agent", role: "agent", account: "owner" }), (e: any) => e.code === "forbidden");
    await report();
    const set = { account: "sub", until, reason: "quota" };
    assert.equal((await rpc(machine, "cooldowns.set", set, "runner.test")).status, 200, "omitted profiles retain ownership");
    await report({ profiles: [profile(null)] });
    for (const token of [machine, human]) {
      assert.equal((await rpc(token, "cooldowns.clear", { account: "sub" }, token === machine ? "runner.test" : undefined)).status, 403);
    }
    assert.equal((await rpc(admin, "cooldowns.clear", { account: "sub" })).status, 200);
    await assert.rejects(hive.call("cooldowns.set", set, { name: "unknown", role: "member", onBehalf: "owner" }), (e: any) => e.code === "forbidden");
    await assert.rejects(hive.call("cooldowns.set", set, { name: "restricted-admin", role: "admin", access: { projects: { app: "lead" } } }), (e: any) => e.code === "forbidden");
  } finally { hive.close(); }
});
