// Ngắt phiên, tắt từ xa và audit đủ của phần từ xa (specs/010 T041, US5, SC-006). Worker giả qua /ws/worker, trình
// duyệt giả qua /ws/terminal như ws.db.test.ts; worker giả tự trả các gói mà worker thật gửi sau khi kiểm.
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  REMOTE_AUDIT_ACTIONS,
  type RemoteServerFrame,
  remoteServerFrame,
  TERMINAL_WS_CLOSE,
} from "@xdev-hive/contracts";
import { type HubToWorker, hubToWorker, PROTOCOL_VERSION } from "@xdev-hive/contracts/worker-protocol";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import WebSocket from "ws";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { attachWorkerGateway, createRegistration, registerMachine, registerTerminalHandlers } from "../fleet/index.ts";
import { createPool, type Tx, withTenant } from "../platform/index.ts";
import { closeRemoteSession } from "./close.ts";
import { disableRemote } from "./devices.ts";
import { createTerminalHandlers } from "./gateway.ts";
import { liveSession, resetMachineBuckets } from "./live.ts";
import { getRemoteSession, listRemoteSessions } from "./queries.ts";
import { attachTerminalGateway, remoteTicket, TOTP_DEVICE_ID, withRemoteLive } from "./ws.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const tag = randomUUID().slice(0, 6);
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const closers: Array<() => Promise<void> | void> = [];
const publicUrl = "https://hive.example.vn/";
const ephPub = `B${"A".repeat(86)}`;
const mac = "A".repeat(22);
const totp = { kind: "totp", code: "123456", ephPub, ts: 1_791_999_990, nonce: "rh92dopMeUqiZuhXLhBUxQ" } as const;
const deviceId = "phone-0001";
const tok = (s: string) => Buffer.from(`resume-${s}`).toString("base64url");

let org: OrgFixture & { user: (n: string) => string };
let host = "";
let machineId = "";
let worker: Worker;

class Inbox<T> {
  readonly all: T[] = [];
  push(m: T) {
    this.all.push(m);
  }
  async until(match: (m: T) => boolean, ms = 4000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const found = this.all.find(match);
      if (found) return found;
      if (Date.now() > end) throw new Error("Hết thời gian chờ gói");
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

class Worker {
  readonly ws: WebSocket;
  readonly inbox = new Inbox<HubToWorker>();
  constructor(token: string) {
    this.ws = new WebSocket(`ws://${host}/ws/worker`, { headers: { authorization: `Bearer ${token}` } });
    this.ws.on("message", (data) => this.inbox.push(hubToWorker.parse(JSON.parse(data.toString()))));
  }
  static async connect(token: string, id: string) {
    const w = new Worker(token);
    await new Promise<void>((resolve, reject) => {
      w.ws.once("open", () => resolve());
      w.ws.once("error", reject);
    });
    w.send({
      type: "hello",
      machineId: id,
      version: "0.9.0",
      protoRange: [1, 1],
      os: "darwin",
      clis: ["claude"],
      capacity: 1,
      capabilities: ["terminal"],
    });
    await w.inbox.until((m) => m.type === "welcome");
    closers.push(() => w.ws.close());
    return w;
  }
  send(msg: Record<string, unknown>) {
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), ...msg }));
  }
  forConn<T extends HubToWorker["type"]>(type: T, connId: string) {
    return this.inbox.until((m) => m.type === type && "connId" in m && m.connId === connId) as Promise<
      Extract<HubToWorker, { type: T }>
    >;
  }
  forSession<T extends HubToWorker["type"]>(type: T, sessionId: string) {
    return this.inbox.until((m) => m.type === type && "sessionId" in m && m.sessionId === sessionId) as Promise<
      Extract<HubToWorker, { type: T }>
    >;
  }
}

async function browser(ticket: string) {
  const ws = new WebSocket(`ws://${host}/ws/terminal?ticket=${encodeURIComponent(ticket)}`, {
    headers: { origin: `http://${host}` },
  });
  const inbox = new Inbox<RemoteServerFrame>();
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  ws.on("message", (data) => inbox.push(remoteServerFrame.parse(JSON.parse(data.toString()))));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  closers.push(() => ws.close());
  const send = (f: Record<string, unknown>) => ws.send(JSON.stringify(f));
  const hello = async () => (await inbox.until((f) => f.t === "hello")) as Extract<RemoteServerFrame, { t: "hello" }>;
  return { ws, inbox, closed, send, hello };
}

