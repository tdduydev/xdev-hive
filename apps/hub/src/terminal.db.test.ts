// Terminal Leader (specs/010 lát máy dùng chung, specs/011 FR-067) đầu-cuối trong hub: client `ws` đóng vai worker Go và
// trình duyệt, client MCP thật dùng token phiên mà hub gửi xuống worker trong term_open.
import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  SYSTEM_ROLE_PERMISSIONS,
  TERMINAL_WS_CLOSE,
  type TerminalServerFrame,
  terminalServerFrame,
} from "@xdev-hive/contracts";
import { type HubToWorker, hubToWorker, PROTOCOL_VERSION } from "@xdev-hive/contracts/worker-protocol";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import WebSocket from "ws";
import { type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import { seedProject } from "../test/project-fixture.ts";
import { createApp } from "./app.ts";
import { attachWorkerGateway, registerTerminalHandlers } from "./modules/fleet/index.ts";
import { createRegistration, registerMachine } from "./modules/fleet/registration.ts";
import { type Auth, createAuth } from "./modules/identity/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "./modules/platform/index.ts";
import { createRunsEngine, type RunsEngine } from "./modules/runs/index.ts";
import { createMemoryProvider } from "./modules/scm/index.ts";
import { attachTerminalGateway, createTerminalHandlers, sweepOnce } from "./modules/terminal/index.ts";
import {
  closeSession,
  openSession,
  sessionActivity,
  sessionChunks,
  sessionTicket,
  setVisibility,
  type TerminalDeps,
  terminalOptions,
} from "./modules/terminal/service.ts";

const { adminUrl, appUrl, authUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const authPool = createPool(authUrl);
const secret = "test-secret-0123456789abcdef-0123456789";
const tag = randomUUID().slice(0, 6);
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

let org: OrgFixture & { user: (n: string) => string };
let auth: Auth;
let engine: RunsEngine;
let server: Server;
let baseURL = "";
let host = "";
let projectId = "";
let deps: TerminalDeps;
const closers: Array<() => Promise<void> | void> = [];

const ba = () => org.user("ba");

async function asUser<T>(name: string, fn: (tx: Tx, userId: string) => Promise<T>): Promise<T> {
  const userId = name === "ba" ? ba() : org.user(name);
  return withTenant(pool, { userId, orgId: org.orgId }, (tx) => fn(tx, userId));
}

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

async function until(check: () => Promise<boolean> | boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Hết thời gian chờ");
    await new Promise((r) => setTimeout(r, 20));
  }
}

class Inbox<T> {
  private items: T[] = [];
  private waiters: ((m: T) => void)[] = [];
  push(m: T) {
    const w = this.waiters.shift();
    if (w) w(m);
    else this.items.push(m);
  }
  next(ms = 4000): Promise<T> {
    const m = this.items.shift();
    if (m) return Promise.resolve(m);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Hết thời gian chờ gói")), ms);
      this.waiters.push((v) => {
        clearTimeout(timer);
        resolve(v);
      });
    });
  }
  async until(match: (m: T) => boolean, ms = 4000): Promise<T> {
    for (;;) {
      const m = await this.next(ms);
      if (match(m)) return m;
    }
  }
}

/** Worker giả: hello có capability terminal, nhận gói term_*. */
class Worker {
  readonly ws: WebSocket;
  readonly inbox = new Inbox<HubToWorker>();
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
      os: "linux",
      clis: ["claude"],
      capacity: 2,
      capabilities,
    });
    await w.inbox.until((m) => m.type === "welcome");
    closers.push(() => w.ws.close());
    return w;
  }
  send(msg: Record<string, unknown>) {
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), ...msg }));
  }
  async heartbeat(extra: Record<string, unknown> = {}) {
    this.send({ type: "heartbeat", load: 0, runs: [], ...extra });
    await this.inbox.until((m) => m.type === "heartbeat_ack");
  }
  termOpen() {
    return this.inbox.until((m) => m.type === "term_open") as Promise<Extract<HubToWorker, { type: "term_open" }>>;
  }
}

