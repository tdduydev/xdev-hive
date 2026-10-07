import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  SqliteHive, TerminalStore, migrationIndex, canTransition, terminalDecision, terminalHubEnabled, terminalUnavailable, terminalInputs,
  terminalClientFrameSchema, base64Bytes, assertTerminal, TERMINAL_STATES, TERMINAL_LIMITS, type Actor, type TerminalCheck, type TerminalCapability,
} from "#core/node.ts";

const cap: TerminalCapability = { protocol: 1, enabled: true, projects: ["app"], platforms: ["darwin"], auditReady: true, guiReady: true };
const machine = { id: "runner@mini", owner: "owner", capability: cap };
const web = { via: "web" } as const;
const person = (account: string, extra: Partial<Actor> = {}): Actor =>
  ({ name: account, role: "member", account, source: web, humanSession: `s-${account}`, ...extra });

// Every kind of caller the hub knows. Only the first three are people in a browser.
const admin = person("admin", { role: "admin" });
const owner = person("owner", { access: { projects: { app: "member" } } });
const lead = person("lead", { access: { projects: { app: "lead" } } });
const ownerElsewhere = person("owner", { access: { projects: { other: "lead" } } });
const ownerViewer = person("owner", { access: { projects: { app: "viewer" } } });
const adminBearer: Actor = { name: "admin", role: "admin", account: "admin", source: web };
const forgedDesktop: Actor = { name: "owner", role: "member", account: "owner", source: { via: "desktop" }, access: { projects: { app: "lead" } } };
const runCred: Actor = { ...owner, runCredential: { project: "app", task: "T", run: "R", machine: "mini", readOnly: false } };
const mcpCred: Actor = { ...owner, mcpCredential: true };
const chatLeader: Actor = { ...admin, chatReply: 7 };
const agentLabel: Actor = { ...owner, agent: "claude-1", source: { via: "api" } };
const machineBearer: Actor = { name: "runner@mini", role: "agent", account: "owner" };

const check = (actor: Actor, op: TerminalCheck["op"], extra: Partial<TerminalCheck> = {}): string => {
  const d = terminalDecision({ op, actor, hubEnabled: true, project: "app", machine, stepUp: true, ...extra });
  return d.ok ? "ok" : d.denial;
};

