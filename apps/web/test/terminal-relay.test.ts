import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { after, afterEach, before, describe, it } from "node:test";
import {
  TERMINAL_MACHINE_WS_PROTOCOL,
  TERMINAL_RELAY_CLOSE,
  TERMINAL_WS_PROTOCOL,
  type TerminalCapability,
  type TerminalHubFrame,
  type TerminalMachineFrame,
  type TerminalServerFrame,
} from "@xdev-hive/core";
import { SqliteHive, WsPeer, type TerminalMachineIdentity } from "@xdev-hive/core/node";
import { createHubApp, terminalUpgrade } from "#web/app.ts";
import { TokenStore } from "#web/tokens.ts";
import { LoginThrottle, UserStore } from "#web/users.ts";

// 69e through the hub's real routes and sockets, with a scripted machine and browser so faults can be injected
// exactly: lost acks, dropped sockets, a reader that stops reading, a machine that restarts, rights lost mid-session
// (AC04, AC05).
const PASSWORD = "Correct-horse-battery-9";
const cap: TerminalCapability = { protocol: 1, enabled: true, projects: ["app"], platforms: ["linux"], auditReady: true, guiReady: true };
const TIMINGS = { leaseMs: 800, leaseRenewMs: 150, detachedMs: 1500, idleInputMs: 20_000, heartbeatMs: 5000, heartbeatTimeoutMs: 10_000, slowConsumerMs: 200, firstFrameMs: 2000 };

let hive: SqliteHive;
let users: UserStore;
let tokens: TokenStore;
let server: Server;
let base = "";
let port = 0;
let machineToken = "";
let otherToken = "";
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

/** The hub's own wiring (server.ts): the machine row runner.mini@mini is pinned to alice's "mini" token at its heartbeat. */
const MACHINE = "runner.mini@mini";
const RUNNER = { "x-hive-agent": "runner.mini", "x-hive-source": JSON.stringify({ via: "desktop" }) };
const identity: TerminalMachineIdentity = {
  isMachineActor: (machineId, actor) => hive.isMachineActor(machineId, actor),
  pinnedOwner: (machineId) => hive.machinePinnedOwner(machineId),
};

function account(username: string, grants: Record<string, string>, admin = false): void {
  const { user, password } = users.create({ username, admin });
  users.changePassword(user.id, password, PASSWORD);
  if (!admin) users.setGrants(user.id, grants);
  ids[username] = user.id;
}