/** Trình duyệt giả trên /ws/terminal. */
async function browser(ticket: string, origin = baseURL) {
  const ws = new WebSocket(`ws://${host}/ws/terminal?ticket=${ticket}`, { headers: { origin } });
  const inbox = new Inbox<TerminalServerFrame>();
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  ws.on("message", (data) => inbox.push(terminalServerFrame.parse(JSON.parse(data.toString()))));
  const opened = await new Promise<number | null>((resolve) => {
    ws.once("open", () => resolve(null));
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.once("error", () => resolve(-1));
  });
  closers.push(() => ws.close());
  return { ws, inbox, closed, status: opened, send: (f: Record<string, unknown>) => ws.send(JSON.stringify(f)) };
}

async function newMachine(name: string, shared: boolean) {
  const { token } = await asUser("tadmin", (tx, userId) =>
    createRegistration(tx, userId, org.teamId, "worker", shared ? { shared: true } : {}),
  );
  return registerMachine(pool, {
    registrationToken: token,
    machineId: `${name}-${tag}`,
    os: "linux",
    version: "0.9.0",
    clis: ["claude"],
    capacity: 2,
  });
}

const account = {
  id: "claude-1",
  cli: "claude",
  label: "Gói Max đội",
  roles: [],
  enabled: true,
  loggedIn: true,
  sessionPct: 10,
  weekPct: 5,
  resetsAt: null,
  stopAtSession: 0,
  stopAtWeek: 0,
  inUse: 0,
};

async function mcp(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "claude-terminal", version: "1.0.0" });
  await client.connect(transport);
  closers.push(() => client.close());
  return client;
}

const json = (result: unknown) => {
  const r = result as { content: { text: string }[]; isError?: boolean };
  if (r.isError) throw new Error(r.content.map((c) => c.text).join("\n"));
  return JSON.parse(r.content.map((c) => c.text).join("")) as Record<string, unknown>;
};

let sharedId = "";
let personalId = "";
let worker: Worker;

beforeAll(async () => {
  org = await seedOrg(admin, `term-${tag}`);
  const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
  ({ projectId } = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: `TL${tag}`,
  }));
  // BA/PO: người xem của đội cộng vai trò tự tạo nhân bản từ team-ba (hub chưa lưu vai trò đội "ba").
  await admin.query(
    `insert into auth."user" (id, name, email) values ($1, $1, $1 || '@seed.test') on conflict (id) do nothing`,
    [ba()],
  );
  await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [
    org.orgId,
    ba(),
  ]);
  await admin.query("insert into hive.team_members (team_id, org_id, user_id, role) values ($1, $2, $3, 'viewer')", [
    org.teamId,
    org.orgId,
    ba(),
  ]);
  const role = await admin.query(
    "insert into hive.custom_roles (org_id, name, scope, permissions, created_by) values ($1, 'BA/PO', 'team', $2, $3) returning id",
    [org.orgId, [...SYSTEM_ROLE_PERMISSIONS["team-ba"]], org.user("admin")],
  );
  await admin.query("insert into hive.member_custom_roles (org_id, user_id, role_id) values ($1, $2, $3)", [
    org.orgId,
    ba(),
    role.rows[0].id,
  ]);

  server = serve({ fetch: (req) => appFetch(req), port: 0, hostname: "127.0.0.1" }) as Server;
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  const port = (server.address() as AddressInfo).port;
  host = `127.0.0.1:${port}`;
  baseURL = `http://localhost:${port}`;
  auth = createAuth({ pool: authPool, baseURL, secret, allowEmailSignUp: true });
  engine = createRunsEngine({
    pool,
    publicUrl: baseURL,
    authSecret: secret,
    masterKey,
    providerFactory: () => createMemoryProvider("gitlab", ["xdev-team"]),
    logger: quiet,
  });
  const app = createApp({
    config: { port: 0, version: "t", publicUrl: baseURL, authSecret: secret, remoteTerminal: true },
    auth,
    pool,
    runs: engine,
  });
  appFetch = (req) => app.fetch(req);
  const gateway = attachWorkerGateway(server, { pool, heartbeatSec: 5, helloTimeoutMs: 500, logger: quiet });
  closers.push(registerTerminalHandlers(createTerminalHandlers(pool)));
  const terminal = attachTerminalGateway(server, { pool, publicUrl: baseURL, logger: quiet, sweepMs: 3_600_000 });
  closers.push(
    () => terminal.close(),
    () => gateway.close(),
  );
  const { terminalTokenKey } = await import("./modules/terminal/index.ts");
  deps = { enabled: true, publicUrl: baseURL, tokenKey: terminalTokenKey(secret) };

  const shared = await newMachine("shared", true);
  sharedId = shared.id;
  worker = await Worker.connect(shared.machineToken, `shared-${tag}`, ["terminal", "accounts-remote"]);
  await worker.heartbeat({ accounts: [account] });
  const personal = await newMachine("personal", false);
  personalId = personal.id;
  // Máy cá nhân của một thành viên (chủ máy là người dùng gói của máy).
  await admin.query("update hive.machines set registered_by = $1 where id = $2", [org.user("tmember"), personalId]);
  await Worker.connect(personal.machineToken, `personal-${tag}`, ["terminal"]);
});

