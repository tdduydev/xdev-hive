// Đường lui TOTP và chính sách tổ chức (specs/010 T027, SC-013). Worker giả qua /ws/worker, trình duyệt giả qua
// /ws/terminal như audit.db.test.ts; worker giả tự trả các gói mà worker thật gửi sau khi kiểm mã.
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { call } from "@orpc/server";
import {
  DEFAULT_AGENT_POLICY,
  type RemoteServerFrame,
  remoteServerFrame,
  TERMINAL_WS_CLOSE,
} from "@xdev-hive/contracts";
import { type HubToWorker, hubToWorker, PROTOCOL_VERSION } from "@xdev-hive/contracts/worker-protocol";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import WebSocket from "ws";
import { type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { attachWorkerGateway, createRegistration, registerMachine, registerTerminalHandlers } from "../fleet/index.ts";
import { policiesRouter, saveAgentPolicy, type TemplateService } from "../governance/index.ts";
import type { Auth } from "../identity/index.ts";
import { createPool, type Tx, withTenant } from "../platform/index.ts";
import { createTerminalHandlers } from "./gateway.ts";
import { resetMachineBuckets } from "./live.ts";
import { remotePolicyHook } from "./totp.ts";
import { attachTerminalGateway, remoteTicket, withRemoteLive } from "./ws.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const tag = randomUUID().slice(0, 6);
const closers: Array<() => Promise<void> | void> = [];
const ephPub = `B${"A".repeat(86)}`;
const deviceId = "phone-0001";
// Mã dễ tìm trong dump DB và log: không được xuất hiện ở đâu ngoài khung gửi worker.
const CODE = "907153";
const totp = { kind: "totp", code: CODE, ephPub, ts: 1_791_999_990, nonce: "rh92dopMeUqiZuhXLhBUxQ" } as const;
const passkey = {
  kind: "passkey",
  ephPub,
  ts: 1_791_999_990,
  nonce: "rh92dopMeUqiZuhXLhBUxQ",
  assertion: {
    credentialId: "Y3JlZC0wMQ",
    authenticatorData: "AAAA",
    clientDataJSON: "AAAA",
    signature: "AAAA",
  },
} as const;
const tok = (s: string) => Buffer.from(`resume-${s}`).toString("base64url");

/** Mọi dòng log của hub trong file này, để kiểm mã TOTP không lọt ra. */
const logged: unknown[][] = [];
const logger = {
  info: (...a: unknown[]) => void logged.push(a),
  warn: (...a: unknown[]) => void logged.push(a),
  error: (...a: unknown[]) => void logged.push(a),
};

let org: OrgFixture & { user: (n: string) => string };
let host = "";
let machineId = "";
let machineToken = "";
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
  readonly closed: Promise<number>;
  /** `welcome` lúc nối; giữ riêng vì test khác xoá hộp thư. */
  welcomed: Extract<HubToWorker, { type: "welcome" }> | undefined;
  constructor(token: string) {
    this.ws = new WebSocket(`ws://${host}/ws/worker`, { headers: { authorization: `Bearer ${token}` } });
    this.ws.on("message", (data) => this.inbox.push(hubToWorker.parse(JSON.parse(data.toString()))));
    this.closed = new Promise((resolve) => this.ws.on("close", (code) => resolve(code)));
  }
  static async connect(token: string, id: string, capabilities = ["terminal"]) {
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
      capabilities,
    });
    w.welcomed = (await w.inbox.until((m) => m.type === "welcome")) as Extract<HubToWorker, { type: "welcome" }>;
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

/** Lưu chính sách qua đúng đường của trang Chính sách (owner có `policies.write`). */
const setTotpFallback = (totpFallback: boolean) =>
  as("owner", (tx, userId) => saveAgentPolicy(tx, userId, { ...DEFAULT_AGENT_POLICY, remote: { totpFallback } }));

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

type Totp = { enabled: boolean; locked: boolean; lockedUntil?: string };