async function post(path: string, body: unknown, o: { cookie?: string; bearer?: string; agent?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-hive-csrf": "1", origin: base };
  if (o.cookie) headers.cookie = `hive_session=${o.cookie}`;
  if (o.bearer) {
    headers.authorization = `Bearer ${o.bearer}`;
    if (o.agent) headers["x-hive-agent"] = o.agent;
    delete headers.origin;
  }
  const res = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const json = (await res.json()) as { result?: any; error?: { code: string; key?: string } };
  return { status: res.status, result: json.result, key: json.error?.key ?? json.error?.code };
}
const rpc = (cookie: string, method: string, input: unknown) => post("/api/rpc", { method, input }, { cookie });
const heartbeat = (terminal: unknown) =>
  post("/api/rpc", { method: "machines.heartbeat", input: { machine: "mini", instance: "aaaaaaaa", projects: ["app"], terminal } }, { bearer: machineToken, agent: RUNNER["x-hive-agent"] });
async function proof(cookie: string, operation: "create" | "attach", sessionId?: string) {
  const r = await post("/api/terminal/step-up", { method: "password", password: PASSWORD, operation, project: "app", machineId: MACHINE, ...(sessionId ? { sessionId } : {}) }, { cookie });
  assert.equal(r.status, 200, `step-up: ${r.key}`);
  return r.result.stepUpId as string;
}
const session = (id: string) => hive.db.prepare("SELECT state, last_reason, writer_epoch, exit_code, cleanup_uncertain FROM terminal_sessions WHERE id = ?").get(id) as
  { state: string; last_reason: string; writer_epoch: number; exit_code: number | null; cleanup_uncertain: number };
const audits = (action: string) => (hive.db.prepare("SELECT detail FROM audit WHERE action = ?").all(action) as Array<{ detail: string }>).map((r) => r.detail);

// ── a peer that records frames and waits for the one it needs ──

class Peer<In extends { type: string }> {
  frames: In[] = [];
  closed: number | null | undefined = undefined;
  readonly peer: WsPeer;
  #waiters: Array<() => void> = [];
  constructor(socket: Duplex, head: Buffer) {
    this.peer = new WsPeer(socket, {
      maxPayload: 1 << 20, server: false,
      onText: (t) => { this.frames.push(JSON.parse(t)); this.#wake(); },
      onClose: (code) => { this.closed = code; this.#wake(); },
    }, head);
  }
  #wake() { for (const w of this.#waiters.splice(0)) w(); }
  send(f: unknown) { this.peer.send(f); }
  of<T extends In["type"]>(type: T): Array<Extract<In, { type: T }>> { return this.frames.filter((f) => f.type === type) as Array<Extract<In, { type: T }>>; }
  async wait<T extends In["type"]>(type: T, pred: (f: Extract<In, { type: T }>) => boolean = () => true, ms = 3000): Promise<Extract<In, { type: T }>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.of(type).find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`no ${type} frame within ${ms} ms; got ${JSON.stringify(this.frames.map((f) => f.type))}`);
      await new Promise<void>((r) => { this.#waiters.push(r); setTimeout(r, 50); });
    }
  }
  async waitClose(ms = 3000): Promise<number | null> {
    const deadline = Date.now() + ms;
    while (this.closed === undefined) {
      if (Date.now() > deadline) throw new Error("socket still open");
      await new Promise<void>((r) => { this.#waiters.push(r); setTimeout(r, 50); });
    }
    return this.closed;
  }
}

function upgrade(path: string, headers: Record<string, string>): Promise<{ status: number; socket?: Duplex; head?: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: {
      connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"), ...headers,
    } });
    req.on("upgrade", (_res, socket, head) => resolve({ status: 101, socket, head }));
    req.on("response", (res) => { res.resume(); resolve({ status: res.statusCode! }); });
    req.on("error", reject);
    req.end();
  });
}

type Machine = Peer<TerminalHubFrame>;
type Browser = Peer<TerminalServerFrame>;

async function machine(running: string[] = [], token = machineToken): Promise<Machine> {
  const u = await upgrade("/api/terminal/machine-socket", { ...RUNNER, authorization: `Bearer ${token}`, "sec-websocket-protocol": TERMINAL_MACHINE_WS_PROTOCOL });
  assert.equal(u.status, 101);
  const m = new Peer<TerminalHubFrame>(u.socket!, u.head!);
  m.send({ type: "hello", protocol: 1, sessions: running } satisfies TerminalMachineFrame);
  return m;
}
async function browser(cookie: string, ticket: string): Promise<Browser> {
  const u = await upgrade("/api/terminal/socket", { cookie: `hive_session=${cookie}`, origin: base, "sec-websocket-protocol": TERMINAL_WS_PROTOCOL });
  assert.equal(u.status, 101);
  const b = new Peer<TerminalServerFrame>(u.socket!, u.head!);
  b.send({ type: "auth", ticket });
  return b;
}
const out = (m: Machine, sessionId: string, outputSeq: number, text: string) =>
  m.send({ type: "output", sessionId, epoch: 0, outputSeq, data: Buffer.from(text).toString("base64") } satisfies TerminalMachineFrame);
const report = (m: Machine, sessionId: string, state: string, reason: string, exitCode: number | null = null) =>
  m.send({ type: "report", sessionId, epoch: 0, state, reason, exitCode, auditSeq: 0, cleanupUncertain: false });

