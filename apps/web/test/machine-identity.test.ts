import assert from "node:assert/strict";
import { it } from "node:test";
import type { Request, RequestHandler, Response } from "express";
import type { Actor } from "@xdev-hive/core";
import { SqliteHive, migrationIndex } from "@xdev-hive/core/node";
import { createHubApp } from "#web/app.ts";
import { TokenStore } from "#web/tokens.ts";
import { UserStore } from "#web/users.ts";

function setup(legacy = false, unowned = false) {
  let hive = new SqliteHive(":memory:", legacy ? { migrateTo: migrationIndex("ALTER TABLE machines ADD COLUMN token_id") } : {});
  const tokens = new TokenStore(hive.db);
  const users = new UserStore(hive.db);
  const owner = users.create({ username: "owner" }).user;
  const other = users.create({ username: "other" }).user;
  users.setGrants(owner.id, { app: "lead" });
  users.setGrants(other.id, { app: "lead" });
  const paired = tokens.create("device", "agent", unowned ? null : owner.id);
  const attacker = tokens.create("device", "agent", other.id);
  const human = tokens.create("owner-human", "member", owner.id);
  const stranger = tokens.create("other-human", "member", other.id);
  const admin = tokens.create("hub-admin", "admin");
  const machineId = "runner.test@device";
  const now = new Date().toISOString();
  if (legacy) {
    hive.db.prepare("INSERT INTO machines(id, machine, instance, last_seen, owner) VALUES (?, 'test', 'aaaaaaaa', ?, ?)")
      .run(machineId, now, unowned ? null : owner.username);
    hive = new SqliteHive(hive.db);
  }
  hive.db.prepare("INSERT INTO tasks(id, project, title, updated_at, agent_machine, agent_profile, agent_order, agent_by, agent_at) VALUES ('SEC-1', 'app', 'Task', ?, ?, 'claude-1', 1, 'admin', ?)")
    .run(now, machineId, now);
  const app = createHubApp({ hive, tokens, users });
  const routes = (app as unknown as { router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler }> } }> } }).router.stack;
  const invoke = async (credential: string, path: string, body: unknown, label = "runner.test", verb = "post", extraHeaders = {}) => {
    const route = routes.find((layer) => layer.route?.path === path && layer.route.methods[verb])!.route!;
    const headers: Record<string, string> = { authorization: `Bearer ${credential}`, "x-hive-agent": label, ...extraHeaders };
    const req = { method: verb.toUpperCase(), path, body, get: (key: string) => headers[key] };
    let status = 200, answer: any, authenticated = false;
    const res = { locals: {} as { actor?: Actor }, status: (code: number) => { status = code; return res; }, json: (value: unknown) => { answer = value; return res; } };
    route.stack[0]!.handle(req as Request, res as unknown as Response, () => { authenticated = true; });
    if (authenticated) await route.stack.at(-1)!.handle(req as Request, res as unknown as Response, () => {});
    return { status, answer, actor: res.locals.actor! };
  };
  const rpc = (credential: string, method: string, input: unknown, label?: string, extraHeaders?: Record<string, string>) => invoke(credential, "/api/rpc", { method, input }, label, "post", extraHeaders);
  const beat = (credential = paired.token, extra = {}) => rpc(credential, "machines.heartbeat", { machine: "test", instance: "aaaaaaaa", projects: ["app"], acceptsRuns: true, ...extra });
  const issue = (credential = paired.token) => invoke(credential, "/api/run-credentials", { machine: "test", project: "app", task: "SEC-1", run: "R-test", minutes: 30, readOnly: false });
  const row = () => hive.db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId);
  return { hive, tokens, owner, other, paired, attacker, human, stranger, admin, machineId, rpc, invoke, beat, issue, row };
}