/** Máy báo trạng thái từ xa; chờ tới khi hub ghi xong bản sao TOTP. */
async function machineState(t: Totp = { enabled: true, locked: false }) {
  worker.send({
    type: "term_state",
    enabled: true,
    totp: t,
    roots: [{ id: "root-01", label: "thư mục root-01" }],
    clis: ["claude"],
    accounts: [],
    devices: [{ id: deviceId, label: "iPhone của Tú", userId: org.user("tmember"), synced: true }],
    sessions: opened.map((id) => ({ id, origin: "local", controller: null })),
    confirmOnMachine: false,
  });
  await until(
    async () =>
      (
        await admin.query(
          `select 1 from hive.machine_remote_state where machine_id = $1 and totp_enabled = $2
             and (totp_locked_until is not null) = $3`,
          [machineId, t.enabled, t.locked],
        )
      ).rowCount === 1,
  );
}

const actions = async (targetId: string) =>
  (
    await admin.query<{ action: string; data: Record<string, unknown> }>(
      "select action, data from hive.audit_log where target_id = $1 order by created_at, id",
      [targetId],
    )
  ).rows;

async function audited(targetId: string, action: string) {
  await until(async () => (await actions(targetId)).some((a) => a.action === action));
  return (await actions(targetId)).filter((a) => a.action === action);
}

/**
 * Mọi bảng của schema hive (kể cả bảng thêm sau này) dò theo chuỗi; admin bỏ qua RLS. Mã 6 số chỉ tính khi đứng riêng:
 * nếu dò chuỗi con thì phần micro giây của timestamp hay id ngẫu nhiên đôi khi trùng mã và làm test chập chờn.
 */
async function tablesContaining(needle: string): Promise<string[]> {
  const { rows } = await admin.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'hive' and table_type = 'BASE TABLE'",
  );
  const hits: string[] = [];
  for (const { table_name } of rows) {
    const { rowCount } = await admin.query(`select 1 from hive."${table_name}" t where t::text ~ $1 limit 1`, [
      `(^|[^0-9a-zA-Z.])${needle}($|[^0-9a-zA-Z])`,
    ]);
    if (rowCount) hits.push(table_name);
  }
  return hits;
}

beforeAll(async () => {
  org = await seedOrg(admin, `totp-${tag}`);
  // Đăng ký máy cần quyền quản trị đội; chủ máy là tmember.
  await admin.query("update hive.team_members set role = 'admin' where team_id = $1 and user_id = $2", [
    org.teamId,
    org.user("tmember"),
  ]);
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const gateway = attachWorkerGateway(server, { pool, heartbeatSec: 5, helloTimeoutMs: 500, logger });
  const terminal = attachTerminalGateway(server, { pool, remoteEnabled: true, logger });
  closers.push(registerTerminalHandlers(withRemoteLive(pool, createTerminalHandlers(pool), logger, {})));
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
  machineToken = m.machineToken;
  worker = await Worker.connect(machineToken, `mac-${tag}`);
});

beforeEach(async () => {
  resetMachineBuckets();
  await setTotpFallback(true);
  await machineState();
});

afterEach(async () => {
  for (const sessionId of opened.splice(0)) {
    worker.send({ type: "term_exit", sessionId, exitCode: 0, reason: "exit" });
  }
});

afterAll(async () => {
  for (const close of closers.reverse()) await close();
  await Promise.all([admin.end(), pool.end()]);
});

