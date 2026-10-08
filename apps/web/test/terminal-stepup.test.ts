import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { after, before, describe, it } from "node:test";
import { TERMINAL_CLOSE, TERMINAL_WS_PROTOCOL, type TerminalCapability } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHubApp, terminalUpgrade } from "#web/app.ts";
import type { TerminalRelayContext } from "#web/terminal.ts";
import { TokenStore } from "#web/tokens.ts";
import { LoginThrottle, UserStore } from "#web/users.ts";

// 69c, through the hub's real routes and a real socket upgrade: step-up proofs and socket tickets cannot be skipped,
// replayed, moved to another context or outlive what they were bound to (AC02, and the revoke half of AC04).
const PASSWORD = "Correct-horse-battery-9";
const cap: TerminalCapability = { protocol: 1, enabled: true, projects: ["app"], platforms: ["linux"], auditReady: true, guiReady: true };

let hive: SqliteHive;
let users: UserStore;
let tokens: TokenStore;
let server: Server;
let base = "";
let port = 0;
const relayed: TerminalRelayContext[] = [];
let machineId = "";
let machineToken = "";
const ids: Record<string, string> = {};

function account(username: string, grants: Record<string, string>, admin = false): string {
  const { user, password } = users.create({ username, admin });
  users.changePassword(user.id, password, PASSWORD);
  if (!admin) users.setGrants(user.id, grants);
  ids[username] = user.id;
  return user.id;
}
const signIn = (username: string) => users.startSession(ids[username]!).token;

type Opts = { cookie?: string; bearer?: string; origin?: string | null; csrf?: boolean };
async function post(path: string, body: unknown, o: Opts = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.cookie) headers.cookie = `hive_session=${o.cookie}`;
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  if (o.csrf !== false) headers["x-hive-csrf"] = "1";
  if (o.origin !== null) headers.origin = o.origin ?? base;
  const res = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const json = (await res.json()) as { result?: any; error?: { code: string; key?: string } };
  return { status: res.status, result: json.result, key: json.error?.key ?? json.error?.code };
}
const rpc = (cookie: string, method: string, input: unknown, o: Opts = {}) => post("/api/rpc", { method, input }, { cookie, ...o });
const stepUp = (cookie: string, body: Record<string, unknown>, o: Opts = {}) => post("/api/terminal/step-up", body, { cookie, ...o });
const proofFor = async (cookie: string, body: Record<string, unknown> = {}) => {
  const r = await stepUp(cookie, { method: "password", password: PASSWORD, operation: "create", project: "app", machineId, ...body });
  assert.equal(r.status, 200, `step-up: ${r.key}`);
  return r.result.stepUpId as string;
};
const createInput = (stepUpId: string, idempotencyKey: string = crypto.randomUUID()) =>
  ({ project: "app", machineId, checkoutRef: "repo", mode: "shell", stepUpId, reason: "check the build", idempotencyKey });
/** Opens a session for alice and hands back its ticket. */
async function open(cookie: string) {
  const r = await rpc(cookie, "terminal.create", createInput(await proofFor(cookie)));
  assert.equal(r.status, 200, `create: ${r.key}`);
  return { session: r.result.session as { id: string; version: number; writerEpoch: number }, ticket: r.result.ticket as string };
}
async function end(cookie: string, sessionId: string) {
  assert.equal((await rpc(cookie, "terminal.terminate", { sessionId, reason: "emergencyStop" })).status, 200);
}
const heartbeat = (terminal: unknown) =>
  post("/api/rpc", { method: "machines.heartbeat", input: { machine: "mini", instance: "aaaaaaaa", projects: ["app"], terminal } }, { bearer: machineToken, origin: null, csrf: false });

// ── a WebSocket client small enough to send what a browser never would ──