describe("69a terminal contract", () => {
  it("is off unless the hub sets the flag to exactly 1", () => {
    assert.equal(terminalHubEnabled({}), false);
    assert.equal(terminalHubEnabled({ HIVE_REMOTE_TERMINAL: "true" }), false);
    assert.equal(terminalHubEnabled({ HIVE_REMOTE_TERMINAL: "1" }), true);
    assert.equal(check(admin, "create", { hubEnabled: false }), "hubDisabled");
    assert.equal(check(admin, "attach", { hubEnabled: false, session: { creator: "admin", machineId: machine.id, project: "app", state: "active" } }), "hubDisabled");
    // The kill switch never strands a shell: stopping and reading the audit stay possible.
    assert.equal(check(owner, "terminate", { hubEnabled: false, session: { creator: "admin", machineId: machine.id, project: "app", state: "active" } }), "ok");
  });

  it("walks the session state machine and refuses everything else", () => {
    const path: Array<[string, string, string]> = [
      ["requested", "starting", "spawning"], ["starting", "active", "spawned"], ["active", "detached", "detached"],
      ["detached", "active", "reattached"], ["active", "closing", "userClosed"], ["closing", "closed", "exited"],
    ];
    for (const [from, to, why] of path) assert.ok(canTransition(from as never, to as never, why as never), `${from}→${to}`);
    assert.ok(canTransition("requested", "closed", "userClosed"), "nothing spawned, nothing to kill");
    assert.ok(canTransition("active", "revoked", "parentRevoked"));
    assert.ok(canTransition("detached", "expired", "detachedTimeout"));
    assert.ok(canTransition("starting", "failed", "spawnFailed"));
    assert.equal(canTransition("active", "revoked", "idleTimeout"), false, "a timeout is not a revocation");
    assert.equal(canTransition("active", "closed", "userClosed"), false, "a running shell is killed in closing first");
    assert.equal(canTransition("requested", "active", "spawned"), false);
    for (const final of ["closed", "expired", "revoked", "failed"] as const)
      for (const to of TERMINAL_STATES) for (const why of ["spawning", "spawned", "reattached", "userClosed", "orphaned"] as const)
        assert.equal(canTransition(final, to, why), false, `${final} is final`);
  });

  it("reads a machine's capability, an old or unknown one as needing an upgrade", () => {
    assert.equal(terminalUnavailable(cap, "app"), null);
    assert.equal(terminalUnavailable(undefined, "app"), "needsUpgrade");
    assert.equal(terminalUnavailable({ ...cap, protocol: 2 }, "app"), "needsUpgrade");
    assert.equal(terminalUnavailable({ ...cap, extra: 1, enabled: "yes" }, "app"), "needsUpgrade");
    assert.equal(terminalUnavailable({ ...cap, platforms: ["win32"] }, "app"), "unsupportedPlatform");
    assert.equal(terminalUnavailable({ ...cap, enabled: false }, "app"), "disabledLocally");
    assert.equal(terminalUnavailable(cap, "billing"), "projectNotAllowed");
    assert.equal(terminalUnavailable({ ...cap, auditReady: false }, "app"), "auditNotReady");
  });

  it("takes no shell text, env, path or long reason into create", () => {
    const ok = { project: "app", machineId: machine.id, checkoutRef: "repo", mode: "shell", stepUpId: "a".repeat(32), reason: " fix ", idempotencyKey: crypto.randomUUID() };
    assert.equal(terminalInputs.create.parse(ok).reason, "fix");
    assert.ok(terminalInputs.create.safeParse({ ...ok, checkoutRef: "worktree:R-69a" }).success);
    for (const bad of [{ command: "rm -rf /" }, { env: { A: "1" } }, { cwd: "/" }, { checkoutRef: "/etc" }, { checkoutRef: "worktree:../x" },
      { mode: "agent" }, { reason: "x".repeat(501) }, { stepUpId: "short" }])
      assert.equal(terminalInputs.create.safeParse({ ...ok, ...bad }).success, false, JSON.stringify(bad));
  });

  it("bounds websocket frames by decoded size and terminal shape", () => {
    const b64 = (n: number) => Buffer.alloc(n, 1).toString("base64");
    for (const n of [0, 1, 2, 3, 100]) assert.equal(base64Bytes(b64(n)), n);
    assert.equal(base64Bytes("not base64!"), -1);
    const input = (data: string) => terminalClientFrameSchema.safeParse({ type: "input", epoch: 0, inputSeq: 1, data }).success;
    assert.ok(input(b64(TERMINAL_LIMITS.inputFrameBytes)));
    assert.equal(input(b64(TERMINAL_LIMITS.inputFrameBytes + 1)), false);
    const resize = (cols: number, rows: number) => terminalClientFrameSchema.safeParse({ type: "resize", epoch: 0, cols, rows }).success;
    assert.ok(resize(20, 5) && resize(400, 200));
    assert.equal(resize(19, 24) || resize(80, 201), false);
    assert.equal(terminalClientFrameSchema.safeParse({ type: "exec", data: "" }).success, false);
  });
});