describe("chính sách tổ chức (FR-019)", () => {
  it("tắt TOTP: hub chặn mã ngay, không chuyển tới máy; passkey vẫn đi; bật lại thì mã đi tiếp", async () => {
    const sessionId = await openSession();
    const b = await browser(await ticketFor("tmember", sessionId));
    const h = await b.hello();
    await setTotpFallback(false);

    b.send({ t: "control", auth: totp });
    expect(await b.inbox.until((f) => f.t === "error")).toMatchObject({ code: "TOTP_NOT_ALLOWED" });
    expect((await audited(sessionId, "terminal.deny"))[0]?.data).toMatchObject({ code: "TOTP_NOT_ALLOWED" });
    b.send({ t: "control", deviceId, auth: passkey });
    expect(await worker.forConn("term_control", h.connId)).toMatchObject({ deviceId, auth: { kind: "passkey" } });
    expect(worker.inbox.all.filter((m) => m.type === "term_control" && m.auth?.kind === "totp")).toEqual([]);

    worker.inbox.all.length = 0;
    await setTotpFallback(true);
    b.send({ t: "control", auth: totp });
    expect(await worker.forConn("term_control", h.connId)).toMatchObject({ auth: { kind: "totp", code: CODE } });
  });

  it("tắt TOTP sau khi đã cấp bằng mã: nối lại bằng resumeToken cũng bị từ chối", async () => {
    const sessionId = await openSession();
    const b = await browser(await ticketFor("tmember", sessionId));
    const h = await b.hello();
    b.send({ t: "control", auth: totp });
    await worker.forConn("term_control", h.connId);
    worker.send({ type: "term_granted", sessionId, connId: h.connId, workerEphPub: ephPub, resumeToken: tok("a") });
    await b.inbox.until((f) => f.t === "granted");
    b.ws.close();
    await worker.forConn("term_detach", h.connId);

    await setTotpFallback(false);
    const again = await browser(await ticketFor("tmember", sessionId));
    const h2 = await again.hello();
    again.send({ t: "resume", after: -1, resumeToken: tok("a") });
    expect(await again.inbox.until((f) => f.t === "denied")).toMatchObject({ code: "TOTP_NOT_ALLOWED" });
    await new Promise((r) => setTimeout(r, 100));
    expect(worker.inbox.all.some((m) => m.type === "term_control" && m.connId === h2.connId)).toBe(false);
  });

  it("chỉ chủ máy được gửi mã: người khác trong đội bị đóng 4403, mã không tới máy", async () => {
    const sessionId = await openSession();
    await admin.query("update hive.terminal_sessions set visibility = 'team' where id = $1", [sessionId]);
    const b = await browser(await ticketFor("tadmin", sessionId));
    const h = await b.hello();
    expect(h.canControl).toBe(false);
    b.send({ t: "control", auth: totp });
    expect(await b.closed).toBe(TERMINAL_WS_CLOSE.forbidden);
    expect(worker.inbox.all.some((m) => m.type === "term_control" && m.connId === h.connId)).toBe(false);
  });
});

describe("audit TOTP (SC-013)", () => {
  it("bật, thử đúng, thử sai, bị khoá, tắt: mỗi việc một dòng; mã không vào DB hay log", async () => {
    await machineState({ enabled: false, locked: false });
    await machineState({ enabled: true, locked: false });
    const sessionId = await openSession();
    const b = await browser(await ticketFor("tmember", sessionId));
    const h = await b.hello();

    b.send({ t: "control", auth: totp });
    await worker.forConn("term_control", h.connId);
    worker.send({
      type: "term_event",
      sessionId,
      seq: 0,
      event: "controller",
      data: { connId: h.connId, denied: "TOTP_INVALID" },
    });
    await b.inbox.until((f) => f.t === "denied");
    worker.inbox.all.length = 0;
    b.send({ t: "control", auth: totp });
    await worker.forConn("term_control", h.connId);
    worker.send({ type: "term_granted", sessionId, connId: h.connId, workerEphPub: ephPub, resumeToken: tok("b") });
    await b.inbox.until((f) => f.t === "granted");
    // Passkey thành công không phải lần thử mã.
    worker.send({ type: "term_revoked", sessionId, connId: h.connId, reason: "idle" });
    await b.inbox.until((f) => f.t === "revoked");
    worker.inbox.all.length = 0;
    b.send({ t: "control", deviceId, auth: passkey });
    await worker.forConn("term_control", h.connId);
    worker.send({ type: "term_granted", sessionId, connId: h.connId, workerEphPub: ephPub, resumeToken: tok("c") });
    await until(async () => (await audited(sessionId, "terminal.control_grant")).length === 2);

    const lockedUntil = new Date(Date.now() + 10 * 60_000).toISOString();
    await machineState({ enabled: true, locked: true, lockedUntil });
    // Máy báo lại cùng trạng thái khoá: không ghi thêm.
    await machineState({ enabled: true, locked: true, lockedUntil });
    await machineState({ enabled: false, locked: false });

    expect((await audited(sessionId, "terminal.totp_fail")).map((a) => a.data)).toEqual([
      expect.objectContaining({ connId: h.connId, code: "TOTP_INVALID" }),
    ]);
    expect(await audited(sessionId, "terminal.totp_ok")).toHaveLength(1);
    const onMachine = (await actions(machineId)).map((a) => a.action).filter((a) => a.startsWith("terminal.totp_"));
    expect(onMachine.slice(-4)).toEqual([
      "terminal.totp_disable",
      "terminal.totp_enroll",
      "terminal.totp_locked",
      "terminal.totp_disable",
    ]);
    expect((await audited(machineId, "terminal.totp_locked")).at(-1)?.data).toMatchObject({
      source: "machine",
      lockedUntil,
    });

    expect(await tablesContaining(CODE)).toEqual([]);
    expect(JSON.stringify(logged, (_k, v) => (v instanceof Error ? v.stack : v))).not.toContain(CODE);
  });
});

