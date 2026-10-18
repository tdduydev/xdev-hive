// `/ws/terminal` cho phiên trên máy cá nhân (specs/010 T030): worker giả qua /ws/worker như `hive chat`, trình duyệt giả
// qua /ws/terminal với vé `remote.ticket`. Hub chỉ chuyển tiếp quyền gõ; passkey/TOTP do worker kiểm nên ở đây worker giả
// tự trả term_granted/term_revoked.
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type RemoteServerFrame, remoteServerFrame, TERMINAL_WS_CLOSE } from "@xdev-hive/contracts";
import { type HubToWorker, hubToWorker, PROTOCOL_VERSION } from "@xdev-hive/contracts/worker-protocol";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import WebSocket from "ws";
import { type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { attachWorkerGateway, createRegistration, registerMachine, registerTerminalHandlers } from "../fleet/index.ts";
import { createPool, type Tx, withTenant } from "../platform/index.ts";
import { createTerminalHandlers } from "./gateway.ts";
import { resetMachineBuckets, untrackSession } from "./live.ts";
import { attachTerminalGateway, remoteTicket, withRemoteLive } from "./ws.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const tag = randomUUID().slice(0, 6);
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const closers: Array<() => Promise<void> | void> = [];
const ephPub = `B${"A".repeat(86)}`;
const mac = "A".repeat(22);
const totp = { kind: "totp", code: "123456", ephPub, ts: 1_791_999_990, nonce: "rh92dopMeUqiZuhXLhBUxQ" } as const;
const deviceId = "phone-0001";
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
/** resumeToken phải là base64url hợp lệ như worker sinh ra. */
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
  /** Gói đầu tiên khớp, kể cả gói đã tới trước khi gọi; `from` bỏ qua các gói cũ hơn. */
  async until(match: (m: T) => boolean, ms = 4000, from = 0): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const found = this.all.slice(from).find(match);
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
  /** Gói hub gửi cho một kết nối trình duyệt. */
  forConn<T extends HubToWorker["type"]>(type: T, connId: string) {
    return this.inbox.until((m) => m.type === type && "connId" in m && m.connId === connId) as Promise<
      Extract<HubToWorker, { type: T }>
    >;
  }
}

/** Trình duyệt giả trên /ws/terminal. */
async function browser(ticket: string, origin = `http://${host}`) {
  const ws = new WebSocket(`ws://${host}/ws/terminal?ticket=${encodeURIComponent(ticket)}`, { headers: { origin } });
  const inbox = new Inbox<RemoteServerFrame>();
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  ws.on("message", (data) => inbox.push(remoteServerFrame.parse(JSON.parse(data.toString()))));
  const status = await new Promise<number | null>((resolve) => {
    ws.once("open", () => resolve(null));
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.once("error", () => resolve(-1));
  });
  closers.push(() => ws.close());
  const send = (f: Record<string, unknown>) => ws.send(JSON.stringify(f));
  const hello = async () => {
    const h = await inbox.until((f) => f.t === "hello");
    return h as Extract<RemoteServerFrame, { t: "hello" }>;
  };
  /** Byte output nhận được, ghép theo seq (bỏ trùng). */
  const text = () => {
    const seen = new Map<number, string>();
    for (const f of inbox.all) if (f.t === "out") seen.set(f.seq, Buffer.from(f.data, "base64").toString());
    return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s);
  };
  return { ws, inbox, closed, status, send, hello, text };
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

// Máy chỉ ghi tối đa `recordedSessionsPerMachine` phiên đang chạy: mỗi test đóng phiên của mình.
const opened: string[] = [];

async function openSession(extra: Record<string, unknown> = {}) {
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
    ...extra,
  });
  await until(
    async () => (await admin.query("select 1 from hive.terminal_sessions where id = $1", [sessionId])).rowCount === 1,
  );
  return sessionId;
}

async function output(sessionId: string, from: number, parts: string[]) {
  parts.forEach((s, i) => {
    worker.send({ type: "term_output", sessionId, seq: from + i, data: b64(s) });
  });
  const last = from + parts.length - 1;
  await until(
    async () =>
      (await admin.query("select 1 from hive.terminal_chunks where session_id = $1 and seq = $2", [sessionId, last]))
        .rowCount === 1,
  );
}

const audits = async (sessionId: string) =>
  (
    await admin.query<{ action: string }>(
      "select action from hive.audit_log where target_id = $1 order by created_at",
      [sessionId],
    )
  ).rows.map((r) => r.action);