it("pins the verified token and refuses namesakes without changing any machine state or reporting rights", async () => {
  const s = setup();
  try {
    const first = await s.beat();
    assert.equal(first.status, 200);
    assert.equal(s.row()?.token_id, s.paired.info.id);
    assert.equal(s.hive.isMachineActor(s.machineId, first.actor), true, "contract for terminal machineReport");
    const before = s.row();
    const sameOwner = s.tokens.create("device", "agent", s.owner.id);
    const unowned = s.tokens.create("device", "agent");
    for (const credential of [s.attacker.token, sameOwner.token, unowned.token]) {
      const hijack = await s.beat(credential, { instance: "bbbbbbbb", profiles: [], runs: [], projects: [] });
      assert.equal(hijack.status, 403);
      assert.deepEqual(s.row(), before);
      assert.equal(s.hive.isMachineActor(s.machineId, hijack.actor), false);
      assert.equal((await s.issue(credential)).status, 403);
      assert.throws(() => s.tokens.issueRun(credential, { machine: "test", project: "app", task: "SEC-1", run: "R-forged", minutes: 30, readOnly: false }), (e: any) => e.code === "forbidden");
      assert.equal((await s.invoke(credential, "/api/run-credentials", { machine: "test", run: "R-test" }, "runner.test", "delete")).status, 403);
      for (const [method, input] of [["runs.requestResult", { id: 1, status: "accepted", runId: "R-test" }], ["runs.push", { machine: "test", runs: [] }], ["chat.poll", {}], ["tasks.claim", { id: "SEC-1" }]] as const)
        assert.equal((await s.rpc(credential, method, input)).status, 403, method);
      assert.equal((await s.rpc(credential, "tasks.claim", { id: "SEC-1" }, "claude-1.test", { "x-hive-source": JSON.stringify({ via: "mcp", machine: "test" }) })).status, 409, "a forged source cannot take the machine's assigned task");
    }
    assert.equal((await s.beat(s.paired.token, { machine: "renamed" })).status, 403);
    const issued = await s.issue();
    assert.equal(issued.status, 200);
    const agent = await s.rpc(issued.answer.result.token, "tasks.claim", { id: "SEC-1" }, "claude-1.test");
    assert.equal(agent.status, 200);
    assert.equal(agent.answer.result.claimed, true);
    assert.equal(s.hive.isMachineActor(s.machineId, { ...first.actor, runCredential: { project: "app", task: "SEC-1", run: "R-test", machine: "test", readOnly: false } }), false);
    assert.equal((await s.rpc(s.human.token, "machines.setProfile", { machineId: s.machineId, profileId: "absent", enabled: false }, "")).status, 404, "owner permission still reaches profile validation");
    assert.equal((await s.rpc(s.stranger.token, "machines.setProfile", { machineId: s.machineId, profileId: "absent", enabled: false }, "")).status, 403);
    assert.equal((await s.beat()).status, 200);
  } finally { s.hive.close(); }
});

it("migrates an old machine only on its owner's heartbeat and audits the binding once", async () => {
  for (const unowned of [false, true]) {
    const s = setup(true, unowned);
    try {
      const before = s.row();
      assert.equal(before?.token_id, null);
      assert.equal((await s.beat(s.attacker.token)).status, 403);
      assert.deepEqual(s.row(), before);
      assert.equal((await s.issue()).status, 403, "legacy rows cannot mint credentials before binding");
      const first = await s.beat();
      assert.equal(first.status, 200);
      assert.equal(s.row()?.token_id, s.paired.info.id);
      assert.equal(s.row()?.owner, unowned ? null : "owner");
      assert.equal(s.hive.isMachineActor(s.machineId, first.actor), true);
      assert.equal((await s.issue()).status, 200);
      assert.equal((await s.beat()).status, 200);
      assert.equal(s.hive.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'machines.bind'").get()?.n, 1);
    } finally { s.hive.close(); }
  }
});

it("requires an explicit human re-pair for rotation or ambiguous legacy tokens and revokes old run credentials", async () => {
  const s = setup(true);
  try {
    const replacement = s.tokens.create("device", "agent", s.owner.id);
    assert.equal((await s.beat()).status, 403, "ambiguous old token names do not choose the first heartbeat");
    const repair = (credential: string, tokenId: string, label = "") => s.rpc(credential, "machines.repair", { machineId: s.machineId, tokenId }, label);
    assert.equal((await repair(s.stranger.token, replacement.info.id)).status, 403);
    assert.equal((await repair(s.paired.token, replacement.info.id, "runner.test")).status, 403);
    assert.equal((await repair(s.human.token, s.attacker.info.id)).status, 400, "owner cannot transfer the machine to another account");
    assert.equal((await repair(s.human.token, s.paired.info.id)).status, 200);
    assert.equal((await s.beat()).status, 200);
    const issued = await s.issue();
    assert.equal(issued.status, 200);
    assert.equal((await repair(s.human.token, replacement.info.id)).status, 200);
    assert.equal(s.tokens.verify(issued.answer.result.token), null);
    assert.equal((await s.beat()).status, 403);
    assert.equal((await s.beat(replacement.token)).status, 200);
    assert.equal((await s.issue(replacement.token)).status, 200);
    s.tokens.revoke(replacement.info.id);
    assert.equal((await s.beat()).status, 403, "revocation never clears the binding");
    assert.equal((await repair(s.admin.token, s.attacker.info.id)).status, 200, "admin can deliberately transfer ownership");
    assert.equal((await s.beat(s.attacker.token)).status, 200);
    assert.equal(s.row()?.owner, "other");
    assert.equal(s.hive.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'machines.repair'").get()?.n, 3);
  } finally { s.hive.close(); }
});

it("retains offline hub identities, including legacy rows awaiting their first migrated heartbeat", async () => {
  for (const legacy of [false, true]) {
    const s = setup(legacy);
    try {
      if (!legacy) assert.equal((await s.beat()).status, 200);
      s.hive.db.prepare("UPDATE machines SET last_seen = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(s.machineId);
      const before = s.row();
      const peer = s.tokens.create("peer", "agent", s.owner.id);
      assert.equal((await s.rpc(peer.token, "machines.heartbeat", { machine: "peer", instance: "bbbbbbbb" }, "runner.peer")).status, 200);
      assert.deepEqual(s.row(), before, "an unrelated heartbeat cannot free an offline machine id");
      assert.equal((await s.beat(s.attacker.token)).status, 403);
      assert.equal((await s.beat()).status, 200);
    } finally { s.hive.close(); }
  }
});
