// Kiểm thử tấn công phía hub cho điều khiển từ xa (specs/010 T091). Mỗi ca đóng vai kẻ tấn công cụ thể: người dùng tổ
// chức khác, người cùng đội, máy dùng chung, vé bị lộ hay đoán, trang lạ (Origin), máy khác cùng tổ chức gửi gói giả,
// và kiểm mã Authenticator không nằm lại trong DB hay log. Phần worker (chữ ký passkey, HMAC gói nhập, khoá TOTP) ở
// worker/internal/terminal/attack_test.go; xem specs/010-hive-cli-remote/security-review.md.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_AGENT_POLICY,
  type RemoteServerFrame,
  type RemoteStartInput,
  remoteServerFrame,
  TERMINAL_TICKET_TTL_SEC,
  TERMINAL_WS_CLOSE,
} from "@xdev-hive/contracts";
import { type HubToWorker, hubToWorker, PROTOCOL_VERSION } from "@xdev-hive/contracts/worker-protocol";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import WebSocket from "ws";
import { type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import {
  attachWorkerGateway,
  createRegistration,
  registerMachine,
  registerTerminalHandlers,
} from "./modules/fleet/index.ts";
import { saveAgentPolicy } from "./modules/governance/index.ts";
import { createPool, type Tx, withTenant } from "./modules/platform/index.ts";
import { attachTerminalGateway, createTerminalHandlers, withRemoteLive } from "./modules/terminal/index.ts";
import { resetMachineBuckets } from "./modules/terminal/live.ts";
import { startRemoteSession } from "./modules/terminal/start.ts";
import { issueRemoteTicket, issueTicket } from "./modules/terminal/ticket.ts";
import { remoteTicket } from "./modules/terminal/ws.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const tag = randomUUID().slice(0, 6);
const closers: Array<() => Promise<void> | void> = [];
const ephPub = `B${"A".repeat(86)}`;
const mac = "A".repeat(22);
const deviceId = "phone-0001";
// Mã dễ tìm trong dump DB và log; khác mã của totp.db.test.ts để hai file chạy song song không lẫn nhau.
const CODE = "583016";
const totp = { kind: "totp", code: CODE, ephPub, ts: 1_791_999_990, nonce: "rh92dopMeUqiZuhXLhBUxQ" } as const;
const passkey = {
  kind: "passkey",
  ephPub,
  ts: 1_791_999_990,
  nonce: "rh92dopMeUqiZuhXLhBUxQ",
  assertion: { credentialId: "Y3JlZC0wMQ", authenticatorData: "AAAA", clientDataJSON: "AAAA", signature: "AAAA" },
} as const;
const b64 = (s: string) => Buffer.from(s).toString("base64");
const tok = (s: string) => Buffer.from(`resume-${s}`).toString("base64url");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mọi dòng log của hub trong file này, để kiểm mã TOTP không lọt ra. */
const logged: unknown[][] = [];
const logger = {
  info: (...a: unknown[]) => void logged.push(a),
  warn: (...a: unknown[]) => void logged.push(a),
  error: (...a: unknown[]) => void logged.push(a),
};

type Org = OrgFixture & { user: (n: string) => string };
let org: Org;
let stranger: Org;
let host = "";
let machineId = "";
let sharedId = "";
/** Máy cá nhân của chủ máy (`worker`), máy dùng chung của đội, và một máy cá nhân khác cùng tổ chức. */
let worker: Worker;
let shared: Worker;
let other: Worker;

class Worker {
  readonly ws: WebSocket;
  readonly inbox: HubToWorker[] = [];
  welcomed: Extract<HubToWorker, { type: "welcome" }> | undefined;
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
    w.welcomed = (await w.until((m) => m.type === "welcome")) as Extract<HubToWorker, { type: "welcome" }>;
    closers.push(() => w.ws.close());
    return w;
  }
  send(msg: Record<string, unknown>) {
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), ...msg }));
  }
  async until(match: (m: HubToWorker) => boolean, ms = 4000): Promise<HubToWorker> {
    const end = Date.now() + ms;
    for (;;) {
      const found = this.inbox.find(match);
      if (found) return found;
      if (Date.now() > end) throw new Error("Hết thời gian chờ gói");
      await sleep(20);
    }
  }
  forConn<T extends HubToWorker["type"]>(type: T, connId: string) {
    return this.until((m) => m.type === type && "connId" in m && m.connId === connId) as Promise<
      Extract<HubToWorker, { type: T }>
    >;
  }
  /** Gói hub gửi cho một kết nối trình duyệt, trừ `term_detach` (hub luôn báo rời khi kết nối đóng). */
  sentFor(connId: string) {
    return this.inbox.filter((m) => "connId" in m && m.connId === connId && m.type !== "term_detach");
  }
}