/** alice's live session: created, attached, spawned on the machine, output flowing. */
async function running(m: Machine) {
  const cookie = cookies.alice!;
  const r = await rpc(cookie, "terminal.create", { project: "app", machineId: MACHINE, checkoutRef: "repo", mode: "shell", stepUpId: await proof(cookie, "create"), reason: "relay test", idempotencyKey: crypto.randomUUID() });
  assert.equal(r.status, 200, `create: ${r.key}`);
  const id = r.result.session.id as string;
  const b = await browser(cookie, r.result.ticket);
  const open = await m.wait("open", (f) => f.sessionId === id);
  assert.equal(open.checkoutRef, "repo");
  report(m, id, "active", "spawned");
  await b.wait("state", (f) => f.state === "active");
  b.send({ type: "ack", outputSeq: 0 });
  await m.wait("replay", (f) => f.sessionId === id && f.afterSeq === 0);
  return { id, b };
}
async function attach(cookie: string, sessionId: string, takeControl = false) {
  const r = await rpc(cookie, "terminal.attach", { sessionId, stepUpId: await proof(cookie, "attach", sessionId), lastOutputSeq: 0, takeControl });
  assert.equal(r.status, 200, `attach: ${r.key}`);
  return r.result as { ticket: string; epoch: number };
}
const live: Array<{ id: string; m?: Machine; b?: Browser }> = [];
afterEach(async () => {
  for (const l of live.splice(0)) {
    if (!["closed", "expired", "revoked", "failed"].includes(session(l.id).state)) await rpc(cookies.root!, "terminal.terminate", { sessionId: l.id, reason: "emergencyStop" });
    l.b?.peer.socket.destroy();
    l.m?.peer.socket.destroy();
  }
  users.setGrants(ids.alice!, { app: "member" });
  await heartbeat(cap);
  await new Promise((r) => setTimeout(r, 120));
});

before(async () => {
  hive = new SqliteHive(":memory:");
  users = new UserStore(hive.db);
  tokens = new TokenStore(hive.db);
  account("alice", { app: "member" });
  account("root", {}, true);
  const app = createHubApp({
    hive, tokens, users, allowedHosts: ["127.0.0.1", "localhost"], remoteTerminal: true, throttle: new LoginThrottle(100, 60_000),
    terminalIdentity: identity, terminalTimings: TIMINGS,
  });
  server = app.listen(0, "127.0.0.1");
  server.on("upgrade", terminalUpgrade(app));
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  machineToken = tokens.create("mini", "member", ids.alice!).token;
  otherToken = tokens.create("mini", "member", ids.root!).token;
  assert.equal((await heartbeat(cap)).status, 200);
  cookies.alice = users.startSession(ids.alice!).token;
  cookies.root = users.startSession(ids.root!).token;
});
after(() => {
  (server as unknown as { closeAllConnections(): void }).closeAllConnections();
  server.close();
});

describe("69e machine socket", () => {
  it("takes only the bearer the machine row is pinned to, speaking the machine protocol", async () => {
    // Same name, another account: what a heartbeat collision would look like.
    assert.equal((await upgrade("/api/terminal/machine-socket", { ...RUNNER, authorization: `Bearer ${otherToken}`, "sec-websocket-protocol": TERMINAL_MACHINE_WS_PROTOCOL })).status, 403);
    assert.equal((await upgrade("/api/terminal/machine-socket", { ...RUNNER, authorization: `Bearer ${machineToken}` })).status, 400);
    assert.equal((await upgrade("/api/terminal/machine-socket", { cookie: `hive_session=${cookies.alice}`, "sec-websocket-protocol": TERMINAL_MACHINE_WS_PROTOCOL })).status, 401);
    const m = await machine();
    m.peer.socket.destroy();
  });

  it("closes a machine whose first frame is not hello", async () => {
    const u = await upgrade("/api/terminal/machine-socket", { ...RUNNER, authorization: `Bearer ${machineToken}`, "sec-websocket-protocol": TERMINAL_MACHINE_WS_PROTOCOL });
    const m = new Peer<TerminalHubFrame>(u.socket!, u.head!);
    m.send({ type: "pong", nonce: "x" });
    assert.equal(await m.waitClose(), TERMINAL_RELAY_CLOSE.protocol);
  });
});