let appFetch: (req: Request) => Response | Promise<Response> = () => new Response(null, { status: 503 });

afterAll(async () => {
  for (const close of closers.reverse()) await close();
  engine?.stop();
  if (server) await new Promise((resolve) => server.close(resolve));
  await Promise.all([admin.end(), pool.end(), authPool.end()]);
});

const openInput = (extra: Record<string, unknown> = {}) => ({
  projectId,
  machineId: sharedId,
  mode: "propose" as const,
  model: "sonnet" as const,
  cols: 120,
  rows: 32,
  ...extra,
});

async function open(name: string, extra: Record<string, unknown> = {}) {
  const userId = name === "ba" ? ba() : org.user(name);
  const { session, afterCommit } = await withTenant(pool, { userId, orgId: org.orgId }, (tx) =>
    openSession(tx, { id: userId, name }, org.orgId, openInput(extra), deps),
  );
  afterCommit();
  return session;
}

describe("quyền mở terminal Leader", () => {
  it("chỉ liệt kê máy dùng chung có terminal; thành viên thường không được mở", async () => {
    const opts = await asUser("tadmin", (tx, id) => terminalOptions(tx, id, projectId, deps));
    expect(opts.allowed).toBe(true);
    expect(opts.machines.map((m) => m.id)).toEqual([sharedId]);
    expect(opts.machines[0]).toMatchObject({ online: true, busy: false, accounts: [{ id: "claude-1" }] });
    expect(opts.defaultModel).toBe("sonnet");
    expect(opts.costs.map((c) => c.model)).toEqual(["sonnet", "opus"]);
    expect((await asUser("tmember", (tx, id) => terminalOptions(tx, id, projectId, deps))).allowed).toBe(false);
    expect((await asUser("ba", (tx, id) => terminalOptions(tx, id, projectId, deps))).allowed).toBe(true);
  });

  it("từ chối thành viên thường, máy cá nhân, Bypass chưa xác nhận, hub tắt cờ", async () => {
    expect(await codeOf(() => open("tmember"))).toBe("TERMINAL_ROLE_REQUIRED");
    expect(await codeOf(() => open("tadmin", { machineId: personalId }))).toBe("TERMINAL_MACHINE_INVALID");
    expect(await codeOf(() => open("tadmin", { mode: "bypass" }))).toBe("TERMINAL_BYPASS_CONFIRM");
    expect(await codeOf(() => open("tadmin", { accountId: "khong-co" }))).toBe("ACCOUNT_NOT_FOUND");
    const off = { ...deps, enabled: false };
    expect(
      await codeOf(() =>
        asUser("tadmin", (tx, id) => openSession(tx, { id, name: "tadmin" }, org.orgId, openInput(), off)),
      ),
    ).toBe("TERMINAL_DISABLED");
    // Người ngoài đội không thấy dự án.
    expect(await codeOf(() => open("oadmin"))).toBe("PROJECT_NOT_FOUND");
  });
});