type Upgrade = { status: number; socket?: Duplex; head?: Buffer };
function connect(o: { cookie?: string; origin?: string | null; protocol?: string | null; path?: string; bearer?: string; host?: string } = {}): Promise<Upgrade> {
  const headers: Record<string, string> = {
    connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"),
  };
  if (o.protocol !== null) headers["sec-websocket-protocol"] = o.protocol ?? TERMINAL_WS_PROTOCOL;
  if (o.origin !== null) headers.origin = o.origin ?? base;
  if (o.cookie) headers.cookie = `hive_session=${o.cookie}`;
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  if (o.host) headers.host = o.host;
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: o.path ?? "/api/terminal/socket", headers });
    req.on("upgrade", (_res, socket, head) => resolve({ status: 101, socket, head }));
    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode! });
    });
    req.on("error", reject);
    req.end();
  });
}
function clientFrame(text: string, o: { opcode?: number; masked?: boolean } = {}): Buffer {
  const payload = Buffer.from(text);
  const masked = o.masked !== false;
  const mask = randomBytes(4);
  const len = payload.length < 126 ? Buffer.from([(masked ? 0x80 : 0) | payload.length]) : Buffer.from([(masked ? 0x80 : 0) | 126, payload.length >> 8, payload.length & 0xff]);
  const body = masked ? Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!)) : payload;
  return Buffer.concat([Buffer.from([0x80 | (o.opcode ?? 1)]), len, masked ? mask : Buffer.alloc(0), body]);
}
/** The first server frame: a close with its code, or a text frame. */
function nextFrame(u: Upgrade): Promise<{ close?: number; text?: string }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.from(u.head ?? Buffer.alloc(0));
    const tryRead = () => {
      if (buf.length < 2) return;
      const len = buf[1]! & 0x7f;
      if (buf.length < 2 + len) return;
      const payload = buf.subarray(2, 2 + len);
      u.socket!.off("data", onData);
      resolve((buf[0]! & 0x0f) === 8 ? { close: payload.readUInt16BE(0) } : { text: payload.toString() });
    };
    const onData = (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      tryRead();
    };
    u.socket!.on("data", onData);
    u.socket!.on("error", reject);
    tryRead();
  });
}
/** Upgrades as the person with this cookie, sends this first frame, and tells how the hub answered. */
async function present(cookie: string, first: string | Buffer) {
  const u = await connect({ cookie });
  assert.equal(u.status, 101);
  u.socket!.write(typeof first === "string" ? clientFrame(JSON.stringify({ type: "auth", ticket: first })) : first);
  const f = await nextFrame(u);
  u.socket!.destroy();
  return f.close ?? f.text;
}

before(async () => {
  hive = new SqliteHive(":memory:");
  users = new UserStore(hive.db);
  tokens = new TokenStore(hive.db);
  account("alice", { app: "member" });
  account("mallory", { app: "lead" });
  account("root", {}, true);
  const app = createHubApp({
    hive, tokens, users, allowedHosts: ["127.0.0.1", "localhost"], remoteTerminal: true, throttle: new LoginThrottle(3, 60_000),
    terminalRelay: (socket, ctx) => {
      relayed.push(ctx);
      const text = Buffer.from("relayed");
      socket.end(Buffer.concat([Buffer.from([0x81, text.length]), text]));
    },
  });
  server = app.listen(0, "127.0.0.1");
  server.on("upgrade", terminalUpgrade(app));
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  // The hub, not the test, records who owns the machine: its heartbeat does.
  machineToken = tokens.create("mini", "member", ids.alice!).token;
  assert.equal((await heartbeat(cap)).status, 200);
  machineId = "mini";
});
after(() => {
  server.closeAllConnections();
  server.close();
  hive.close();
});

describe("69c terminal step-up", () => {
  it("is for a person at the hub's page only", async () => {
    const alice = signIn("alice");
    const body = { method: "password", password: PASSWORD, operation: "create", project: "app", machineId };
    assert.equal((await stepUp(alice, body, { origin: null })).key, "errors.crossSite", "no Origin");
    assert.equal((await stepUp(alice, body, { origin: "https://evil.example" })).key, "errors.crossSite");
    assert.equal((await stepUp(alice, body, { csrf: false })).key, "errors.crossSite");
    const bearers: Array<[string, string]> = [
      ["alice's machine token", machineToken],
      ["a hub admin token", tokens.create("ci", "admin").token],
      ["alice's MCP credential", tokens.issueMcp(machineToken, "app", false)],
    ];
    for (const [who, bearer] of bearers) {
      const r = await post("/api/terminal/step-up", body, { bearer });
      assert.equal(r.status, 403, who);
      assert.equal((await post("/api/rpc", { method: "terminal.create", input: createInput("hivestep_" + "a".repeat(43)) }, { bearer })).status, 403, `${who}: create`);
    }
  });

  it("asks nothing of someone the terminal would refuse anyway, and throttles wrong passwords", async () => {
    const mallory = signIn("mallory");
    const r = await stepUp(mallory, { method: "password", password: "wrong", operation: "create", project: "app", machineId });
    assert.equal(r.key, "errors.terminal.notOwnerOrAdmin", "a lead who does not own the machine: no password is even checked");
    const eve = signIn("alice");
    const wrong = { method: "password", password: "not it", operation: "create", project: "app", machineId };
    // A machine name nobody has: notFound, before any password.
    assert.equal((await stepUp(eve, { ...wrong, machineId: "nobody" })).key, "errors.terminal.notFound");
    for (let n = 0; n < 3; n++) assert.equal((await stepUp(eve, wrong)).key, "errors.terminal.stepUpPassword");
    assert.equal((await stepUp(eve, { ...wrong, password: PASSWORD })).key, "errors.tooManyAttempts", "the sign-in lock, also for the right password");
    // The lock is per address and account, as at sign-in; it also locks the hub's own sign-in.
    const login = await post("/api/login", { username: "alice", password: PASSWORD });
    assert.equal(login.key, "errors.tooManyAttempts");
    assert.equal((await stepUp(eve, { ...wrong, sessionId: crypto.randomUUID() })).key, "errors.terminal.stepUpRequest", "create names no session");
  });
});