describe("69a who may open a terminal (AC01)", () => {
  it("lets only an admin or the machine's owner with work rights on the project open one", () => {
    const table: Array<[string, Actor, string]> = [
      ["hub admin", admin, "ok"],
      ["machine owner, project member", owner, "ok"],
      ["project lead, not owner", lead, "notOwnerOrAdmin"],
      ["owner without the project", ownerElsewhere, "notFound"],
      ["owner as project viewer", ownerViewer, "noProjectAccess"],
      ["admin bearer token", adminBearer, "notHuman"],
      ["forged desktop source", forgedDesktop, "notHuman"],
      ["run credential", runCred, "notHuman"],
      ["MCP credential", mcpCred, "notHuman"],
      ["chat leader grant", chatLeader, "notHuman"],
      ["agent label on a cookie", agentLabel, "notHuman"],
      ["machine bearer", machineBearer, "notHuman"],
    ];
    for (const [who, actor, want] of table) assert.equal(check(actor, "create"), want, who);
  });

  it("takes the owner from the server's machine row, never from the caller", () => {
    assert.equal(check(owner, "create", { machine: { ...machine, owner: null } }), "notOwnerOrAdmin");
    assert.equal(check(owner, "create", { machine: { ...machine, owner: "someone" } }), "notOwnerOrAdmin");
    assert.equal(check(owner, "create", { machine: null }), "notFound");
  });

  it("keeps an admin below the machine's local opt-in and a fresh step-up", () => {
    assert.equal(check(admin, "create", { machine: { ...machine, capability: { ...cap, enabled: false } } }), "disabledLocally");
    assert.equal(check(admin, "create", { machine: { ...machine, capability: { ...cap, projects: [] } } }), "projectNotAllowed");
    assert.equal(check(admin, "create", { machine: { ...machine, capability: null } }), "needsUpgrade");
    assert.equal(check(admin, "create", { stepUp: false }), "stepUpRequired");
    assert.equal(check(owner, "capabilities", { stepUp: false }), "ok");
  });

  it("lets only the creator attach; admin and owner may stop it, not type in it", () => {
    const session = { creator: "owner", machineId: machine.id, project: "app", state: "detached" as const };
    assert.equal(check(owner, "attach", { session }), "ok");
    assert.equal(check(owner, "attach", { session, stepUp: false }), "stepUpRequired");
    assert.equal(check(admin, "attach", { session }), "notCreator");
    assert.equal(check(admin, "terminate", { session, stepUp: false }), "ok");
    assert.equal(check(lead, "terminate", { session }), "notOwnerOrAdmin");
    assert.equal(check(lead, "get", { session }), "notOwnerOrAdmin");
    assert.equal(check(owner, "attach", { session: { ...session, state: "closing" } }), "sessionClosed");
    assert.equal(check(owner, "terminate", { session: { ...session, state: "revoked" } }), "sessionClosed");
    assert.equal(check(owner, "recording", { session, stepUp: false }), "stepUpRequired");
    // A session id from another project or machine is not found through this one.
    assert.equal(check(owner, "get", { session: { ...session, project: "other" } }), "wrongProject");
    assert.equal(check(owner, "get", { session: { ...session, machineId: "runner@other" } }), "notFound");
    // An owner who lost the project loses the session with it.
    assert.equal(check(ownerViewer, "attach", { session }), "noProjectAccess");
  });

  it("accepts a machine report only from the session's machine", () => {
    const session = { creator: "owner", machineId: machine.id, project: "app", state: "active" as const };
    assert.equal(check(machineBearer, "machineReport", { session }), "ok");
    assert.equal(check({ ...machineBearer, name: "runner@other" }, "machineReport", { session }), "notMachine");
    assert.equal(check(admin, "machineReport", { session }), "notMachine");
    assert.equal(check({ ...machineBearer, runCredential: runCred.runCredential! }, "machineReport", { session }), "notMachine");
    // The name is a label anyone can give a token: another account's token named like the machine is not it.
    const table: Array<[string, Actor]> = [
      ["another account, same name", { ...machineBearer, account: "mallory" }],
      ["ownerless token, same name", { name: machine.id, role: "agent" }],
      ["the owner's viewer token", { ...machineBearer, role: "viewer" }],
      ["the owner's MCP credential", { ...machineBearer, mcpCredential: true }],
      ["legacy MCP on the machine token", { ...machineBearer, source: { via: "mcp" }, agent: "claude-1" }],
      ["agent label on the machine token", { ...machineBearer, source: { via: "api" }, agent: "claude-1" }],
      ["chat leader", { ...machineBearer, chatReply: 3 }],
      ["the owner's browser", { ...machineBearer, humanSession: "s-owner" }],
    ];
    for (const [who, actor] of table) assert.equal(check(actor, "machineReport", { session }), "notMachine", who);
    assert.equal(check({ name: machine.id, role: "agent" }, "machineReport", { session, machine: { ...machine, owner: null } }), "ok",
      "a machine on a token of no account, as /api/run-credentials accepts it");
    assert.equal(check(machineBearer, "machineReport", { session, machine: null }), "notFound");
  });

  it("keeps a deleted machine's sessions readable by their creator and admins only", () => {
    const session = { creator: "lead", machineId: machine.id, project: "app", state: "closed" as const };
    const gone = { machine: null, session };
    assert.equal(check(lead, "get", gone), "ok", "creator");
    assert.equal(check(lead, "recording", gone), "ok");
    assert.equal(check(lead, "recording", { ...gone, stepUp: false }), "stepUpRequired");
    assert.equal(check(admin, "get", gone), "ok", "admin");
    assert.equal(check(admin, "recording", gone), "ok");
    assert.equal(check(owner, "get", gone), "notOwnerOrAdmin", "its old owner owns nothing now");
    assert.equal(check(person("mallory", { access: { projects: { app: "lead" } } }), "recording", gone), "notOwnerOrAdmin");
    assert.equal(check(person("lead", { access: { projects: { other: "lead" } } }), "get", gone), "notFound", "creator who lost the project");
    assert.equal(check(admin, "get", { ...gone, session: { ...session, project: "other" } }), "wrongProject");
    assert.equal(check(lead, "terminate", { ...gone, session: { ...session, state: "detached" } }), "ok", "a stray live row can still be closed");
    assert.equal(check(lead, "list", { machine: null }), "ok");
    for (const op of ["capabilities", "create", "attach"] as const) assert.equal(check(admin, op, gone), "notFound", op);
  });

  it("maps denials to the RPC error codes", () => {
    assert.throws(() => assertTerminal({ op: "create", actor: adminBearer, hubEnabled: true, project: "app", machine }), { code: "forbidden" });
    assert.throws(() => assertTerminal({ op: "get", actor: owner, hubEnabled: true, project: "app", machine }), { code: "not_found" });
  });
});