describe("phiên Đề xuất của BA/PO", () => {
  let sessionId = "";
  let mcpToken = "";

  it("gửi term_open có token MCP riêng, ghi audit, không trả token cho trình duyệt", async () => {
    const session = await open("ba", { accountId: "claude-1" });
    sessionId = session.id;
    expect(session).toMatchObject({ state: "opening", mode: "propose", model: "sonnet", accountLabel: "Gói Max đội" });
    expect(JSON.stringify(session)).not.toContain("eyJ");
    const msg = await worker.termOpen();
    expect(msg).toMatchObject({ sessionId, cli: "claude", model: "sonnet", effort: "high", accountId: "claude-1" });
    expect(msg.systemPrompt).toContain("Chế độ Đề xuất");
    expect(msg.systemPrompt).toContain("leader_tiers");
    mcpToken = msg.mcpToken;
    const audit = await admin.query(
      "select data from hive.audit_log where org_id = $1 and action = 'terminal.open' and target_id = $2",
      [org.orgId, sessionId],
    );
    expect(audit.rows[0].data).toMatchObject({ mode: "propose", machineId: sharedId, model: "sonnet" });
  });

  it("chuyển output đã che bí mật tới trình duyệt và lưu bản ghi; phím của chủ phiên xuống worker", async () => {
    worker.send({ type: "term_opened", sessionId, accountLabel: "Gói Max đội", permissions: "workspace" });
    const { ticket, canInput } = await asUser("ba", (tx, id) => sessionTicket(tx, id, org.orgId, sessionId));
    expect(canInput).toBe(true);
    const b = await browser(ticket);
    expect(b.status).toBeNull();
    const hello = await b.inbox.next();
    expect(hello).toMatchObject({ t: "hello", canInput: true });
    const secretText = "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123\r\nXin chào\r\n";
    worker.send({ type: "term_output", sessionId, seq: 0, data: Buffer.from(secretText).toString("base64") });
    const out = (await b.inbox.until((f) => f.t === "out")) as Extract<TerminalServerFrame, { t: "out" }>;
    const shown = Buffer.from(out.data, "base64").toString();
    expect(shown).toContain("Xin chào");
    expect(shown).not.toContain("sk-ant-api03");
    b.send({ t: "in", data: Buffer.from("ls\r").toString("base64") });
    const input = await worker.inbox.until((m) => m.type === "term_input");
    expect(input).toMatchObject({ sessionId, data: Buffer.from("ls\r").toString("base64") });
    b.send({ t: "resize", cols: 100, rows: 30 });
    expect(await worker.inbox.until((m) => m.type === "term_resize")).toMatchObject({ cols: 100, rows: 30 });
    const stored = await asUser("ba", (tx, id) => sessionChunks(tx, id, { id: sessionId, after: -1, limit: 10 }));
    expect(Buffer.from(stored.chunks[0]?.data ?? "", "base64").toString()).not.toContain("sk-ant-api03");
    // Nối lại: gửi lại output sau seq đã có.
    const { ticket: again } = await asUser("ba", (tx, id) => sessionTicket(tx, id, org.orgId, sessionId));
    const b2 = await browser(again);
    await b2.inbox.next();
    b2.send({ t: "resume", after: -1 });
    expect(await b2.inbox.until((f) => f.t === "out")).toMatchObject({ seq: 0 });
  });

  it("chặn Origin lạ, vé dùng lại; người xem của đội không gõ được", async () => {
    const { ticket } = await asUser("ba", (tx, id) => sessionTicket(tx, id, org.orgId, sessionId));
    expect((await browser(ticket, "https://evil.example")).status).toBe(403);
    expect((await browser(ticket)).status).toBe(401);
    // Riêng tư: thành viên khác không thấy phiên.
    expect(await codeOf(() => asUser("tmember", (tx, id) => sessionTicket(tx, id, org.orgId, sessionId)))).toBe(
      "TERMINAL_NOT_FOUND",
    );
    await asUser("ba", (tx, id) => setVisibility(tx, id, sessionId, "team"));
    const view = await asUser("tmember", (tx, id) => sessionTicket(tx, id, org.orgId, sessionId));
    expect(view.canInput).toBe(false);
    const v = await browser(view.ticket);
    expect(await v.inbox.next()).toMatchObject({ t: "hello", canInput: false });
    v.send({ t: "in", data: Buffer.from("rm -rf /\r").toString("base64") });
    expect(await v.inbox.until((f) => f.t === "error")).toMatchObject({ code: "TERMINAL_READ_ONLY" });
    // Tắt "Cho đội xem" thì người xem bị ngắt.
    await asUser("ba", (tx, id) => setVisibility(tx, id, sessionId, "private"));
    expect(await v.closed).toBe(TERMINAL_WS_CLOSE.forbidden);
  });

  it("Leader chỉ thấy tool đọc và leader_action; đề xuất có cấp độ, người duyệt đổi cấp trước khi duyệt", async () => {
    const client = await mcp(mcpToken);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["leader_action", "leader_tiers", "doc_get", "memory_search"]));
    expect(names).not.toContain("memory_write");
    expect(names).not.toContain("leader_propose");
    const tiers = json(await client.callTool({ name: "leader_tiers", arguments: {} }));
    expect((tiers.tiers as { tier: string; model: string }[]).map((t) => [t.tier, t.model])).toEqual([
      ["light", "sonnet"],
      ["medium", "sonnet"],
      ["heavy", "opus"],
    ]);
    const proposed = json(
      await client.callTool({
        name: "leader_action",
        arguments: {
          action: {
            type: "task.create",
            projectId,
            title: "Sửa chữ trang đăng nhập",
            tier: "light",
            tierReason: "Chỉ đổi chữ.",
          },
          rationale: "Người dùng muốn sửa chữ.",
        },
      }),
    );
    expect(proposed.approvalId).toBeTruthy();
    const tasksBefore = await admin.query("select count(*)::int as n from hive.tasks where project_id = $1", [
      projectId,
    ]);
    expect(tasksBefore.rows[0].n).toBe(0);
    const activity = await asUser("ba", (tx, id) => sessionActivity(tx, id, sessionId));
    expect(activity.proposals[0]?.action).toMatchObject({
      type: "task.create",
      tier: "light",
      tierReason: "Chỉ đổi chữ.",
    });
    const audit = await admin.query(
      "select data from hive.audit_log where org_id = $1 and action = 'terminal.propose' order by created_at desc limit 1",
      [org.orgId],
    );
    expect(audit.rows[0].data).toMatchObject({ terminalSessionId: sessionId, tier: "light", model: "sonnet" });

    // Quản trị đội duyệt nhưng nâng cấp độ: task mang nhãn tier mới, audit ghi cả cấp Leader đề xuất.
    const res = await fetch(`${baseURL}/rpc/leader/approvals/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hive-org": org.orgId, cookie: await cookieOf("tadmin") },
      body: JSON.stringify({ json: { id: proposed.approvalId, tier: "heavy" } }),
    });
    expect(res.status).toBe(200);
    const task = await admin.query("select source from hive.tasks where project_id = $1", [projectId]);
    expect(task.rows[0].source).toMatchObject({ kind: "leader", labels: ["tier:heavy"] });
    const approved = await admin.query(
      "select data from hive.audit_log where org_id = $1 and action = 'leader.approval.approve' order by created_at desc limit 1",
      [org.orgId],
    );
    expect(approved.rows[0].data).toMatchObject({ tier: "heavy", proposedTier: "light", model: "opus" });
  });

  it("đóng phiên khi người mở mất vai trò BA/PO", async () => {
    await admin.query("delete from hive.member_custom_roles where org_id = $1 and user_id = $2", [org.orgId, ba()]);
    expect(await sweepOnce(pool)).toBe(1);
    expect(await worker.inbox.until((m) => m.type === "term_close")).toMatchObject({ sessionId });
    const row = await admin.query("select state, end_reason from hive.terminal_sessions where id = $1", [sessionId]);
    expect(row.rows[0]).toMatchObject({ state: "closed" });
    expect(row.rows[0].end_reason).toContain("không còn vai trò");
    // Token cũ không vào được cổng MCP nữa.
    await expect(mcp(mcpToken)).rejects.toBeDefined();
  });
});

describe("phiên Bypass của quản trị đội", () => {
  it("leader_action làm ngay bằng quyền người mở, audit kèm cấp độ và model; run giao theo cấp", async () => {
    const session = await open("tadmin", { mode: "bypass", confirmBypass: true });
    const msg = await worker.termOpen();
    expect(msg.systemPrompt).toContain("Chế độ Bypass");
    const client = await mcp(msg.mcpToken);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["leader_action", "memory_write"]));
    const created = json(
      await client.callTool({
        name: "leader_action",
        arguments: {
          action: {
            type: "task.create",
            projectId,
            title: "Đổi giao thức worker",
            tier: "heavy",
            tierReason: "Giao thức.",
          },
          rationale: "Theo yêu cầu.",
        },
      }),
    );
    const task = (created.result as { task: { id: string } }).task;
    expect(task.id).toBeTruthy();
    const dispatched = json(
      await client.callTool({
        name: "leader_action",
        arguments: {
          action: { type: "run.dispatch", taskId: task.id, tier: "medium", tierReason: "Đã có kế hoạch rõ." },
          rationale: "Giao run.",
        },
      }),
    );
    const runId = (dispatched.result as { run: { id: string } }).run.id;
    const run = await admin.query("select tier from hive.runs where id = $1", [runId]);
    expect(run.rows[0].tier).toBe("medium");
    const { actions } = await asUser("tadmin", (tx, id) => sessionActivity(tx, id, session.id));
    expect(actions.filter((a) => a.tool === "leader_action").map((a) => [a.tier, a.model])).toEqual([
      ["medium", "sonnet"],
      ["heavy", "opus"],
    ]);
    const closed = await asUser("tadmin", (tx, id) => closeSession(tx, id, session.id));
    closed.afterCommit();
    expect(closed.session.state).toBe("closed");
    expect(await worker.inbox.until((m) => m.type === "term_close")).toMatchObject({ sessionId: session.id });
    // Worker báo thoát sau khi đóng: chỉ ghi mã thoát, không đổi lý do.
    worker.send({ type: "term_exit", sessionId: session.id, exitCode: 0, reason: "closed" });
    await until(async () => {
      const r = await admin.query("select exit_code from hive.terminal_sessions where id = $1", [session.id]);
      return r.rows[0].exit_code === 0;
    });
  });

  it("máy mất kết nối thì phiên đang chạy thành failed; đủ số phiên thì máy bận", async () => {
    const sessions: Awaited<ReturnType<typeof open>>[] = [];
    for (let i = 0; i < 4; i++) {
      sessions.push(await open("tadmin"));
      await worker.termOpen();
    }
    expect(await codeOf(() => open("tadmin"))).toBe("TERMINAL_MACHINE_BUSY");
    const opts = await asUser("tadmin", (tx, id) => terminalOptions(tx, id, projectId, deps));
    expect(opts.machines[0]?.busy).toBe(true);
    worker.send({
      type: "term_exit",
      sessionId: sessions[0]?.id,
      exitCode: null,
      reason: "denied",
      message: "Máy bận.",
    });
    await until(async () => {
      const r = await admin.query("select state, end_reason from hive.terminal_sessions where id = $1", [
        sessions[0]?.id,
      ]);
      return r.rows[0].state === "failed" && r.rows[0].end_reason === "Máy bận.";
    });
    worker.ws.close();
    await until(async () => {
      const r = await admin.query(
        "select count(*)::int as n from hive.terminal_sessions where machine_id = $1 and state in ('opening', 'running')",
        [sharedId],
      );
      return r.rows[0].n === 0;
    });
  });
});

/** Cookie phiên của người dùng seed: đăng ký email qua Better Auth rồi trỏ id seed sang tài khoản mới là quá dài; dùng token cá nhân thay thế. */
async function cookieOf(name: string): Promise<string> {
  const email = `${name}-${tag}@login.test`;
  const signUp = await auth.api.signUpEmail({
    body: { email, password: "mat-khau-dai-123456", name },
    asResponse: true,
  });
  const cookie = signUp.headers.get("set-cookie") ?? "";
  const userId = ((await signUp.json()) as { user: { id: string } }).user.id;
  // Người dùng mới thay vai trò của người seed: cùng quyền quản trị đội.
  await admin.query(
    "insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member') on conflict do nothing",
    [org.orgId, userId],
  );
  await admin.query(
    "insert into hive.team_members (team_id, org_id, user_id, role) values ($1, $2, $3, 'admin') on conflict do nothing",
    [org.teamId, org.orgId, userId],
  );
  return cookie.split(";")[0] ?? "";
}