beforeAll(async () => {
  org = await seedOrg(admin, `rws-${tag}`);
  await admin.query("update hive.team_members set role = 'admin' where team_id = $1 and user_id = $2", [
    org.teamId,
    org.user("tmember"),
  ]);
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const gateway = attachWorkerGateway(server, { pool, heartbeatSec: 5, helloTimeoutMs: 500, logger: quiet });
  const terminal = attachTerminalGateway(server, { pool, remoteEnabled: true, logger: quiet });
  closers.push(registerTerminalHandlers(withRemoteLive(pool, createTerminalHandlers(pool), quiet)));
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

beforeEach(() => {
  resetMachineBuckets();
});

afterEach(async () => {
  for (const sessionId of opened.splice(0)) {
    worker.send({ type: "term_exit", sessionId, exitCode: 0, reason: "exit" });
    await until(
      async () =>
        (await admin.query("select 1 from hive.terminal_sessions where id = $1 and state = 'closed'", [sessionId]))
          .rowCount === 1,
    );
  }
});

afterAll(async () => {
  for (const close of closers.reverse()) await close();
  await Promise.all([admin.end(), pool.end()]);
});

describe("vé và Origin", () => {
  it("vé dùng một lần: lần hai nhận mã đóng 4401", async () => {
    const sessionId = await openSession();
    const ticket = await ticketFor("tmember", sessionId);
    const first = await browser(ticket);
    expect(first.status).toBeNull();
    const hello = await first.hello();
    expect(hello).toMatchObject({ canControl: true, session: { id: sessionId, machineId, isOwner: true } });
    expect(hello.connId).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const again = await browser(ticket);
    expect(again.status).toBeNull();
    expect(await again.closed).toBe(TERMINAL_WS_CLOSE.unauthorized);
    // Hub gửi hello trước rồi mới ghi audit, nên đọc ngay sau hello có lúc chưa thấy dòng audit.
    await until(async () => (await audits(sessionId)).includes("terminal.attach"));
    expect(await audits(sessionId)).toContain("terminal.attach");
  });

  it("Origin lạ bị từ chối ở bước bắt tay và vé bị đốt luôn", async () => {
    const sessionId = await openSession();
    const ticket = await ticketFor("tmember", sessionId);
    const evil = await browser(ticket, "https://evil.example");
    expect(evil.status).toBe(403);
    const retry = await browser(ticket);
    expect(await retry.closed).toBe(TERMINAL_WS_CLOSE.unauthorized);
  });

  it("vé không phải của hub (không có tiền tố) vẫn bị từ chối bằng HTTP 401 như vé Leader", async () => {
    const bad = await browser("không-có-vé");
    expect(bad.status).toBe(401);
  });
});

describe("chỉ chủ máy điều khiển", () => {
  it("người xem gửi phím hay xin quyền thì bị đóng 4403; không có gói nào tới worker", async () => {
    const sessionId = await openSession();
    await admin.query("update hive.terminal_sessions set visibility = 'team' where id = $1", [sessionId]);
    const viewer = await browser(await ticketFor("tviewer", sessionId));
    const hello = await viewer.hello();
    expect(hello.canControl).toBe(false);
    viewer.send({ t: "in", seq: 0, data: b64("rm -rf /\r"), mac });
    expect(await viewer.closed).toBe(TERMINAL_WS_CLOSE.forbidden);

    const again = await browser(await ticketFor("tviewer", sessionId));
    const h2 = await again.hello();
    again.send({ t: "control", deviceId, auth: totp });
    expect(await again.closed).toBe(TERMINAL_WS_CLOSE.forbidden);
    await new Promise((r) => setTimeout(r, 100));
    const leaked = worker.inbox.all.filter(
      (m) => "connId" in m && (m.connId === hello.connId || m.connId === h2.connId),
    );
    expect(leaked.filter((m) => m.type !== "term_detach")).toEqual([]);
  });

  it("phiên riêng tư thì người khác không mở được (4404)", async () => {
    const sessionId = await openSession();
    await expect(ticketFor("tviewer", sessionId)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });
});

describe("quyền gõ do worker cấp", () => {
  it("control → term_control; granted, input, từ chối và thu quyền đi đúng kết nối", async () => {
    const sessionId = await openSession();
    const a = await browser(await ticketFor("tmember", sessionId));
    const b = await browser(await ticketFor("tmember", sessionId));
    const ha = await a.hello();
    const hb = await b.hello();

    a.send({ t: "in", seq: 0, data: b64("ls\r"), mac });
    expect(await a.inbox.until((f) => f.t === "error")).toMatchObject({ code: "TERMINAL_READ_ONLY" });

    a.send({ t: "control", deviceId, auth: totp });
    const ctl = await worker.forConn("term_control", ha.connId);
    expect(ctl).toMatchObject({ sessionId, userId: org.user("tmember"), deviceId, auth: totp });
    worker.send({ type: "term_granted", sessionId, connId: ha.connId, workerEphPub: ephPub, resumeToken: tok("a") });
    expect(await a.inbox.until((f) => f.t === "granted")).toEqual({
      t: "granted",
      workerEphPub: ephPub,
      resumeToken: tok("a"),
    });
    worker.send({
      type: "term_event",
      sessionId,
      seq: 0,
      event: "controller",
      data: { connId: ha.connId, controller: "remote", label: "iPhone" },
    });
    for (const x of [a, b]) {
      expect(await x.inbox.until((f) => f.t === "event")).toMatchObject({
        event: "controller",
        data: { controller: "remote" },
      });
    }

    a.send({ t: "in", seq: 1, data: b64("ls\r"), mac });
    a.send({ t: "resize", seq: 2, cols: 44, rows: 30, mac });
    expect(await worker.forConn("term_input", ha.connId)).toMatchObject({ sessionId, data: b64("ls\r"), seq: 1, mac });
    expect(await worker.forConn("term_resize", ha.connId)).toMatchObject({ cols: 44, rows: 30, seq: 2, mac });

    // Từ chối đi bằng term_event (không có requestId): chỉ kết nối xin nhận `denied`.
    b.send({ t: "control", deviceId, auth: { ...totp, code: "000000" } });
    await worker.forConn("term_control", hb.connId);
    worker.send({
      type: "term_event",
      sessionId,
      seq: 0,
      event: "controller",
      data: { connId: hb.connId, denied: "TOTP_INVALID", reason: "Mã Authenticator không đúng." },
    });
    expect(await b.inbox.until((f) => f.t === "denied")).toEqual({
      t: "denied",
      code: "TOTP_INVALID",
      message: "Mã Authenticator không đúng.",
    });

    worker.send({
      type: "term_event",
      sessionId,
      seq: 0,
      event: "input_rejected",
      data: { connId: ha.connId, count: 1 },
    });
    expect(await a.inbox.until((f) => f.t === "event" && f.event === "input_rejected")).toMatchObject({
      data: { count: 1 },
    });

    worker.send({ type: "term_revoked", sessionId, connId: ha.connId, reason: "taken" });
    expect(await a.inbox.until((f) => f.t === "revoked")).toEqual({ t: "revoked", reason: "taken" });
    const before = a.inbox.all.length;
    a.send({ t: "in", seq: 3, data: b64("x"), mac });
    expect(await a.inbox.until((f) => f.t === "error", 4000, before)).toMatchObject({ code: "TERMINAL_READ_ONLY" });

    expect(a.inbox.all.some((f) => f.t === "denied")).toBe(false);
    expect(b.inbox.all.some((f) => f.t === "granted" || f.t === "revoked")).toBe(false);
    expect(b.inbox.all.some((f) => f.t === "event" && f.event === "input_rejected")).toBe(false);
    await until(async () => (await audits(sessionId)).includes("terminal.control_take"));
    expect(await audits(sessionId)).toEqual(
      expect.arrayContaining([
        "terminal.attach",
        "terminal.control_grant",
        "terminal.deny",
        "terminal.input_rejected",
        "terminal.control_take",
      ]),
    );
  });

  it("rớt kết nối: hub báo term_detach; nối lại bằng resumeToken xin lại quyền với cùng thiết bị", async () => {
    const sessionId = await openSession();
    const a = await browser(await ticketFor("tmember", sessionId));
    const ha = await a.hello();
    a.send({ t: "control", deviceId, auth: totp });
    await worker.forConn("term_control", ha.connId);
    worker.send({ type: "term_granted", sessionId, connId: ha.connId, workerEphPub: ephPub, resumeToken: tok("r") });
    await a.inbox.until((f) => f.t === "granted");
    a.ws.close();
    expect(await worker.forConn("term_detach", ha.connId)).toMatchObject({ sessionId });
    await until(async () => (await audits(sessionId)).includes("terminal.detach"));

    const c = await browser(await ticketFor("tmember", sessionId));
    const hc = await c.hello();
    c.send({ t: "resume", after: -1, resumeToken: tok("r") });
    expect(await worker.forConn("term_control", hc.connId)).toMatchObject({
      deviceId,
      resumeToken: tok("r"),
      userId: org.user("tmember"),
    });

    // Token hub không biết vẫn tới worker (hub có thể vừa khởi động lại); worker là bên từ chối.
    const d = await browser(await ticketFor("tmember", sessionId));
    const hd = await d.hello();
    d.send({ t: "resume", after: -1, resumeToken: tok("khong-co") });
    expect(await worker.forConn("term_control", hd.connId)).toMatchObject({ resumeToken: tok("khong-co") });
    worker.send({
      type: "term_event",
      sessionId,
      seq: 0,
      event: "controller",
      data: { connId: hd.connId, denied: "AUTH_STALE" },
    });
    expect(await d.inbox.until((f) => f.t === "denied")).toMatchObject({ code: "AUTH_STALE" });
  });

  it("release: hub báo term_detach và ngừng chuyển phím", async () => {
    const sessionId = await openSession();
    const a = await browser(await ticketFor("tmember", sessionId));
    const ha = await a.hello();
    a.send({ t: "control", deviceId, auth: totp });
    await worker.forConn("term_control", ha.connId);
    worker.send({ type: "term_granted", sessionId, connId: ha.connId, workerEphPub: ephPub, resumeToken: tok("x") });
    await a.inbox.until((f) => f.t === "granted");
    a.send({ t: "release" });
    await worker.forConn("term_detach", ha.connId);
    a.send({ t: "in", seq: 5, data: b64("x"), mac });
    expect(await a.inbox.until((f) => f.t === "error")).toMatchObject({ code: "TERMINAL_READ_ONLY" });
  });
});

describe("output và nối lại", () => {
  it("nối lại theo offset không mất byte, rồi nhận output trực tiếp", async () => {
    const sessionId = await openSession();
    await output(sessionId, 0, ["a", "b", "c"]);
    const first = await browser(await ticketFor("tmember", sessionId));
    await first.hello();
    first.send({ t: "resume", after: -1 });
    await first.inbox.until((f) => f.t === "out" && f.seq === 2);
    expect(first.text()).toEqual(["a", "b", "c"]);
    first.ws.close();
    await first.closed;

    await output(sessionId, 3, ["d", "e"]);
    const again = await browser(await ticketFor("tmember", sessionId));
    await again.hello();
    again.send({ t: "resume", after: 2 });
    await again.inbox.until((f) => f.t === "out" && f.seq === 4);
    await output(sessionId, 5, ["f"]);
    await again.inbox.until((f) => f.t === "out" && f.seq === 5);
    expect(again.text()).toEqual([undefined, undefined, undefined, "d", "e", "f"].filter(Boolean));
    expect(again.inbox.all.filter((f) => f.t === "out").map((f) => (f.t === "out" ? f.seq : -1))).toEqual([3, 4, 5]);
  });

  it("client nhận quá băng thông: hub bỏ phần giữa và gửi sync kèm đuôi; bản ghi vẫn đủ", async () => {
    const sessionId = await openSession();
    const slow = await browser(await ticketFor("tmember", sessionId));
    await slow.hello();
    slow.send({ t: "resume", after: -1 });
    await new Promise((r) => setTimeout(r, 100));
    const chunk = "x".repeat(32 * 1024);
    await output(
      sessionId,
      0,
      Array.from({ length: 24 }, () => chunk),
    );
    const sync = await slow.inbox.until((f) => f.t === "sync", 6000);
    expect(sync.t === "sync" && sync.after).toBeGreaterThan(15);
    await slow.inbox.until((f) => f.t === "out" && f.seq === 23, 6000);
    const seqs = slow.inbox.all.flatMap((f) => (f.t === "out" ? [f.seq] : []));
    expect(seqs.length).toBeLessThan(24);
    const { rows } = await admin.query("select count(*)::int as n from hive.terminal_chunks where session_id = $1", [
      sessionId,
    ]);
    expect(rows[0].n).toBe(24);
  });

  it("hub khởi động lại (mất bộ đệm): phát lại từ bản ghi trong DB rồi nhận tiếp", async () => {
    const sessionId = await openSession();
    await output(sessionId, 0, ["một ", "hai ", "ba "]);
    untrackSession(sessionId);
    const v = await browser(await ticketFor("tmember", sessionId));
    await v.hello();
    v.send({ t: "resume", after: -1 });
    await v.inbox.until((f) => f.t === "out" && f.seq === 2);
    await output(sessionId, 3, ["bốn"]);
    await v.inbox.until((f) => f.t === "out" && f.seq === 3);
    expect(v.text().join("")).toBe("một hai ba bốn");
  });

  it("phiên kết thúc: người xem nhận trạng thái cuối và vẫn xem lại được", async () => {
    const sessionId = await openSession();
    await output(sessionId, 0, ["xong"]);
    const v = await browser(await ticketFor("tmember", sessionId));
    await v.hello();
    v.send({ t: "resume", after: -1 });
    await v.inbox.until((f) => f.t === "out");
    worker.send({ type: "term_exit", sessionId, exitCode: 0, reason: "exit" });
    const state = await v.inbox.until((f) => f.t === "state");
    expect(state).toMatchObject({ session: { id: sessionId, state: "closed" } });

    const later = await browser(await ticketFor("tmember", sessionId));
    expect((await later.hello()).canControl).toBe(false);
    later.send({ t: "resume", after: -1 });
    await later.inbox.until((f) => f.t === "out" && f.seq === 0);
    later.send({ t: "control", deviceId, auth: totp });
    expect(await later.inbox.until((f) => f.t === "error")).toMatchObject({ code: "SESSION_ENDED" });
  });
});