describe("69e relay: sequence and dedup", () => {
  it("relays output in order once, input once, and acks only what the machine acked", async () => {
    const m = await machine();
    const { id, b } = await running(m);
    live.push({ id, m, b });
    out(m, id, 1, "one");
    out(m, id, 2, "two");
    out(m, id, 2, "two again");
    out(m, id, 1, "stale");
    out(m, id, 3, "three");
    await b.wait("output", (f) => f.outputSeq === 3);
    assert.deepEqual(b.of("output").map((f) => Buffer.from(f.data, "base64").toString()), ["one", "two", "three"]);

    b.send({ type: "input", epoch: 0, inputSeq: 1, data: Buffer.from("ls\r").toString("base64") });
    const input = await m.wait("input", (f) => f.inputSeq === 1);
    assert.equal(Buffer.from(input.data, "base64").toString(), "ls\r");
    // The machine's ack is lost: nothing is resent, and the browser never sees an ack it did not get.
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(m.of("input").length, 1);
    assert.equal(b.of("inputAck").length, 0);
    // An ack under another epoch is not this tab's.
    m.send({ type: "inputAck", sessionId: id, epoch: 3, inputSeq: 1 } satisfies TerminalMachineFrame);
    m.send({ type: "inputAck", sessionId: id, epoch: 0, inputSeq: 1 } satisfies TerminalMachineFrame);
    await b.wait("inputAck", (f) => f.inputSeq === 1);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(b.of("inputAck").length, 1);

    // A forged epoch never reaches the machine, and is counted.
    b.send({ type: "input", epoch: 7, inputSeq: 2, data: Buffer.from("x").toString("base64") });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(m.of("input").length, 1);
    assert.ok(audits("terminal.inputRejected").some((d) => d.includes("staleEpoch")));
    // The hub renews the lease while the session may run.
    await m.wait("lease", (f) => f.sessionId === id);
  });

  it("cuts off a machine that sends frames about a session it does not run, relaying none of them", async () => {
    const m = await machine();
    const { id, b } = await running(m);
    live.push({ id, m, b });
    out(m, id, 1, "real");
    await b.wait("output");
    out(m, "00000000-0000-4000-8000-00000000dead", 2, "forged");
    assert.equal(await m.waitClose(), TERMINAL_RELAY_CLOSE.protocol);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(b.of("output").map((f) => Buffer.from(f.data, "base64").toString()), ["real"]);
    assert.ok(audits("terminal.frameRejected").some((d) => d.includes("foreignSession")));
  });
});