describe("69a terminal schema", () => {
  const open = (key = crypto.randomUUID()) => ({ project: "app", machineId: machine.id, creator: "owner", browserSession: "s", checkoutRef: "repo", reason: "", idempotencyKey: key });

  it("migrates a full database by rewinding only the new migration", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hive-terminal-"));
    try {
      const file = path.join(dir, "db");
      const h = new SqliteHive(file);
      await h.call("tasks.create", { project: "app", id: "KEEP", title: "Preserved" }, { name: "admin", role: "admin" });
      const at = migrationIndex("CREATE TABLE terminal_sessions");
      h.db.exec(`DROP TABLE terminal_audit_chunks; DROP TABLE terminal_stepups; DROP TABLE terminal_tickets; DROP TABLE terminal_sessions;
        ALTER TABLE machines DROP COLUMN terminal_capability; PRAGMA user_version = ${at}`);
      h.close();
      const upgraded = new SqliteHive(file, { migrateTo: at + 1 });
      assert.equal((await upgraded.call("tasks.list", { project: "app" }, { name: "admin", role: "admin" })).length, 1);
      assert.equal(new TerminalStore(upgraded.db, () => new Date()).liveOnMachine(machine.id), 0);
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores the heartbeat capability and forgets it when an app stops sending it", async () => {
    const h = new SqliteHive(":memory:");
    const runner: Actor = { name: machine.id, role: "agent", account: "owner" };
    const stored = () => (h.db.prepare("SELECT terminal_capability AS c FROM machines WHERE id = ?").get(machine.id) as { c: string | null }).c;
    await h.call("machines.heartbeat", { machine: "mini", instance: "aaaaaaaa", terminal: cap } as never, runner);
    assert.deepEqual(JSON.parse(stored()!), cap);
    await h.call("machines.heartbeat", { machine: "mini", instance: "aaaaaaaa", terminal: { ...cap, protocol: "x" } } as never, runner);
    assert.equal(stored(), null, "a malformed capability does not fail the beat, and is not kept");
    await h.call("machines.heartbeat", { machine: "mini", instance: "aaaaaaaa", terminal: cap } as never, runner);
    await h.call("machines.heartbeat", { machine: "mini", instance: "aaaaaaaa" } as never, runner);
    assert.equal(stored(), null, "an older app is off, not left on");
    h.close();
  });

  it("opens one session per machine, idempotently, with an immutable scope", () => {
    const h = new SqliteHive(":memory:");
    const now = new Date("2026-10-07T00:00:00.000Z");
    const store = new TerminalStore(h.db, () => now);
    const key = crypto.randomUUID();
    const s = store.create(open(key));
    assert.equal(s.state, "requested");
    assert.equal(s.expiresAt, new Date(now.getTime() + TERMINAL_LIMITS.absoluteTtlMs).toISOString());
    assert.equal(store.create(open(key)).id, s.id, "a retried click opens nothing twice");
    assert.throws(() => store.create({ ...open(key), checkoutRef: "worktree:x" }), { code: "conflict" });
    assert.throws(() => store.create(open()), { code: "conflict" }, "maxSessions is 1");
    assert.throws(() => h.db.prepare("UPDATE terminal_sessions SET checkout_ref = 'worktree:x' WHERE id = ?").run(s.id), /immutable/);
    assert.deepEqual(store.list("app", { account: "other", admin: false }), []);
    assert.equal(store.list("app", { account: "other", admin: true }).length, 1);
    h.close();
  });

  it("lists for an owner the sessions of their machines, not another owner's", async () => {
    const h = new SqliteHive(":memory:");
    const store = new TerminalStore(h.db, () => new Date("2026-10-07T00:00:00.000Z"));
    await h.call("machines.heartbeat", { machine: "a", instance: "aaaaaaaa", terminal: cap } as never, { name: "runner.a@a", role: "agent", account: "alice" });
    await h.call("machines.heartbeat", { machine: "b", instance: "bbbbbbbb" } as never, { name: "runner.b@b", role: "agent", account: "bob" });
    const done = (s: { id: string; version: number }) => store.transition(s.id, s.version, "closed", "userClosed");
    const rootOnA = done(store.create({ ...open(), machineId: "runner.a@a", creator: "root" }));
    const bobOnB = done(store.create({ ...open(), machineId: "runner.b@b", creator: "bob" }));
    const aliceOnB = store.create({ ...open(), machineId: "runner.b@b", creator: "alice" });
    const ids = (account: string, admin = false) => store.list("app", { account, admin }).map((s) => s.id).sort();
    assert.deepEqual(ids("alice"), [rootOnA.id, aliceOnB.id].sort(), "her machine's, opened by an admin, and her own elsewhere");
    assert.deepEqual(ids("bob"), [bobOnB.id, aliceOnB.id].sort());
    assert.deepEqual(ids("root", true), [rootOnA.id, bobOnB.id, aliceOnB.id].sort());
    assert.deepEqual(ids("carol"), []);
    assert.deepEqual(store.machine("runner.a@a"), { id: "runner.a@a", owner: "alice", capability: cap });
    assert.equal(store.machine("runner.b@b")?.capability, null);
    h.db.prepare("DELETE FROM machines WHERE id = ?").run("runner.a@a");
    assert.equal(store.machine("runner.a@a"), null);
    assert.deepEqual(ids("alice"), [aliceOnB.id], "a deleted machine's sessions go back to their creators");
    assert.deepEqual(ids("root", true), [rootOnA.id, bobOnB.id, aliceOnB.id].sort(), "and stay for admins");
    h.close();
  });

  it("changes state only by compare-and-set along the state machine", () => {
    const h = new SqliteHive(":memory:");
    const store = new TerminalStore(h.db, () => new Date("2026-10-07T00:00:00.000Z"));
    const s = store.create(open());
    const starting = store.transition(s.id, s.version, "starting", "spawning");
    assert.throws(() => store.transition(s.id, s.version, "starting", "spawning"), { code: "conflict" }, "stale version");
    assert.throws(() => store.transition(s.id, starting.version, "closed", "userClosed"), { code: "conflict" }, "not along the machine");
    const active = store.transition(s.id, starting.version, "active", "spawned");
    const moved = store.takeControl(s.id, active.version);
    assert.equal(moved.writerEpoch, active.writerEpoch + 1);
    const revoked = store.transition(s.id, moved.version, "revoked", "parentRevoked", { cleanupUncertain: true });
    assert.equal(revoked.state, "revoked");
    assert.ok(revoked.closedAt);
    assert.equal(revoked.cleanupUncertain, true);
    assert.throws(() => store.takeControl(s.id, revoked.version), { code: "conflict" });
    assert.equal(store.liveOnMachine(machine.id), 0);
    store.create(open());
    h.close();
  });
});