/** Trình duyệt giả trên /ws/terminal; `origin: null` thì không gửi header Origin. */
async function browser(ticket: string, origin: string | null = `http://${host}`) {
  const ws = new WebSocket(`ws://${host}/ws/terminal?ticket=${encodeURIComponent(ticket)}`, {
    headers: origin === null ? {} : { origin },
  });
  const inbox: RemoteServerFrame[] = [];
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  ws.on("message", (data) => inbox.push(remoteServerFrame.parse(JSON.parse(data.toString()))));
  const status = await new Promise<number | null>((resolve) => {
    ws.once("open", () => resolve(null));
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.once("error", () => resolve(-1));
  });
  closers.push(() => ws.close());
  const send = (f: Record<string, unknown>) => ws.send(JSON.stringify(f));
  const until = async <T extends RemoteServerFrame["t"]>(t: T, from = 0) => {
    const end = Date.now() + 4000;
    for (;;) {
      const found = inbox.slice(from).find((f) => f.t === t);
      if (found) return found as Extract<RemoteServerFrame, { t: T }>;
      if (Date.now() > end) throw new Error(`Hết thời gian chờ khung ${t}`);
      await sleep(20);
    }
  };
  return { ws, inbox, closed, status, send, until, hello: () => until("hello") };
}

const as = <T>(o: Org, who: string, fn: (tx: Tx, userId: string) => Promise<T>) =>
  withTenant(pool, { userId: o.user(who), orgId: o.orgId }, (tx) => fn(tx, o.user(who)));

const ticketFor = async (who: string, sessionId: string, o: Org = org) =>
  (await as(o, who, (tx, userId) => remoteTicket(tx, userId, o.orgId, sessionId, { enabled: true }))).ticket;

const start = (who: string, patch: Partial<RemoteStartInput> = {}, o: Org = org) =>
  startRemoteSession(
    pool,
    o.orgId,
    { id: o.user(who) },
    { machineId, deviceId, cli: "claude", rootId: "root-01", cols: 80, rows: 30, auth: passkey, ...patch },
    { enabled: true, publicUrl: "http://hub.test", startWaitMs: 4000 },
  );

const setTotpFallback = (totpFallback: boolean) =>
  as(org, "owner", (tx, userId) => saveAgentPolicy(tx, userId, { ...DEFAULT_AGENT_POLICY, remote: { totpFallback } }));

async function until(check: () => Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Hết thời gian chờ");
    await sleep(20);
  }
}

const opened: string[] = [];