describe("welcome.policy", () => {
  it("máy cá nhân nhận chính sách khi nối; đổi chính sách thì máy được nối lại và nhận bản mới", async () => {
    expect(worker.welcomed?.policy).toEqual({ totpFallback: true });
    await setTotpFallback(false);
    const machines = await as("owner", (tx) => remotePolicyHook.machines(tx));
    expect(machines).toEqual([machineId]);
    remotePolicyHook.refresh(machines);
    expect(await worker.closed).toBe(1012);

    worker = await Worker.connect(machineToken, `mac-${tag}`);
    expect(worker.welcomed?.policy).toEqual({ totpFallback: false });
  });

  it("lưu qua route Chính sách: chỉ báo máy khi phần từ xa đổi, sau khi lưu xong", async () => {
    const refreshed: string[][] = [];
    const userId = org.user("owner");
    const router = policiesRouter({
      pool,
      auth: {
        api: { getSession: async () => ({ user: { id: userId, name: userId, email: `${userId}@seed.test` } }) },
      } as unknown as Auth,
      templates: {} as TemplateService,
      remote: { machines: remotePolicyHook.machines, refresh: (ids) => void refreshed.push(ids) },
    });
    const save = (input: typeof DEFAULT_AGENT_POLICY) =>
      call(router.update, input, { context: { headers: new Headers({ "x-hive-org": org.orgId }) } });
    await save({ ...DEFAULT_AGENT_POLICY, requireSandbox: !DEFAULT_AGENT_POLICY.requireSandbox });
    expect(refreshed).toEqual([]);
    await save({ ...DEFAULT_AGENT_POLICY, remote: { totpFallback: false } });
    expect(refreshed).toEqual([[machineId]]);
  });

  it("đổi mục khác của chính sách thì không báo đổi phần từ xa", async () => {
    const r = await as("owner", (tx, userId) =>
      saveAgentPolicy(tx, userId, { ...DEFAULT_AGENT_POLICY, requireSandbox: !DEFAULT_AGENT_POLICY.requireSandbox }),
    );
    expect(r.remoteChanged).toBe(false);
    expect((await setTotpFallback(false)).remoteChanged).toBe(true);
  });

  it("worker chưa có phiên tương tác: welcome không có policy, vẫn nối và chạy như cũ", async () => {
    const { token } = await as("tmember", (tx, userId) => createRegistration(tx, userId, org.teamId, "worker", {}));
    const m = await registerMachine(pool, {
      registrationToken: token,
      machineId: `old-${tag}`,
      os: "linux",
      version: "0.8.0",
      clis: ["claude"],
      capacity: 1,
    });
    const old = await Worker.connect(m.machineToken, `old-${tag}`, []);
    const welcome = old.welcomed;
    expect(welcome?.policy).toBeUndefined();
    expect(welcome?.features ?? []).not.toContain("terminal");
    expect(await as("owner", (tx) => remotePolicyHook.machines(tx))).not.toContain(m.id);
    old.send({ type: "heartbeat", load: 0 });
    await old.inbox.until((m) => m.type === "heartbeat_ack");
    await new Promise((r) => setTimeout(r, 200));
    expect(old.ws.readyState).toBe(WebSocket.OPEN);
  });
});
