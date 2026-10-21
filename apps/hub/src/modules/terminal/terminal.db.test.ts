// Phiên tương tác trên máy cá nhân (specs/010 US1, T013): worker giả qua /ws/worker gửi term_opened/output/event/exit
// như `hive chat` tại máy; hub ghi bản ghi, ack, và route `remote.*` đọc lại.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type HubToWorker, hubToWorker, PROTOCOL_VERSION } from "@xdev-hive/contracts/worker-protocol";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import WebSocket from "ws";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { attachWorkerGateway, createRegistration, registerMachine, registerTerminalHandlers } from "../fleet/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { createTerminalHandlers } from "./gateway.ts";
import {
  getRemoteSession,
  listRemoteSessions,
  remoteMachines,
  remoteSessionChunks,
  setRemoteVisibility,
} from "./queries.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const tag = randomUUID().slice(0, 6);
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const closers: Array<() => Promise<void> | void> = [];

let org: OrgFixture & { user: (n: string) => string };
let host = "";
let projectId = "";
let taskId = "";
let otherTaskId = "";
let personalId = "";
let personal: Worker;

class Worker {
  readonly ws: WebSocket;
  readonly inbox: HubToWorker[] = [];
  constructor(token: string) {
    this.ws = new WebSocket(`ws://${host}/ws/worker`, { headers: { authorization: `Bearer ${token}` } });
    this.ws.on("message", (data) => this.inbox.push(hubToWorker.parse(JSON.parse(data.toString()))));
  }
  static async connect(token: string, machineId: string, capabilities: string[]) {
    const w = new Worker(token);
    await new Promise<void>((resolve, reject) => {
      w.ws.once("open", () => resolve());
      w.ws.once("error", reject);
    });
    w.send({
      type: "hello",
      machineId,
      version: "0.9.0",
      protoRange: [1, 1],
      os: "darwin",
      clis: ["claude", "codex"],
      capacity: 1,
      capabilities,
    });
    await w.until((m) => m.type === "welcome");
    closers.push(() => w.ws.close());
    return w;
  }
  send(msg: Record<string, unknown>) {
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), ...msg }));
  }
  async until<T extends HubToWorker>(match: (m: HubToWorker) => m is T, ms?: number): Promise<T>;
  async until(match: (m: HubToWorker) => boolean, ms?: number): Promise<HubToWorker>;
  async until(match: (m: HubToWorker) => boolean, ms = 4000): Promise<HubToWorker> {
    const end = Date.now() + ms;
    for (;;) {
      const found = this.inbox.find(match);
      if (found) return found;
      if (Date.now() > end) throw new Error("Hết thời gian chờ gói");
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

const as = <T>(who: string, fn: (tx: Tx, userId: string) => Promise<T>) =>
  withTenant(pool, { userId: org.user(who), orgId: org.orgId }, (tx) => fn(tx, org.user(who)));

async function newMachine(name: string, shared: boolean) {
  // Người tạo mã đăng ký là chủ máy (registered_by).
  const { token } = await as("tmember", (tx, userId) =>
    createRegistration(tx, userId, org.teamId, "worker", shared ? { shared: true } : {}),
  );
  return registerMachine(pool, {
    registrationToken: token,
    machineId: `${name}-${tag}`,
    os: "darwin",
    version: "0.9.0",
    clis: ["claude"],
    capacity: 1,
  });
}

async function until(check: () => Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Hết thời gian chờ");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const opened = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  type: "term_opened",
  sessionId,
  accountLabel: "Gói cá nhân",
  permissions: "workspace",
  origin: "local",
  cli: "codex",
  cwdLabel: "code/app",
  cols: 120,
  rows: 40,
  record: true,
  remote: true,
  ...extra,
});
const b64 = (s: string) => Buffer.from(s).toString("base64");

beforeAll(async () => {
  org = await seedOrg(admin, `term-${tag}`);
  // Thành viên đội đăng ký máy cá nhân của mình (quyền machines.register thường chỉ quản trị đội có).
  await admin.query("update hive.team_members set role = 'admin' where team_id = $1 and user_id = $2", [
    org.teamId,
    org.user("tmember"),
  ]);
  const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
  const seed = (teamId: string, systemId: string, key: string) =>
    seedProject(admin, pool, { orgId: org.orgId, teamId, systemId, adminUserId: org.user("admin"), masterKey, key });
  projectId = (await seed(org.teamId, org.systemId, `TM${tag}`)).projectId;
  const otherProject = (await seed(org.otherTeamId, org.otherSystemId, `TO${tag}`)).projectId;
  const task = (project: string, team: string, n: number) =>
    admin.query(
      "insert into hive.tasks (org_id, team_id, project_id, number, key, title, created_by) values ($1, $2, $3, $4, $5, 'Việc', 'seed') returning id",
      [org.orgId, team, project, n, `T-${n}-${tag}`],
    );
  taskId = (await task(projectId, org.teamId, 1)).rows[0].id;
  otherTaskId = (await task(otherProject, org.otherTeamId, 2)).rows[0].id;

  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const gateway = attachWorkerGateway(server, { pool, heartbeatSec: 5, helloTimeoutMs: 500, logger: quiet });
  closers.push(registerTerminalHandlers(createTerminalHandlers(pool)));
  closers.push(
    () => gateway.close(),
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const m = await newMachine("mac", false);
  personalId = m.id;
  personal = await Worker.connect(m.machineToken, `mac-${tag}`, ["terminal"]);
});

afterAll(async () => {
  for (const close of closers.reverse()) await close();
  await Promise.all([admin.end(), pool.end()]);
});

describe("welcome cho phiên máy cá nhân", () => {
  it("máy cá nhân có capability terminal: features terminal, chủ máy, chính sách TOTP", async () => {
    const welcome = await personal.until((m) => m.type === "welcome");
    expect(welcome).toMatchObject({
      features: ["subagents", "terminal"],
      owner: { userId: org.user("tmember"), shared: false },
      policy: { totpFallback: true },
    });
  });

  it("máy dùng chung: chỉ báo chủ máy là dùng chung, không có terminal; worker cũ không capability thì không có", async () => {
    const shared = await newMachine("shared", true);
    const w = await Worker.connect(shared.machineToken, `shared-${tag}`, ["terminal"]);
    const welcome = await w.until((m) => m.type === "welcome");
    expect(welcome).toMatchObject({ features: ["shared", "subagents"], owner: { shared: true } });
    expect(welcome.type === "welcome" && welcome.policy).toBeFalsy();

    const old = await newMachine("old", false);
    const o = await Worker.connect(old.machineToken, `old-${tag}`, []);
    const w2 = await o.until((m) => m.type === "welcome");
    expect(w2.type === "welcome" && w2.features).toEqual(["subagents"]);
  });
});

describe("ghi phiên `hive chat` tại máy", () => {
  const sessionId = randomUUID();

  it("term_opened tạo phiên của chủ máy, gắn task cùng đội; output được ghi, ack, loại trùng", async () => {
    personal.send(opened(sessionId, { taskId }));
    await until(
      async () => (await admin.query("select 1 from hive.terminal_sessions where id = $1", [sessionId])).rowCount === 1,
    );
    personal.send({ type: "term_output", sessionId, seq: 0, data: b64("xin chào ") });
    personal.send({
      type: "term_output",
      sessionId,
      seq: 1,
      data: b64("token=hive_pat_abcdefghijklmnopqrstuvwxyz0123"),
    });
    // Gửi lại sau khi nối lại: không ghi hai lần, vẫn ack.
    personal.send({ type: "term_output", sessionId, seq: 0, data: b64("xin chào ") });
    await personal.until((m) => m.type === "term_ack" && m.sessionId === sessionId && m.upto === 1);
    personal.send({ type: "term_event", sessionId, seq: 1, event: "attention", data: { message: "Cần bạn" } });

    const s = await as("tmember", (tx, userId) => getRemoteSession(tx, userId, sessionId));
    expect(s).toMatchObject({
      machineId: personalId,
      isOwner: true,
      origin: "local",
      cli: "codex",
      cwdLabel: "code/app",
      projectId,
      taskId,
      remote: true,
      state: "running",
      cols: 120,
      rows: 40,
    });
    const { chunks } = await as("tmember", (tx, userId) =>
      remoteSessionChunks(tx, userId, { id: sessionId, after: -1, limit: 10 }),
    );
    expect(chunks.map((c) => c.seq)).toEqual([0, 1]);
    const text = chunks.map((c) => Buffer.from(c.data, "base64").toString()).join("");
    expect(text).toContain("xin chào");
    expect(text).not.toContain("hive_pat_abcdefghijklmnopqrstuvwxyz0123");

    await until(
      async () =>
        (
          await admin.query("select 1 from hive.terminal_events where session_id = $1 and kind = 'attention'", [
            sessionId,
          ])
        ).rowCount === 1,
    );
    const audit = await admin.query(
      "select actor_user_id, data from hive.audit_log where org_id = $1 and action = 'terminal.open' and target_id = $2",
      [org.orgId, sessionId],
    );
    expect(audit.rows[0]).toMatchObject({
      actor_user_id: org.user("tmember"),
      data: { source: "machine", origin: "local" },
    });
  });

  it("máy và phiên hiện trên `remote.machines` của chủ máy; người khác không thấy phiên riêng tư", async () => {
    const machines = await as("tmember", (tx, userId) => remoteMachines(tx, userId));
    const mine = machines.find((m) => m.id === personalId);
    expect(mine).toMatchObject({ online: true, terminal: true, remote: null, totpAllowed: true });
    expect(mine?.sessions.map((s) => s.id)).toContain(sessionId);
    expect(machines.some((m) => m.name.startsWith("shared-"))).toBe(false);

    expect(await as("tadmin", (tx, userId) => remoteMachines(tx, userId))).toEqual([]);
    expect(await errorCode(() => as("tadmin", (tx, userId) => getRemoteSession(tx, userId, sessionId)))).toBe(
      "SESSION_NOT_FOUND",
    );
    expect((await as("tadmin", (tx, userId) => listRemoteSessions(tx, userId, {}))).map((s) => s.id)).not.toContain(
      sessionId,
    );
  });

  it("Cho đội xem: chỉ chủ máy đổi được; thành viên đội thấy, đội khác không", async () => {
    expect(
      await errorCode(() => as("tadmin", (tx, userId) => setRemoteVisibility(tx, userId, sessionId, "team"))),
    ).toBe("SESSION_NOT_FOUND");
    const s = await as("tmember", (tx, userId) => setRemoteVisibility(tx, userId, sessionId, "team"));
    expect(s.visibility).toBe("team");
    const seen = await as("tviewer", (tx, userId) => listRemoteSessions(tx, userId, { taskId }));
    expect(seen.map((x) => [x.id, x.isOwner])).toEqual([[sessionId, false]]);
    expect(
      await errorCode(() => as("tviewer", (tx, userId) => setRemoteVisibility(tx, userId, sessionId, "private"))),
    ).toBe("MACHINE_NOT_YOURS");
    expect(await errorCode(() => as("oadmin", (tx, userId) => getRemoteSession(tx, userId, sessionId)))).toBe(
      "SESSION_NOT_FOUND",
    );
  });

  it("máy mất kết nối không kết thúc phiên tại máy; term_exit thì kết thúc", async () => {
    const m = await newMachine("flaky", false);
    const w = await Worker.connect(m.machineToken, `flaky-${tag}`, ["terminal"]);
    const id = randomUUID();
    w.send(opened(id));
    await until(
      async () => (await admin.query("select 1 from hive.terminal_sessions where id = $1", [id])).rowCount === 1,
    );
    w.ws.close();
    await until(
      async () =>
        (await admin.query("select status from hive.machines where id = $1", [m.id])).rows[0]?.status === "offline",
    );
    expect((await admin.query("select state from hive.terminal_sessions where id = $1", [id])).rows[0].state).toBe(
      "running",
    );

    personal.send({ type: "term_exit", sessionId, exitCode: 0, reason: "exit" });
    await until(
      async () =>
        (await admin.query("select state from hive.terminal_sessions where id = $1", [sessionId])).rows[0].state ===
        "closed",
    );
    const s = await as("tmember", (tx, userId) => getRemoteSession(tx, userId, sessionId));
    expect(s).toMatchObject({ state: "closed", exitCode: 0, endReason: "CLI đã thoát." });
  });

  it("task đội khác bị bỏ liên kết; `record: false` không ghi; phiên lạ chỉ ack, không đóng PTY", async () => {
    const id = randomUUID();
    personal.send(opened(id, { taskId: otherTaskId, projectId: randomUUID() }));
    await until(
      async () => (await admin.query("select 1 from hive.terminal_sessions where id = $1", [id])).rowCount === 1,
    );
    const row = await admin.query("select project_id, task_id from hive.terminal_sessions where id = $1", [id]);
    expect(row.rows[0]).toEqual({ project_id: null, task_id: null });

    const skip = randomUUID();
    personal.send(opened(skip, { record: false }));
    personal.send({ type: "term_output", sessionId: skip, seq: 4, data: b64("không ghi") });
    await personal.until((m) => m.type === "term_ack" && m.sessionId === skip && m.upto === 4);
    expect((await admin.query("select 1 from hive.terminal_sessions where id = $1", [skip])).rowCount).toBe(0);
    expect(personal.inbox.some((m) => m.type === "term_close" && m.sessionId === skip)).toBe(false);
  });

  it("máy khác cùng tổ chức không ghi được vào phiên của máy này", async () => {
    const m = await newMachine("intruder", false);
    const w = await Worker.connect(m.machineToken, `intruder-${tag}`, ["terminal"]);
    const id = randomUUID();
    personal.send(opened(id));
    await until(
      async () => (await admin.query("select 1 from hive.terminal_sessions where id = $1", [id])).rowCount === 1,
    );
    w.send(opened(id));
    w.send({ type: "term_output", sessionId: id, seq: 0, data: b64("giả") });
    w.send({ type: "term_exit", sessionId: id, exitCode: 1, reason: "exit" });
    await w.until((m) => m.type === "term_ack" && m.sessionId === id);
    const s = await admin.query("select machine_id, state, bytes from hive.terminal_sessions where id = $1", [id]);
    expect(s.rows[0]).toMatchObject({ machine_id: personalId, state: "running" });
    expect(Number(s.rows[0].bytes)).toBe(0);
  });
});