describe("69e relay: reconnect", () => {
  it("detaches on a lost browser and replays from what the browser had, never resending input", async () => {
    const m = await machine();
    const { id, b } = await running(m);
    live.push({ id, m });
    out(m, id, 1, "before");
    await b.wait("output");
    b.send({ type: "ack", outputSeq: 1 });
    b.peer.socket.destroy();
    await m.wait("detach", (f) => f.sessionId === id);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(session(id).state, "detached");

    const t = await attach(cookies.alice!, id);
    const b2 = await browser(cookies.alice!, t.ticket);
    live.at(-1)!.b = b2;
    await b2.wait("state", (f) => f.state === "active");
    assert.equal(session(id).last_reason, "reattached");
    b2.send({ type: "ack", outputSeq: 1 });
    await m.wait("replay", (f) => f.afterSeq === 1);
    // The machine's ring no longer reaches back: the browser is told, never handed a partial transcript as whole.
    m.send({ type: "gap", sessionId: id, firstAvailableSeq: 5 } satisfies TerminalMachineFrame);
    out(m, id, 5, "after");
    await b2.wait("gap", (f) => f.firstAvailableSeq === 5);
    await b2.wait("output", (f) => f.outputSeq === 5);
    assert.equal(m.of("input").length, 0);
  });

  it("drops input while the machine is away and does not deliver it when the machine is back", async () => {
    const m = await machine();
    const { id, b } = await running(m);
    live.push({ id, b });
    m.peer.socket.destroy();
    await new Promise((r) => setTimeout(r, 100));
    b.send({ type: "input", epoch: 0, inputSeq: 1, data: Buffer.from("rm -rf build\r").toString("base64") });
    await new Promise((r) => setTimeout(r, 100));
    const m2 = await machine([id]);
    live.at(-1)!.m = m2;
    await m2.wait("lease", (f) => f.sessionId === id);
    await m2.wait("replay", (f) => f.sessionId === id);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(m2.of("input").length, 0);
    assert.equal(b.of("inputAck").length, 0);
    assert.ok(audits("terminal.inputRejected").some((d) => d.includes("machineOffline")));
  });

  it("fails a session the machine lost in a restart, never respawning it", async () => {
    const m = await machine();
    const { id, b } = await running(m);
    live.push({ id, b });
    m.peer.socket.destroy();
    const m2 = await machine([]);
    live.at(-1)!.m = m2;
    await b.wait("state", (f) => f.state === "failed");
    assert.deepEqual([session(id).state, session(id).last_reason, session(id).cleanup_uncertain], ["failed", "supervisorRestart", 1]);
    assert.equal(m2.of("open").length, 0);
  });

  it("kills what a reconnecting machine still runs that the hub already ended", async () => {
    const m = await machine();
    const { id, b } = await running(m);
    live.push({ id, b });
    m.peer.socket.destroy();
    await rpc(cookies.alice!, "terminal.terminate", { sessionId: id, reason: "emergencyStop" });
    const m2 = await machine([id]);
    live.at(-1)!.m = m2;
    const kill = await m2.wait("kill", (f) => f.sessionId === id);
    assert.equal(kill.reason, "emergencyStop");
    // What the machine learns while killing still lands on the ended row.
    m2.send({ type: "report", sessionId: id, epoch: 0, state: "revoked", reason: "emergencyStop", exitCode: 143, auditSeq: 0, cleanupUncertain: true } satisfies TerminalMachineFrame);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual([session(id).state, session(id).exit_code, session(id).cleanup_uncertain], ["revoked", 143, 1]);
  });
});

describe("69e relay: one writer", () => {
  it("takes control with a new epoch, closes the old tab and refuses its input", async () => {
    const m = await machine();
    const { id, b } = await running(m);
    live.push({ id, m });
    const t = await attach(cookies.alice!, id, true);
    assert.equal(t.epoch, 1);
    const b2 = await browser(cookies.alice!, t.ticket);
    live.at(-1)!.b = b2;
    assert.equal(await b.waitClose(), TERMINAL_RELAY_CLOSE.superseded);
    // The machine hears the new epoch with the next lease, so input of the old one is refused there too.
    await m.wait("lease", (f) => f.epoch === 1);
    b2.send({ type: "input", epoch: 1, inputSeq: 1, data: Buffer.from("x").toString("base64") });
    await m.wait("input", (f) => f.epoch === 1);
  });
});