async function openSession(w: Worker = worker) {
  const sessionId = randomUUID();
  opened.push(sessionId);
  w.send({
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
  return sessionId;
}

const recorded = async (sessionId: string) =>
  (await admin.query("select 1 from hive.terminal_sessions where id = $1", [sessionId])).rowCount === 1;

async function personalSession() {
  const sessionId = await openSession();
  await until(() => recorded(sessionId));
  return sessionId;
}

/** Chủ máy xin quyền gõ bằng passkey và worker cấp; trả kết nối đã có quyền. */
async function grantedOwner(sessionId: string, token: string) {
  const a = await browser(await ticketFor("tmember", sessionId));
  const h = await a.hello();
  a.send({ t: "control", deviceId, auth: passkey });
  await worker.forConn("term_control", h.connId);
  worker.send({ type: "term_granted", sessionId, connId: h.connId, workerEphPub: ephPub, resumeToken: tok(token) });
  await a.until("granted");
  return { ...a, connId: h.connId };
}

/** Như totp.db.test.ts: dò mọi bảng của schema hive, mã 6 số chỉ tính khi đứng riêng. */
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

async function register(who: string, name: string, flags: { shared?: boolean } = {}) {
  const { token } = await as(org, who, (tx, userId) => createRegistration(tx, userId, org.teamId, "worker", flags));
  const m = await registerMachine(pool, {
    registrationToken: token,
    machineId: name,
    os: "darwin",
    version: "0.9.0",
    clis: ["claude"],
    capacity: 1,
  });
  return { m, w: await Worker.connect(m.machineToken, name) };
}

beforeAll(async () => {
  org = await seedOrg(admin, `atk-${tag}`);
  stranger = await seedOrg(admin, `atk2-${tag}`);
  for (const who of ["tmember", "tadmin"]) {
    await admin.query("update hive.team_members set role = 'admin' where team_id = $1 and user_id = $2", [
      org.teamId,
      org.user(who),
    ]);
  }
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
  const mine = await register("tmember", `mac-${tag}`);
  machineId = mine.m.id;
  worker = mine.w;
  const team = await register("tmember", `shared-${tag}`, { shared: true });
  sharedId = team.m.id;
  shared = team.w;
  other = (await register("tadmin", `mac2-${tag}`)).w;
});

beforeEach(async () => {
  resetMachineBuckets();
  await setTotpFallback(true);
  for (const w of [worker, shared, other]) w.inbox.splice(0);
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

describe("người khác", () => {
  it("tổ chức khác: không xin được vé, không mở được phiên mới trên máy", async () => {
    const sessionId = await personalSession();
    await expect(ticketFor("tmember", sessionId, stranger)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    await expect(ticketFor("owner", sessionId, stranger)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    await expect(start("tmember", {}, stranger)).rejects.toMatchObject({ code: "MACHINE_NOT_YOURS" });
    await sleep(100);
    expect(worker.inbox.filter((m) => m.type === "term_start")).toEqual([]);
  });

  it("người cùng đội xem phiên đội: không dùng được resumeToken của chủ, gõ thì bị đóng", async () => {
    const sessionId = await personalSession();
    await grantedOwner(sessionId, "chu");
    await admin.query("update hive.terminal_sessions set visibility = 'team' where id = $1", [sessionId]);

    const v = await browser(await ticketFor("tviewer", sessionId));
    const h = await v.hello();
    expect(h.canControl).toBe(false);
    v.send({ t: "resume", after: -1, resumeToken: tok("chu") });
    expect(await v.until("denied")).toMatchObject({ code: "AUTH_STALE" });
    v.send({ t: "in", seq: 0, data: b64("rm -rf ~\r"), mac });
    expect(await v.closed).toBe(TERMINAL_WS_CLOSE.forbidden);
    await sleep(100);
    expect(worker.sentFor(h.connId)).toEqual([]);
  });

  it("quản trị đội không phải chủ máy: xem được nếu phiên cho đội xem nhưng không xin được quyền gõ", async () => {
    const sessionId = await personalSession();
    await admin.query("update hive.terminal_sessions set visibility = 'team' where id = $1", [sessionId]);
    const v = await browser(await ticketFor("tadmin", sessionId));
    const h = await v.hello();
    expect(h.canControl).toBe(false);
    v.send({ t: "control", deviceId, auth: passkey });
    expect(await v.closed).toBe(TERMINAL_WS_CLOSE.forbidden);
    await expect(start("tadmin")).rejects.toMatchObject({ code: "MACHINE_NOT_YOURS" });
    await sleep(100);
    expect(worker.sentFor(h.connId)).toEqual([]);
    expect(worker.inbox.filter((m) => m.type === "term_start")).toEqual([]);
  });
});

describe("máy dùng chung", () => {
  it("không ghi phiên, không có vé, không mở phiên từ xa; welcome báo shared để worker từ chối bật", async () => {
    expect(shared.welcomed).toMatchObject({ owner: { shared: true } });
    expect(shared.welcomed?.policy).toBeUndefined();
    const sessionId = await openSession(shared);
    await sleep(300);
    expect(await recorded(sessionId)).toBe(false);
    await expect(ticketFor("tmember", sessionId)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    await expect(start("tmember", { machineId: sharedId })).rejects.toMatchObject({ code: "MACHINE_SHARED" });
    await sleep(100);
    expect(shared.inbox.filter((m) => m.type === "term_start" || m.type === "term_control")).toEqual([]);
  });
});

describe("vé /ws/terminal", () => {
  it("dùng lại, hết hạn, đoán bừa: đóng 4401 và không có hello", async () => {
    const sessionId = await personalSession();
    const ticket = await ticketFor("tmember", sessionId);
    const first = await browser(ticket);
    await first.hello();
    const reused = await browser(ticket);
    expect(await reused.closed).toBe(TERMINAL_WS_CLOSE.unauthorized);

    const expired = issueRemoteTicket(
      { sessionId, orgId: org.orgId, userId: org.user("tmember"), canControl: true },
      Date.now() - TERMINAL_TICKET_TTL_SEC * 1000 - 1,
    );
    const late = await browser(expired.ticket);
    expect(await late.closed).toBe(TERMINAL_WS_CLOSE.unauthorized);

    const guess = await browser(`r.${randomBytes(32).toString("base64url")}`);
    expect(await guess.closed).toBe(TERMINAL_WS_CLOSE.unauthorized);
    for (const x of [reused, late, guess]) expect(x.inbox.some((f) => f.t === "hello")).toBe(false);
  });

  it("vé Leader không mở được phiên máy cá nhân dù đúng người, đúng id", async () => {
    const sessionId = await personalSession();
    const { ticket } = issueTicket({ sessionId, orgId: org.orgId, userId: org.user("tmember"), canInput: true });
    const b = await browser(ticket);
    expect(b.status).toBeNull();
    expect(await b.closed).toBe(TERMINAL_WS_CLOSE.notFound);
  });

  it("Origin lạ, thiếu, `null` hay giả host: 403 và vé bị đốt", async () => {
    const sessionId = await personalSession();
    for (const origin of ["https://evil.example", null, "null", `http://evil.example/${host}`]) {
      const ticket = await ticketFor("tmember", sessionId);
      const evil = await browser(ticket, origin);
      expect(evil.status).toBe(403);
      const retry = await browser(ticket);
      expect(await retry.closed).toBe(TERMINAL_WS_CLOSE.unauthorized);
    }
  });
});

describe("gói giả", () => {
  it("chủ máy gõ khi chưa có quyền: hub không chuyển phím tới máy", async () => {
    const sessionId = await personalSession();
    const a = await browser(await ticketFor("tmember", sessionId));
    const h = await a.hello();
    a.send({ t: "in", seq: 0, data: b64("ls\r"), mac });
    a.send({ t: "resize", seq: 1, cols: 44, rows: 30, mac });
    expect(await a.until("error")).toMatchObject({ code: "TERMINAL_READ_ONLY" });
    await sleep(100);
    expect(worker.sentFor(h.connId)).toEqual([]);
  });

  it("máy khác cùng tổ chức giả term_granted, term_event, term_revoked, term_output cho phiên không phải của nó", async () => {
    const sessionId = await personalSession();
    const a = await browser(await ticketFor("tmember", sessionId));
    const h = await a.hello();
    a.send({ t: "control", deviceId, auth: passkey });
    await worker.forConn("term_control", h.connId);

    other.send({ type: "term_granted", sessionId, connId: h.connId, workerEphPub: ephPub, resumeToken: tok("gia") });
    other.send({
      type: "term_event",
      sessionId,
      seq: 0,
      event: "controller",
      data: { connId: h.connId, denied: "AUTH_STALE" },
    });
    other.send({ type: "term_revoked", sessionId, connId: h.connId, reason: "taken" });
    other.send({ type: "term_output", sessionId, seq: 0, data: b64("gõ mật khẩu vào đây: ") });
    await sleep(300);
    expect(a.inbox.filter((f) => f.t !== "hello")).toEqual([]);
    expect((await admin.query("select 1 from hive.terminal_chunks where session_id = $1", [sessionId])).rowCount).toBe(
      0,
    );

    worker.send({ type: "term_granted", sessionId, connId: h.connId, workerEphPub: ephPub, resumeToken: tok("that") });
    expect(await a.until("granted")).toMatchObject({ resumeToken: tok("that") });
  });
});

describe("chính sách tắt mã Authenticator", () => {
  it("control, nối lại bằng mã và remote.start bằng mã đều dừng ở hub", async () => {
    const sessionId = await personalSession();
    await setTotpFallback(false);
    const a = await browser(await ticketFor("tmember", sessionId));
    const h = await a.hello();
    a.send({ t: "control", auth: totp });
    expect(await a.until("error")).toMatchObject({ code: "TOTP_NOT_ALLOWED" });
    // Hub vừa khởi động lại (không biết token): trình duyệt tự khai thiết bị là mã TOTP.
    a.send({ t: "resume", after: -1, resumeToken: tok("cu"), deviceId: "totp-code" });
    expect(await a.until("denied")).toMatchObject({ code: "TOTP_NOT_ALLOWED" });
    await expect(start("tmember", { deviceId: undefined, auth: totp })).rejects.toMatchObject({
      code: "TOTP_NOT_ALLOWED",
    });
    await sleep(100);
    expect(worker.sentFor(h.connId)).toEqual([]);
    expect(worker.inbox.filter((m) => m.type === "term_start")).toEqual([]);
  });
});

describe("mã Authenticator không lưu ở hub", () => {
  it("qua control (sai rồi đúng) và remote.start (sai rồi đúng): mã không có trong DB hay log", async () => {
    const sessionId = await personalSession();
    const a = await browser(await ticketFor("tmember", sessionId));
    const h = await a.hello();
    a.send({ t: "control", auth: totp });
    expect(await worker.forConn("term_control", h.connId)).toMatchObject({ auth: { code: CODE } });
    worker.send({
      type: "term_event",
      sessionId,
      seq: 0,
      event: "controller",
      data: { connId: h.connId, denied: "TOTP_INVALID" },
    });
    await a.until("denied");
    worker.inbox.splice(0);
    a.send({ t: "control", auth: totp });
    await worker.forConn("term_control", h.connId);
    worker.send({ type: "term_granted", sessionId, connId: h.connId, workerEphPub: ephPub, resumeToken: tok("m") });
    await a.until("granted");

    const denied = start("tmember", { deviceId: undefined, auth: totp });
    const first = (await worker.until((m) => m.type === "term_start")) as Extract<HubToWorker, { type: "term_start" }>;
    expect(first.auth).toMatchObject({ code: CODE });
    worker.send({ type: "term_denied", requestId: first.requestId, code: "TOTP_INVALID", reason: `sai mã ${CODE}` });
    await expect(denied).rejects.toMatchObject({ code: "TOTP_INVALID" });
    worker.inbox.splice(0);
    const ok = start("tmember", { deviceId: undefined, auth: totp });
    const second = (await worker.until((m) => m.type === "term_start")) as Extract<HubToWorker, { type: "term_start" }>;
    const remoteId = randomUUID();
    opened.push(remoteId);
    worker.send({
      type: "term_opened",
      sessionId: remoteId,
      accountLabel: "Gói cá nhân",
      permissions: "workspace",
      origin: "remote",
      requestId: second.requestId,
      cli: "claude",
      cwdLabel: "code/app",
      cols: 80,
      rows: 30,
      record: true,
      remote: true,
    });
    expect((await ok).id).toBe(remoteId);

    await until(async () => {
      const { rowCount } = await admin.query(
        "select 1 from hive.audit_log where org_id = $1 and action = 'terminal.totp_ok'",
        [org.orgId],
      );
      return rowCount === 2;
    });
    expect(await tablesContaining(CODE)).toEqual([]);
    expect(JSON.stringify(logged, (_k, v) => (v instanceof Error ? v.stack : v))).not.toContain(CODE);
  });
});
