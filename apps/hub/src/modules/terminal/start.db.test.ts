// Route `remote.start` (specs/010 T051, US4). Worker giả qua /ws/worker như totp.db.test.ts, tự trả `term_opened` hay
// `term_denied` mà worker thật gửi sau khi kiểm chữ ký; ca âm kiểm hub không chuyển `term_start` khi không được phép.
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type AgentPolicyInput, DEFAULT_AGENT_POLICY, type RemoteStartInput } from "@xdev-hive/contracts";
import { type HubToWorker, hubToWorker, PROTOCOL_VERSION } from "@xdev-hive/contracts/worker-protocol";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import WebSocket from "ws";
import { type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { attachWorkerGateway, createRegistration, registerMachine, registerTerminalHandlers } from "../fleet/index.ts";
import { saveAgentPolicy } from "../governance/index.ts";
import { createPool, type Tx, withTenant } from "../platform/index.ts";
import { createTerminalHandlers } from "./gateway.ts";
import { startRemoteSession } from "./start.ts";
import { withRemoteLive } from "./ws.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const tag = randomUUID().slice(0, 6);
const closers: Array<() => Promise<void> | void> = [];
const ephPub = `B${"A".repeat(86)}`;
const deviceId = "phone-0001";
const passkey = {
  kind: "passkey",
  ephPub,
  ts: 1_791_999_990,
  nonce: "rh92dopMeUqiZuhXLhBUxQ",
  assertion: { credentialId: "Y3JlZC0wMQ", authenticatorData: "AAAA", clientDataJSON: "AAAA", signature: "AAAA" },
} as const;
const totp = { kind: "totp", code: "907153", ephPub, ts: 1_791_999_990, nonce: "rh92dopMeUqiZuhXLhBUxQ" } as const;

let org: OrgFixture & { user: (n: string) => string };
let host = "";
let machineId = "";
let otherMachineId = "";
let worker: Worker;
let other: Worker;

type StartMsg = Extract<HubToWorker, { type: "term_start" }>;

class Worker {
  readonly ws: WebSocket;
  readonly inbox: HubToWorker[] = [];
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
    await w.until((m) => m.type === "welcome");
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
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  /** `term_start` kế tiếp (bỏ gói cũ để mỗi ca chỉ thấy yêu cầu của mình). */
  async nextStart(): Promise<StartMsg> {
    const msg = (await this.until((m) => m.type === "term_start")) as StartMsg;
    this.inbox.splice(this.inbox.indexOf(msg), 1);
    return msg;
  }
  starts() {
    return this.inbox.filter((m) => m.type === "term_start");
  }
  opened(start: StartMsg, sessionId = randomUUID()) {
    this.send({
      type: "term_opened",
      sessionId,
      accountLabel: "Gói cá nhân",
      permissions: "workspace",
      origin: "remote",
      requestId: start.requestId,
      cli: start.cli,
      cwdLabel: "code/app",
      cols: start.cols,
      rows: start.rows,
      record: true,
      remote: true,
    });
    return sessionId;
  }
}

const as = <T>(who: string, fn: (tx: Tx, userId: string) => Promise<T>) =>
  withTenant(pool, { userId: org.user(who), orgId: org.orgId }, (tx) => fn(tx, org.user(who)));

const savePolicy = (patch: Partial<AgentPolicyInput>) =>
  as("owner", (tx, userId) => saveAgentPolicy(tx, userId, { ...DEFAULT_AGENT_POLICY, ...patch }));

const input = (patch: Partial<RemoteStartInput> = {}): RemoteStartInput => ({
  machineId,
  deviceId,
  cli: "claude",
  rootId: "root-01",
  cols: 80,
  rows: 30,
  auth: passkey,
  ...patch,
});

const start = (who: string, i: RemoteStartInput, deps: { enabled?: boolean; startWaitMs?: number } = {}) =>
  startRemoteSession(pool, org.orgId, { id: org.user(who) }, i, {
    enabled: deps.enabled ?? true,
    publicUrl: "https://hive.example.com",
    startWaitMs: deps.startWaitMs ?? 4000,
  });

async function until(check: () => Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Hết thời gian chờ");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function machineState(enabled: boolean) {
  worker.send({
    type: "term_state",
    enabled,
    totp: { enabled: true, locked: false },
    roots: [{ id: "root-01", label: "code" }],
    clis: ["claude"],
    accounts: [],
    devices: [{ id: deviceId, label: "iPhone của Tú", userId: org.user("tmember"), synced: true }],
    sessions: [],
    confirmOnMachine: false,
  });
  await until(
    async () =>
      (
        await admin.query("select 1 from hive.machine_remote_state where machine_id = $1 and enabled = $2", [
          machineId,
          enabled,
        ])
      ).rowCount === 1,
  );
}

const audits = async (targetId: string, action: string) =>
  (
    await admin.query<{ action: string; actor_user_id: string | null; data: Record<string, unknown> }>(
      "select action, actor_user_id, data from hive.audit_log where target_id = $1 and action = $2 order by created_at",
      [targetId, action],
    )
  ).rows;

async function register(who: string, name: string) {
  const { token } = await as(who, (tx, userId) => createRegistration(tx, userId, org.teamId, "worker", {}));
  return registerMachine(pool, {
    registrationToken: token,
    machineId: name,
    os: "darwin",
    version: "0.9.0",
    clis: ["claude"],
    capacity: 1,
  });
}

beforeAll(async () => {
  org = await seedOrg(admin, `start-${tag}`);
  await admin.query("update hive.team_members set role = 'admin' where team_id = $1 and user_id = $2", [
    org.teamId,
    org.user("tmember"),
  ]);
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const gateway = attachWorkerGateway(server, { pool, heartbeatSec: 5, helloTimeoutMs: 500 });
  closers.push(registerTerminalHandlers(withRemoteLive(pool, createTerminalHandlers(pool))));
  closers.push(
    () => gateway.close(),
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const m = await register("tmember", `mac-${tag}`);
  machineId = m.id;
  worker = await Worker.connect(m.machineToken, `mac-${tag}`);
  // Máy thứ hai cùng chủ: không được trả lời thay yêu cầu gửi tới máy thứ nhất.
  const m2 = await register("tmember", `mac2-${tag}`);
  otherMachineId = m2.id;
  other = await Worker.connect(m2.machineToken, `mac2-${tag}`);
});

beforeEach(async () => {
  worker.inbox.splice(0);
  other.inbox.splice(0);
  await savePolicy({});
  await machineState(true);
});

afterAll(async () => {
  for (const close of closers.reverse()) await close();
  await Promise.all([admin.end(), pool.end()]);
});

describe("remote.start", () => {
  it("chuyển term_start có chính sách tổ chức, trả phiên khi máy báo term_opened cùng requestId", async () => {
    await savePolicy({
      allowedModels: { claude: ["sonnet", "opus"], codex: [], gemini: [], antigravity: [] },
      neverAutoUpgrade: true,
      defaultPermissionMode: "full",
      allowFullPermission: false,
    });
    const pending = start("tmember", input({ subdir: "app", prompt: "Sửa lỗi đăng nhập" }));
    const msg = await worker.nextStart();
    expect(msg).toMatchObject({
      userId: org.user("tmember"),
      deviceId,
      cli: "claude",
      rootId: "root-01",
      subdir: "app",
      prompt: "Sửa lỗi đăng nhập",
      model: "sonnet",
      permissions: "workspace",
      auth: { kind: "passkey" },
    });
    const sessionId = worker.opened(msg);
    const session = await pending;
    expect(session).toMatchObject({ id: sessionId, origin: "remote", machineId, isOwner: true, cwdLabel: "code/app" });
    const open = await audits(sessionId, "terminal.open");
    expect(open).toHaveLength(1);
    expect(open[0]?.data).toMatchObject({ requestId: msg.requestId, origin: "remote" });
    worker.send({ type: "term_exit", sessionId, exitCode: 0, reason: "exit" });
  });

  it("máy từ chối: lỗi tiếng Việt theo mã, audit deny; TOTP sai thêm totp_fail", async () => {
    const pending = start("tmember", input({ deviceId: undefined, auth: totp }));
    const msg = await worker.nextStart();
    expect(msg.deviceId).toBe("totp-code");
    worker.send({ type: "term_denied", requestId: msg.requestId, code: "TOTP_INVALID", reason: "x" });
    await expect(pending).rejects.toMatchObject({ code: "TOTP_INVALID", message: "Mã Authenticator không đúng." });
    const deny = await audits(machineId, "terminal.deny");
    expect(deny.at(-1)?.data).toMatchObject({ requestId: msg.requestId, code: "TOTP_INVALID", auth: "totp" });
    expect(deny.at(-1)?.actor_user_id).toBe(org.user("tmember"));
    expect((await audits(machineId, "terminal.totp_fail")).at(-1)?.data).toMatchObject({ requestId: msg.requestId });
    expect(JSON.stringify(deny)).not.toContain(totp.code);

    const rootPending = start("tmember", input({ subdir: "../etc" }));
    const rootMsg = await worker.nextStart();
    worker.send({ type: "term_denied", requestId: rootMsg.requestId, code: "ROOT_ESCAPE", reason: "x" });
    await expect(rootPending).rejects.toMatchObject({ code: "ROOT_ESCAPE" });
  });

  it("TOTP đúng: ghi totp_ok", async () => {
    const pending = start("tmember", input({ deviceId: undefined, auth: totp }));
    const msg = await worker.nextStart();
    const sessionId = worker.opened(msg);
    await pending;
    expect((await audits(machineId, "terminal.totp_ok")).at(-1)?.data).toMatchObject({ sessionId });
    worker.send({ type: "term_exit", sessionId, exitCode: 0, reason: "exit" });
  });

  it("máy khác gửi gói cùng requestId không trả lời thay được", async () => {
    const pending = start("tmember", input());
    const msg = await worker.nextStart();
    other.send({ type: "term_denied", requestId: msg.requestId, code: "CONFIRM_DENIED", reason: "x" });
    other.opened(msg);
    await new Promise((r) => setTimeout(r, 200));
    const sessionId = worker.opened(msg);
    expect((await pending).id).toBe(sessionId);
    expect(otherMachineId).not.toBe(machineId);
    worker.send({ type: "term_exit", sessionId, exitCode: 0, reason: "exit" });
  });

  it("người không phải chủ máy, máy đã tắt từ xa, hub tắt cờ, thiếu thiết bị: không gửi term_start", async () => {
    await expect(start("tviewer", input())).rejects.toMatchObject({ code: "MACHINE_NOT_YOURS" });
    await expect(start("owner", input())).rejects.toMatchObject({ code: "MACHINE_NOT_YOURS" });
    await expect(start("tmember", input(), { enabled: false })).rejects.toMatchObject({
      code: "REMOTE_DISABLED_HUB",
    });
    await expect(start("tmember", input({ deviceId: undefined }))).rejects.toMatchObject({ code: "DEVICE_NOT_FOUND" });
    await machineState(false);
    await expect(start("tmember", input())).rejects.toMatchObject({ code: "REMOTE_NOT_ENABLED" });
    expect((await audits(machineId, "terminal.deny")).at(-1)?.data).toMatchObject({ code: "REMOTE_NOT_ENABLED" });
    await new Promise((r) => setTimeout(r, 100));
    expect(worker.starts()).toEqual([]);
  });

  it("tổ chức tắt TOTP: chặn ở hub, mã không tới máy; passkey vẫn đi", async () => {
    await savePolicy({ remote: { totpFallback: false } });
    await expect(start("tmember", input({ auth: totp }))).rejects.toMatchObject({ code: "TOTP_NOT_ALLOWED" });
    expect((await audits(machineId, "terminal.deny")).at(-1)?.data).toMatchObject({ code: "TOTP_NOT_ALLOWED" });
    expect(worker.starts()).toEqual([]);
    const pending = start("tmember", input());
    const sessionId = worker.opened(await worker.nextStart());
    expect((await pending).id).toBe(sessionId);
    worker.send({ type: "term_exit", sessionId, exitCode: 0, reason: "exit" });
  });

  it("máy không trả lời: START_TIMEOUT, gói đến muộn không làm hỏng gì", async () => {
    const pending = start("tmember", input(), { startWaitMs: 200 });
    const msg = await worker.nextStart();
    await expect(pending).rejects.toMatchObject({ code: "START_TIMEOUT" });
    worker.send({ type: "term_denied", requestId: msg.requestId, code: "CONFIRM_TIMEOUT", reason: "x" });
    expect((await audits(machineId, "terminal.deny")).at(-1)?.data).toMatchObject({ code: "START_TIMEOUT" });
  });

  it("máy offline: MACHINE_OFFLINE", async () => {
    await admin.query("update hive.machines set status = 'offline' where id = $1", [otherMachineId]);
    await expect(start("tmember", input({ machineId: otherMachineId }))).rejects.toMatchObject({
      code: "MACHINE_OFFLINE",
    });
  });
});