describe("69e relay: backpressure", () => {
  it("lets go of a browser that stops acking, without killing the shell", async () => {
    const m = await machine();
    const { id, b } = await running(m);
    live.push({ id, m, b });
    const chunk = "x".repeat(32 * 1024);
    // Past high water (1 MiB) without one ack, then longer than slowConsumerMs.
    for (let i = 1; i <= 34; i++) out(m, id, i, chunk);
    await b.wait("output", (f) => f.outputSeq === 34, 5000);
    await new Promise((r) => setTimeout(r, TIMINGS.slowConsumerMs + 50));
    out(m, id, 35, chunk);
    assert.equal(await b.waitClose(), TERMINAL_RELAY_CLOSE.slow);
    await m.wait("detach", (f) => f.sessionId === id);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(session(id).state, "detached");
    assert.ok(audits("terminal.slowConsumer").length >= 1);
  });
});

describe("69e relay: revoke and lease", () => {
  it("kills within 2 s when the person loses the grant", async () => {
    const m = await machine();
    const { id, b } = await running(m);
    live.push({ id, m, b });
    const t0 = Date.now();
    users.setGrants(ids.alice!, {});
    const kill = await m.wait("kill", (f) => f.sessionId === id);
    assert.ok(Date.now() - t0 < 2000, `kill after ${Date.now() - t0} ms`);
    assert.equal(kill.reason, "accessRevoked");
    assert.equal(await b.waitClose(), TERMINAL_RELAY_CLOSE.ended);
    assert.equal(session(id).state, "revoked");
  });

  it("kills within 2 s on sign-out", async () => {
    const cookie = users.startSession(ids.alice!).token;
    const saved = cookies.alice;
    cookies.alice = cookie;
    try {
      const m = await machine();
      const { id, b } = await running(m);
      live.push({ id, m, b });
      const t0 = Date.now();
      users.endSession(cookie);
      const kill = await m.wait("kill", (f) => f.sessionId === id);
      assert.ok(Date.now() - t0 < 2000);
      assert.equal(kill.reason, "logout");
    } finally {
      cookies.alice = saved!;
    }
  });

  it("kills when the machine opts out locally", async () => {
    const m = await machine();
    const { id, b } = await running(m);
    live.push({ id, m, b });
    await heartbeat({ ...cap, enabled: false });
    const kill = await m.wait("kill", (f) => f.sessionId === id);
    assert.equal(kill.reason, "localOptOut");
  });

  it("kills a session the person closed, and records the machine's exit", async () => {
    const m = await machine();
    const { id, b } = await running(m);
    live.push({ id, m, b });
    await rpc(cookies.alice!, "terminal.terminate", { sessionId: id, reason: "userClosed" });
    const kill = await m.wait("kill", (f) => f.sessionId === id);
    assert.equal(kill.reason, "userClosed");
    report(m, id, "closed", "userClosed", 0);
    await b.waitClose();
    assert.deepEqual([session(id).state, session(id).exit_code], ["closed", 0]);
  });

  it("gives up a session whose machine is gone longer than the lease", async () => {
    const m = await machine();
    const { id, b } = await running(m);
    live.push({ id, b });
    // A partition: no close, no frame, the socket just goes silent and drops.
    m.peer.socket.destroy();
    const t0 = Date.now();
    await b.wait("state", (f) => f.state === "expired", 3000);
    assert.ok(Date.now() - t0 >= TIMINGS.leaseMs - 100);
    assert.equal(session(id).last_reason, "leaseLost");
  });

  it("expires a session left detached past its grace", async () => {
    const m = await machine();
    const { id, b } = await running(m);
    live.push({ id, m });
    b.peer.socket.destroy();
    const kill = await m.wait("kill", (f) => f.sessionId === id, TIMINGS.detachedMs + 2000);
    assert.equal(kill.reason, "detachedTimeout");
    assert.equal(session(id).state, "expired");
  });

  it("records an exit the shell made by itself", async () => {
    const m = await machine();
    const { id, b } = await running(m);
    live.push({ id, m, b });
    report(m, id, "closed", "exited", 3);
    await b.wait("state", (f) => f.state === "closed");
    assert.deepEqual([session(id).state, session(id).last_reason, session(id).exit_code], ["closed", "exited", 3]);
  });
});