describe("69c terminal proofs (bypass and replay)", () => {
  let alice = "";
  before(async () => {
    // The throttle of the test above is per address and account: a fresh hub account for the rest.
    account("alice2", { app: "member" });
    alice = signIn("alice2");
    // alice2 owns no machine: give her one of her own.
    const token = tokens.create("box", "member", ids.alice2!).token;
    const beat = await post("/api/rpc", { method: "machines.heartbeat", input: { machine: "box", instance: "bbbbbbbb", projects: ["app"], terminal: cap } }, { bearer: token, origin: null, csrf: false });
    assert.equal(beat.status, 200);
    machineId = "box";
  });

  it("opens nothing without a fresh proof of this person, browser, machine and project", async () => {
    assert.equal((await rpc(alice, "terminal.create", createInput("hivestep_" + "a".repeat(43)))).key, "errors.terminal.stepUpRequired", "made up");
    const otherBrowser = await proofFor(signIn("alice2"));
    assert.equal((await rpc(alice, "terminal.create", createInput(otherBrowser))).key, "errors.terminal.stepUpRequired", "her other browser's");
    const expired = await proofFor(alice);
    hive.db.prepare("UPDATE terminal_stepups SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    assert.equal((await rpc(alice, "terminal.create", createInput(expired))).key, "errors.terminal.stepUpRequired", "expired");
    // A forged source header changes nothing: only the cookie makes a person.
    const forged = await post("/api/rpc", { method: "terminal.create", input: createInput(await proofFor(alice)) }, { bearer: machineToken, origin: null, csrf: false });
    assert.equal(forged.key, "errors.terminal.notHuman");
  });

  it("spends a proof once, and a failed change leaves it unspent", async () => {
    const proof = await proofFor(alice);
    const key = crypto.randomUUID();
    const first = await rpc(alice, "terminal.create", createInput(proof, key));
    assert.equal(first.status, 200, first.key);
    assert.match(first.result.ticket, /^hivetkt_/);
    // The retried click gets its session back, without a ticket: those take a new proof.
    const retry = await rpc(alice, "terminal.create", createInput(proof, key));
    assert.equal(retry.result.session.id, first.result.session.id);
    assert.equal(retry.result.ticket, null);
    // The machine is busy (one session): the proof survives the refusal...
    const second = await proofFor(alice);
    assert.equal((await rpc(alice, "terminal.create", createInput(second))).key, "errors.terminal.busy");
    await end(alice, first.result.session.id);
    // ...and opens the next one; the first proof is spent.
    assert.equal((await rpc(alice, "terminal.create", createInput(proof))).key, "errors.terminal.stepUpRequired", "replay");
    const next = await rpc(alice, "terminal.create", createInput(second));
    assert.equal(next.status, 200, next.key);
    await end(alice, next.result.session.id);
  });

  it("binds attach and recording proofs to their operation and session", async () => {
    const { session } = await open(alice);
    const createProof = await proofFor(alice);
    const attach = (stepUpId: string) => rpc(alice, "terminal.attach", { sessionId: session.id, stepUpId, lastOutputSeq: 0 });
    assert.equal((await attach(createProof)).key, "errors.terminal.stepUpRequired", "a proof for create");
    const forAttach = await proofFor(alice, { operation: "attach", sessionId: session.id });
    assert.equal((await rpc(alice, "terminal.recording", { sessionId: session.id, stepUpId: forAttach })).key, "errors.terminal.stepUpRequired", "attach's proof for recording");
    const [a, b] = await Promise.all([attach(forAttach), attach(forAttach)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 403], "two racing attaches: one wins");
    // The step-up for a session must name its own machine and project.
    assert.equal((await stepUp(alice, { method: "password", password: PASSWORD, operation: "attach", project: "app", machineId: "mini", sessionId: session.id })).key, "errors.terminal.notFound");
    const rec = await rpc(alice, "terminal.recording", { sessionId: session.id, stepUpId: await proofFor(alice, { operation: "recording", sessionId: session.id }) });
    assert.deepEqual(rec.result, { chunks: [], next: null });
    // Another admin may stop it, never attach to it.
    const root = signIn("root");
    assert.equal((await stepUp(root, { method: "password", password: PASSWORD, operation: "attach", project: "app", machineId, sessionId: session.id })).key, "errors.terminal.notCreator");
    await end(root, session.id);
  });
});

describe("69c terminal socket (ticket replay and revoke)", () => {
  let alice = "";
  before(() => {
    alice = signIn("alice2");
  });

  it("hands a socket to the relay once, for the ticket's session and epoch", async () => {
    const { session, ticket } = await open(alice);
    assert.equal(await present(alice, ticket), "relayed");
    assert.equal(relayed.at(-1)!.session.id, session.id);
    assert.equal(relayed.at(-1)!.epoch, 0);
    assert.equal(relayed.at(-1)!.actor.account, "alice2");
    assert.equal(await present(alice, ticket), TERMINAL_CLOSE.ticket, "replay");
    await end(alice, session.id);
  });

  it("refuses an upgrade that is not the hub's page with a person's cookie", async () => {
    assert.equal((await connect({})).status, 401, "no cookie");
    assert.equal((await connect({ cookie: alice, origin: null })).status, 403, "no Origin");
    assert.equal((await connect({ cookie: alice, origin: "https://evil.example" })).status, 403, "another site");
    assert.equal((await connect({ cookie: alice, protocol: null })).status, 400, "not the terminal's protocol");
    assert.equal((await connect({ cookie: alice, bearer: machineToken })).status, 401, "a bearer beside the cookie");
    assert.equal((await connect({ bearer: machineToken })).status, 401, "a bearer alone");
    assert.equal((await connect({ cookie: alice, path: "/api/terminal/socket?ticket=x" })).status, 400, "anything in the query string");
    assert.equal((await connect({ cookie: alice, host: "evil.example", origin: "http://evil.example" })).status, 403, "a Host the hub does not answer to");
  });

  it("takes the ticket only from this browser session, in a proper first frame", async () => {
    const { session, ticket } = await open(alice);
    assert.equal(await present(signIn("alice2"), ticket), TERMINAL_CLOSE.ticket, "her other browser");
    assert.equal(await present(alice, clientFrame(JSON.stringify({ type: "auth", ticket }), { masked: false })), TERMINAL_CLOSE.protocol, "unmasked");
    assert.equal(await present(alice, clientFrame(JSON.stringify({ type: "auth", ticket }), { opcode: 2 })), TERMINAL_CLOSE.protocol, "binary");
    assert.equal(await present(alice, clientFrame(JSON.stringify({ type: "input", ticket }))), TERMINAL_CLOSE.ticket, "not an auth frame");
    // None of those spent it.
    assert.equal(await present(alice, ticket), "relayed");
    await end(alice, session.id);
  });

  it("closes a socket that sends no ticket in time", { timeout: 15_000 }, async () => {
    const u = await connect({ cookie: alice });
    assert.equal((await nextFrame(u)).close, TERMINAL_CLOSE.timeout);
    u.socket!.destroy();
  });

  it("checks everything again when the ticket comes: expiry, session end, takeover, opt-out, lost grant, sign-out", async () => {
    const expired = await open(alice);
    hive.db.prepare("UPDATE terminal_tickets SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    assert.equal(await present(alice, expired.ticket), TERMINAL_CLOSE.ticket, "expired");
    await end(alice, expired.session.id);

    const ended = await open(alice);
    await end(alice, ended.session.id);
    assert.equal(await present(alice, ended.ticket), TERMINAL_CLOSE.ticket, "its session was stopped");

    // A newer writer epoch (another tab took control) leaves the old ticket behind.
    const taken = await open(alice);
    hive.db.prepare("UPDATE terminal_sessions SET state = 'active', writer_epoch = writer_epoch + 1 WHERE id = ?").run(taken.session.id);
    assert.equal(await present(alice, taken.ticket), TERMINAL_CLOSE.denied, "stale epoch");
    await end(alice, taken.session.id);

    const optOut = await open(alice);
    const token = tokens.create("box", "member", ids.alice2!).token;
    const beat = (terminal: unknown) =>
      post("/api/rpc", { method: "machines.heartbeat", input: { machine: "box", instance: "bbbbbbbb", projects: ["app"], terminal } }, { bearer: token, origin: null, csrf: false });
    assert.equal((await beat({ ...cap, enabled: false })).status, 200);
    assert.equal(await present(alice, optOut.ticket), TERMINAL_CLOSE.denied, "the machine turned the terminal off");
    await beat(cap);
    await end(alice, optOut.session.id);

    const grant = await open(alice);
    users.setGrants(ids.alice2!, { app: "viewer" });
    assert.equal(await present(alice, grant.ticket), TERMINAL_CLOSE.denied, "a viewer may not drive a shell");
    users.setGrants(ids.alice2!, { app: "member" });
    await end(alice, grant.session.id);

    const out = await open(alice);
    const proof = await proofFor(alice);
    assert.equal((await post("/api/logout", {}, { cookie: alice })).status, 200);
    assert.equal((await connect({ cookie: alice })).status, 401, "signed out");
    assert.equal(hive.db.prepare("SELECT COUNT(*) AS n FROM terminal_stepups WHERE used_at IS NULL AND browser_session = (SELECT browser_session FROM terminal_sessions WHERE id = ?)").get(out.session.id)!.n, 0,
      "and nothing unspent of that browser session is left");
    void proof;
    alice = signIn("alice2");
    await end(alice, out.session.id);
  });

  it("keeps the machine socket for a machine's bearer, and has no relay for it yet", async () => {
    const path = "/api/terminal/machine-socket";
    assert.equal((await connect({ path, cookie: signIn("alice2"), origin: null })).status, 401, "a person's cookie");
    assert.equal((await connect({ path, origin: null })).status, 401, "nothing");
    assert.equal((await connect({ path, bearer: tokens.issueMcp(machineToken, "app", false), origin: null })).status, 403, "an MCP credential");
    assert.equal((await connect({ path, bearer: tokens.create("watch", "viewer", ids.alice!).token, origin: null })).status, 403, "a viewer token");
    assert.equal((await connect({ path, bearer: machineToken, origin: null })).status, 503, "a machine: SEC-machine-identity and 69e come first");
  });
});

describe("69c terminal kill switch", () => {
  it("issues no proof and takes no socket while the hub flag is off", async () => {
    const off = new SqliteHive(":memory:");
    const offUsers = new UserStore(off.db);
    const { user, password } = offUsers.create({ username: "admin", admin: true });
    offUsers.changePassword(user.id, password, PASSWORD);
    const app = createHubApp({ hive: off, tokens: new TokenStore(off.db), users: offUsers, allowedHosts: ["127.0.0.1"] });
    const s = app.listen(0, "127.0.0.1");
    s.on("upgrade", terminalUpgrade(app));
    await new Promise((r) => s.once("listening", r));
    const offPort = (s.address() as AddressInfo).port;
    try {
      const cookie = offUsers.startSession(user.id).token;
      const r = await fetch(`http://127.0.0.1:${offPort}/api/terminal/step-up`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `hive_session=${cookie}`, "x-hive-csrf": "1", origin: `http://127.0.0.1:${offPort}` },
        body: JSON.stringify({ method: "password", password: PASSWORD, operation: "create", project: "app", machineId: "any" }),
      });
      assert.equal(((await r.json()) as { error: { key: string } }).error.key, "errors.terminal.hubDisabled");
      const status = await new Promise<number>((resolve) => {
        const req = request({ host: "127.0.0.1", port: offPort, path: "/api/terminal/socket", headers: {
          connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"),
          "sec-websocket-protocol": TERMINAL_WS_PROTOCOL, origin: `http://127.0.0.1:${offPort}`, cookie: `hive_session=${cookie}`,
        } });
        req.on("response", (res) => { res.resume(); resolve(res.statusCode!); });
        req.on("upgrade", (_res, socket) => { socket.destroy(); resolve(101); });
        req.end();
      });
      assert.equal(status, 403);
    } finally {
      s.closeAllConnections();
      s.close();
      off.close();
    }
  });
});