const as = <T>(who: string, fn: (tx: Tx, userId: string) => Promise<T>) =>
  withTenant(pool, { userId: org.user(who), orgId: org.orgId }, (tx) => fn(tx, org.user(who)));

const ticketFor = async (who: string, sessionId: string) =>
  (await as(who, (tx, userId) => remoteTicket(tx, userId, org.orgId, sessionId, { enabled: true }))).ticket;

async function until(check: () => Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Hết thời gian chờ");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const opened: string[] = [];

async function openSession() {
  const sessionId = randomUUID();
  opened.push(sessionId);
  worker.send({
    type: "term_opened",
    sessionId,
    accountLabel: "Gói cá nhân",
    permissions: "workspace",
    origin: "local",
    cli: "claude",
    cwdLabel: "code/app",
    cols: 120,
    rows: 40,
    record: true,
    remote: true,
  });
  await until(
    async () => (await admin.query("select 1 from hive.terminal_sessions where id = $1", [sessionId])).rowCount === 1,
  );
  return sessionId;
}

async function exitSession(sessionId: string, by?: string) {
  worker.send({ type: "term_exit", sessionId, exitCode: 0, reason: by ? "closed" : "exit", ...(by ? { by } : {}) });
  await until(
    async () =>
      (await admin.query("select 1 from hive.terminal_sessions where id = $1 and state = 'closed'", [sessionId]))
        .rowCount === 1,
  );
}

type Device = { id: string; label: string; userId: string; synced: boolean };

/** Máy báo trạng thái từ xa; chờ tới khi hub ghi xong bản sao. */
async function machineState(s: { enabled: boolean; roots?: string[]; devices?: Device[]; sessions?: object[] }) {
  worker.send({
    type: "term_state",
    enabled: s.enabled,
    totp: { enabled: true, locked: false },
    roots: (s.roots ?? ["root-01"]).map((id) => ({ id, label: `thư mục ${id}` })),
    clis: ["claude"],
    accounts: [],
    devices: s.devices ?? [phone()],
    sessions: s.sessions ?? opened.map((id) => ({ id, origin: "local", controller: null })),
    confirmOnMachine: false,
  });
  const roots = JSON.stringify((s.roots ?? ["root-01"]).map((id) => ({ id, label: `thư mục ${id}` })));
  await until(
    async () =>
      (
        await admin.query(
          "select 1 from hive.machine_remote_state where machine_id = $1 and enabled = $2 and roots::text = $3::jsonb::text",
          [machineId, s.enabled, roots],
        )
      ).rowCount === 1,
  );
}

const phone = (): Device => ({ id: deviceId, label: "iPhone của Tú", userId: org.user("tmember"), synced: true });

const actions = async (targetId: string) =>
  (
    await admin.query<{ action: string }>(
      "select action from hive.audit_log where target_id = $1 order by created_at, id",
      [targetId],
    )
  ).rows.map((r) => r.action);

async function audit(targetId: string, action: string) {
  await until(async () => (await actions(targetId)).includes(action));
  const { rows } = await admin.query<{ actor_user_id: string | null; data: Record<string, unknown> }>(
    "select actor_user_id, data from hive.audit_log where target_id = $1 and action = $2 order by created_at desc limit 1",
    [targetId, action],
  );
  return rows[0];
}

/** Xin quyền gõ bằng TOTP (không gửi deviceId) và cho worker giả cấp. */
async function grant(b: Awaited<ReturnType<typeof browser>>, connId: string, sessionId: string, token: string) {
  b.send({ t: "control", auth: totp });
  const ctl = await worker.forConn("term_control", connId);
  worker.send({ type: "term_granted", sessionId, connId, workerEphPub: ephPub, resumeToken: token });
  await b.inbox.until((f) => f.t === "granted");
  return ctl;
}

beforeAll(async () => {
  org = await seedOrg(admin, `rau-${tag}`);
  await admin.query("update hive.team_members set role = 'admin' where team_id = $1 and user_id = $2", [
    org.teamId,
    org.user("tmember"),
  ]);
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const gateway = attachWorkerGateway(server, { pool, heartbeatSec: 5, helloTimeoutMs: 500, logger: quiet });
  const terminal = attachTerminalGateway(server, { pool, remoteEnabled: true, logger: quiet });
  closers.push(registerTerminalHandlers(withRemoteLive(pool, createTerminalHandlers(pool), quiet, { publicUrl })));
  closers.push(
    () => terminal.close(),
    () => gateway.close(),
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const { token } = await as("tmember", (tx, userId) => createRegistration(tx, userId, org.teamId, "worker", {}));
  const m = await registerMachine(pool, {
    registrationToken: token,
    machineId: `mac-${tag}`,
    os: "darwin",
    version: "0.9.0",
    clis: ["claude"],
    capacity: 1,
  });
  machineId = m.id;
  worker = await Worker.connect(m.machineToken, `mac-${tag}`);
});

beforeEach(async () => {
  resetMachineBuckets();
  await machineState({ enabled: true });
});

afterEach(async () => {
  for (const sessionId of opened.splice(0)) {
    const { rowCount } = await admin.query(
      "select 1 from hive.terminal_sessions where id = $1 and state in ('opening', 'running')",
      [sessionId],
    );
    if (rowCount) await exitSession(sessionId);
  }
});

afterAll(async () => {
  for (const close of closers.reverse()) await close();
  await Promise.all([admin.end(), pool.end()]);
});

describe("audit đủ (SC-006)", () => {
  it("mọi thao tác ở US5 kịch bản 5 có dòng audit trên hub", async () => {
    // Bật, thêm thư mục, ghép thiết bị đã có ở beforeEach; ở đây thêm và bỏ để có đủ cặp.
    await machineState({ enabled: true, roots: ["root-01", "root-02"] });
    const sessionId = await openSession();
    const b = await browser(await ticketFor("tmember", sessionId));
    const h = await b.hello();

    // Từ chối rồi cấp: TOTP không gửi deviceId, hub điền mã cố định.
    b.send({ t: "control", auth: { ...totp, code: "000000" } });
    expect(await worker.forConn("term_control", h.connId)).toMatchObject({ deviceId: TOTP_DEVICE_ID });
    worker.send({
      type: "term_event",
      sessionId,
      seq: 0,
      event: "controller",
      data: { connId: h.connId, denied: "TOTP_INVALID" },
    });
    await b.inbox.until((f) => f.t === "denied");
    worker.inbox.all.length = 0;
    await grant(b, h.connId, sessionId, tok("a"));

    b.send({ t: "resize", seq: 0, cols: 44, rows: 30, mac });
    b.send({ t: "resize", seq: 1, cols: 44, rows: 30, mac });
    await worker.forConn("term_resize", h.connId);
    worker.send({
      type: "term_event",
      sessionId,
      seq: 0,
      event: "input_rejected",
      data: { connId: h.connId, count: 1 },
    });
    worker.send({ type: "term_revoked", sessionId, connId: h.connId, reason: "taken" });
    await b.inbox.until((f) => f.t === "revoked");
    worker.inbox.all.length = 0;
    b.inbox.all.length = 0;
    await grant(b, h.connId, sessionId, tok("b"));
    worker.send({ type: "term_revoked", sessionId, connId: h.connId, reason: "idle" });
    await b.inbox.until((f) => f.t === "revoked");
    b.ws.close();
    await audit(sessionId, "terminal.detach");

    await as("tmember", (tx, userId) => closeRemoteSession(tx, userId, sessionId));
    expect(await worker.forSession("term_close", sessionId)).toMatchObject({ by: org.user("tmember") });
    await exitSession(sessionId, org.user("tmember"));

    await machineState({ enabled: true, roots: ["root-02"], devices: [] });
    await as("tmember", (tx, userId) => disableRemote(tx, userId, machineId));

    const onSession = await actions(sessionId);
    const onMachine = await actions(machineId);
    for (const a of [
      "open",
      "attach",
      "deny",
      "control_grant",
      "resize",
      "input_rejected",
      "control_take",
      "control_revoke",
      "detach",
      "close",
      "exit",
    ]) {
      expect(onSession, a).toContain(`terminal.${a}`);
    }
    for (const a of ["remote_enable", "root_add", "root_remove", "device_revoke", "remote_disable"]) {
      expect(onMachine, a).toContain(`terminal.${a}`);
    }
    // Hai khung resize cùng cỡ chỉ ghi một dòng.
    expect(onSession.filter((a) => a === "terminal.resize")).toHaveLength(1);
    expect(await audit(sessionId, "terminal.resize")).toMatchObject({ data: { cols: 44, rows: 30 } });
    expect(await audit(sessionId, "terminal.control_grant")).toMatchObject({
      actor_user_id: org.user("tmember"),
      data: { deviceId: TOTP_DEVICE_ID },
    });
    // Tên hành động phải nằm trong danh sách chung để trang audit hiện đúng nhãn (máy còn có `machine.*` của fleet).
    for (const a of [...onSession, ...onMachine].filter((x) => x.startsWith("terminal."))) {
      expect(REMOTE_AUDIT_ACTIONS as readonly string[], a).toContain(a);
    }
  });

  it("cấp quyền gõ tạo mục trong hộp thư của chủ máy (OPS-02)", async () => {
    const sessionId = await openSession();
    const b = await browser(await ticketFor("tmember", sessionId));
    const h = await b.hello();
    b.send({ t: "control", deviceId, auth: totp });
    await worker.forConn("term_control", h.connId);
    worker.send({ type: "term_granted", sessionId, connId: h.connId, workerEphPub: ephPub, resumeToken: tok("n") });
    await b.inbox.until((f) => f.t === "granted");
    let rows: Array<{ user_id: string; title: string; body: string; link: string | null }> = [];
    await until(async () => {
      rows = (
        await admin.query(
          "select user_id, title, body, link from hive.inbox_items where org_id = $1 and event = 'terminal.remote_session' and link like $2",
          [org.orgId, `%${sessionId}`],
        )
      ).rows;
      return rows.length > 0;
    });
    expect(rows).toEqual([
      expect.objectContaining({
        user_id: org.user("tmember"),
        title: `Phiên trên mac-${tag} đang được điều khiển từ xa`,
        link: `https://hive.example.vn/remote/${sessionId}`,
      }),
    ]);
    expect(rows[0]?.body).toContain("iPhone của Tú");
  });
});

describe("ngắt phiên (FR-024)", () => {
  it("chủ phiên và quản trị đội ngắt được; người khác thấy như không có phiên", async () => {
    const sessionId = await openSession();
    expect(await errorCode(() => as("tviewer", (tx, u) => closeRemoteSession(tx, u, sessionId)))).toBe(
      "SESSION_NOT_FOUND",
    );
    expect(await errorCode(() => as("oadmin", (tx, u) => closeRemoteSession(tx, u, sessionId)))).toBe(
      "SESSION_NOT_FOUND",
    );
    expect(worker.inbox.all.some((m) => m.type === "term_close" && m.sessionId === sessionId)).toBe(false);

    const s = await as("tadmin", (tx, u) => closeRemoteSession(tx, u, sessionId));
    expect(s).toMatchObject({ id: sessionId, isOwner: false });
    expect(await worker.forSession("term_close", sessionId)).toMatchObject({ by: org.user("tadmin") });
    expect(await audit(sessionId, "terminal.close")).toMatchObject({
      actor_user_id: org.user("tadmin"),
      data: { source: "hub", ownerUserId: org.user("tmember") },
    });

    await exitSession(sessionId, org.user("tadmin"));
    expect(await errorCode(() => as("tmember", (tx, u) => closeRemoteSession(tx, u, sessionId)))).toBe("SESSION_ENDED");
  });
});

describe("tắt từ xa đóng người xem (FR-022)", () => {
  it("tắt trên web: thu quyền, đóng mọi người xem trong 2 giây; vé mới không còn xin quyền gõ", async () => {
    const sessionId = await openSession();
    await admin.query("update hive.terminal_sessions set visibility = 'team' where id = $1", [sessionId]);
    const owner = await browser(await ticketFor("tmember", sessionId));
    const ho = await owner.hello();
    await grant(owner, ho.connId, sessionId, tok("d"));
    const viewer = await browser(await ticketFor("tviewer", sessionId));
    await viewer.hello();

    const started = Date.now();
    await as("tmember", (tx, userId) => disableRemote(tx, userId, machineId));
    expect(await owner.closed).toBe(TERMINAL_WS_CLOSE.forbidden);
    expect(await viewer.closed).toBe(TERMINAL_WS_CLOSE.forbidden);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(owner.inbox.all).toContainEqual({ t: "revoked", reason: "disabled" });
    expect(liveSession(sessionId)?.remote.grants.size).toBe(0);
    expect(await worker.inbox.until((m) => m.type === "term_disable")).toMatchObject({ by: org.user("tmember") });

    const again = await as("tmember", (tx, userId) =>
      remoteTicket(tx, userId, org.orgId, sessionId, { enabled: true }),
    );
    expect(again.canControl).toBe(false);
  });

  it("tắt tại máy (term_state): hub cũng đóng người xem", async () => {
    const sessionId = await openSession();
    const b = await browser(await ticketFor("tmember", sessionId));
    await b.hello();
    const started = Date.now();
    worker.send({
      type: "term_state",
      enabled: false,
      totp: { enabled: true, locked: false },
      roots: [{ id: "root-01", label: "thư mục root-01" }],
      clis: ["claude"],
      accounts: [],
      devices: [phone()],
      sessions: [{ id: sessionId, origin: "local", controller: "local" }],
      confirmOnMachine: false,
    });
    expect(await b.closed).toBe(TERMINAL_WS_CLOSE.forbidden);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await audit(machineId, "terminal.remote_disable")).toMatchObject({ data: { source: "machine" } });
  });
});

describe("chỗ hở của T030", () => {
  it("controller trong remote.get và remote.list theo worker", async () => {
    const sessionId = await openSession();
    const get = () => as("tmember", (tx, u) => getRemoteSession(tx, u, sessionId));
    const b = await browser(await ticketFor("tmember", sessionId));
    const h = await b.hello();
    worker.send({
      type: "term_event",
      sessionId,
      seq: 0,
      event: "controller",
      data: { connId: h.connId, controller: "remote", label: "iPhone" },
    });
    await until(async () => (await get()).controller === "remote");
    const list = await as("tmember", (tx, u) => listRemoteSessions(tx, u, { machineId, active: true }));
    expect(list.find((s) => s.id === sessionId)?.controller).toBe("remote");

    await machineState({ enabled: true, sessions: [{ id: sessionId, origin: "local", controller: "local" }] });
    await until(async () => (await get()).controller === "local");
  });

  it("hub khởi động lại (mất bảng quyền): nối lại bằng resumeToken và deviceId trình duyệt nhớ", async () => {
    const sessionId = await openSession();
    const a = await browser(await ticketFor("tmember", sessionId));
    const ha = await a.hello();
    a.send({ t: "control", deviceId, auth: totp });
    await worker.forConn("term_control", ha.connId);
    worker.send({ type: "term_granted", sessionId, connId: ha.connId, workerEphPub: ephPub, resumeToken: tok("r") });
    await a.inbox.until((f) => f.t === "granted");
    a.ws.close();
    await worker.forConn("term_detach", ha.connId);
    // Như hub vừa khởi động lại: phiên vẫn được theo dõi lại nhưng không còn quyền nào đã cấp.
    liveSession(sessionId)?.remote.grants.clear();

    const c = await browser(await ticketFor("tmember", sessionId));
    const hc = await c.hello();
    c.send({ t: "resume", after: -1, resumeToken: tok("r"), deviceId });
    expect(await worker.forConn("term_control", hc.connId)).toMatchObject({
      deviceId,
      resumeToken: tok("r"),
      userId: org.user("tmember"),
    });
    worker.send({ type: "term_granted", sessionId, connId: hc.connId, workerEphPub: ephPub, resumeToken: tok("r2") });
    expect(await c.inbox.until((f) => f.t === "granted")).toMatchObject({ resumeToken: tok("r2") });
  });
});
