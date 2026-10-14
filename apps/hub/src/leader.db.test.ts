// Test e2e luồng leader agent: gửi tin → run leader → leader_reply → leader_propose
// tạo approval → duyệt → hành động thực hiện → tin hệ thống báo kết quả; từ chối; quyền; RLS.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Approval, ChatMessage, ChatThread } from "@xdev-hive/contracts";
import { type HubToWorker, hubToWorker, PROTOCOL_VERSION } from "@xdev-hive/contracts/worker-protocol";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import WebSocket from "ws";
import { type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import { seedProject } from "../test/project-fixture.ts";
import { createApp } from "./app.ts";
import { provideLinkTarget, provideThreadHost, purgeArtifacts } from "./modules/artifacts/index.ts";
import { attachWorkerGateway, registerRunHandlers } from "./modules/fleet/index.ts";
import { createAuth } from "./modules/identity/index.ts";
import {
  appendLeaderSystemMessage,
  createThreadHost,
  createThreadLinkTarget,
  queuedLeaderPrompt,
} from "./modules/leader/index.ts";
import { createPool, parseMasterKey } from "./modules/platform/index.ts";
import { createRunsEngine, type RunsEngine } from "./modules/runs/index.ts";
import { createMemoryProvider, type MemoryProvider } from "./modules/scm/index.ts";

const { adminUrl, appUrl, authUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const authPool = createPool(authUrl);
const secret = "test-secret-0123456789abcdef-0123456789";
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const sha = "a".repeat(40);

let orgA: OrgFixture & { user: (n: string) => string };
let orgB: OrgFixture & { user: (n: string) => string };
let projectIdA = "";
let provider: MemoryProvider;
let engine: RunsEngine;
let server: Server;
let gateway: { close: () => Promise<void> };
let unregister: () => void;
let baseURL = "";
let fetchApp: (req: Request) => Response | Promise<Response> = () => new Response(null, { status: 503 });

let cookieDev = "";
let cookieOrgB = "";
const clients: Client[] = [];

beforeAll(async () => {
  server = serve({ fetch: (req) => fetchApp(req), port: 0, hostname: "127.0.0.1" }) as Server;
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  orgA = await seedOrg(admin, `ldr-a-${tag}`);
  orgB = await seedOrg(admin, `ldr-b-${tag}`);

  const projectA = await seedProject(admin, pool, {
    orgId: orgA.orgId,
    teamId: orgA.teamId,
    systemId: orgA.systemId,
    adminUserId: orgA.user("admin"),
    masterKey,
    key: `ldr${tag}`,
  });
  projectIdA = projectA.projectId;

  provider = createMemoryProvider("gitlab", ["xdev-team"]);
  provider.seedRepo({ owner: projectA.owner, name: projectA.repo });
  const providerFactory = () => provider;

  const auth = createAuth({ pool: authPool, baseURL, secret, allowEmailSignUp: true });
  engine = createRunsEngine({
    pool,
    publicUrl: baseURL,
    authSecret: secret,
    masterKey,
    providerFactory,
    logger: quiet,
    leaderMessage: appendLeaderSystemMessage,
    leaderQueuedPrompt: queuedLeaderPrompt,
  });
  unregister = registerRunHandlers(engine.handlers);
  // Hook thật của module leader (main.ts nối ở T050); postFixRequest thuộc T016.
  provideThreadHost({
    ...createThreadHost(),
    postFixRequest: async () => {
      throw new Error("chưa có ở T013");
    },
  });
  provideLinkTarget("chat_thread", createThreadLinkTarget());
  const app = createApp({
    config: { port: 0, version: "test", publicUrl: baseURL },
    auth,
    pool,
    runs: engine,
    providerFactory,
  });
  fetchApp = (req) => app.fetch(req);
  gateway = attachWorkerGateway(server, { pool, heartbeatSec: 5, logger: quiet });

  // Tạo tài khoản và session
  const login = async (email: string, name: string) => {
    const signup = await fetch(`${baseURL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password-123456", name }),
    });
    expect(signup.status).toBe(200);
    const sid = signup.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const data = (await signup.json()) as { user: { id: string } };
    return { id: data.user.id, cookie: sid };
  };

  const devUser = await login(`dev-ldr-${tag}@example.com`, "Dev Leader");
  cookieDev = devUser.cookie;
  await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [
    orgA.orgId,
    devUser.id,
  ]);
  await admin.query("insert into hive.team_members (team_id, org_id, user_id, role) values ($1, $2, $3, 'member')", [
    orgA.teamId,
    orgA.orgId,
    devUser.id,
  ]);

  const userB = await login(`user-b-${tag}@example.com`, "User OrgB");
  cookieOrgB = userB.cookie;
  await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [
    orgB.orgId,
    userB.id,
  ]);
});

const openWorkers = new Set<FakeWorker>();
afterEach(async () => {
  await Promise.all([...openWorkers].map((w) => w.close()));
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  clients.length = 0;
});

afterAll(async () => {
  unregister();
  provideThreadHost(undefined);
  provideLinkTarget("chat_thread", undefined);
  await Promise.all([...openWorkers].map((w) => w.close()));
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  engine.stop();
  await gateway.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await Promise.all([admin.end(), pool.end(), authPool.end()]);
});

async function api<T>(method: string, path: string, body?: unknown, cookie = cookieDev) {
  const res = await fetchApp(
    new Request(`${baseURL}/api${path}`, {
      method,
      headers: {
        cookie,
        "x-hive-org": orgA.orgId,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }),
  );
  return { status: res.status, data: (await res.json().catch(() => null)) as T };
}

async function until(check: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Hết thời gian chờ");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function seedMachine(name: string, clis = ["claude", "codex"]) {
  const token = `hwm_${randomBytes(32).toString("base64url")}`;
  // Máy dùng chung của đội: nhận cả run của đội (Leader, gate AI) lẫn run của mọi thành viên (ADR 0017).
  const { rows } = await admin.query(
    "insert into hive.machines (org_id, team_id, name, os, version, clis, capacity, shared) values ($1, $2, $3, 'linux', '1', $4, 2, true) returning id",
    [orgA.orgId, orgA.teamId, name, clis],
  );
  await admin.query(
    "insert into hive.machine_tokens (org_id, team_id, machine_id, token_hash) values ($1, $2, $3, $4)",
    [orgA.orgId, orgA.teamId, rows[0].id, createHash("sha256").update(token).digest("hex")],
  );
  return { name, token, clis };
}

type Msg<T extends HubToWorker["type"]> = Extract<HubToWorker, { type: T }>;

class FakeWorker {
  readonly ws: WebSocket;
  private inbox: HubToWorker[] = [];
  private waiters: Array<{ match: (m: HubToWorker) => boolean; resolve: (m: HubToWorker) => void }> = [];
  private seq = 0;

  constructor(token: string) {
    this.ws = new WebSocket(`${baseURL.replace("http", "ws")}/ws/worker`, {
      headers: { authorization: `Bearer ${token}` },
    });
    this.ws.on("message", (data) => {
      const msg = hubToWorker.parse(JSON.parse(data.toString()));
      const i = this.waiters.findIndex((w) => w.match(msg));
      if (i >= 0) this.waiters.splice(i, 1)[0]?.resolve(msg);
      else this.inbox.push(msg);
    });
  }

  static async connect(m: { name: string; token: string; clis: string[] }) {
    const w = new FakeWorker(m.token);
    openWorkers.add(w);
    await new Promise<void>((resolve, reject) => {
      w.ws.once("open", () => resolve());
      w.ws.once("error", reject);
    });
    w.send({
      type: "hello",
      machineId: m.name,
      version: "0.3.0",
      protoRange: [1, 1],
      os: "linux",
      clis: m.clis,
      capacity: 2,
    });
    await w.next("welcome");
    return w;
  }

  send(msg: Record<string, unknown>) {
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), ...msg }));
  }

  next<T extends HubToWorker["type"]>(type: T, where: (m: Msg<T>) => boolean = () => true, ms = 5000): Promise<Msg<T>> {
    const match = (m: HubToWorker) => m.type === type && where(m as Msg<T>);
    const i = this.inbox.findIndex(match);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0] as Msg<T>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Không nhận được gói ${type}`)), ms);
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Msg<T>);
        },
      });
    });
  }

  async take(runId: string) {
    const offer = await this.next("job_offer", (o) => o.runId === runId);
    this.send({ type: "job_accept", runId, attempt: offer.attempt });
    const lease = await this.next("lease", (l) => l.runId === runId);
    return { spec: offer.spec, runToken: lease.runToken };
  }

  async finish(runId: string, exit: number, report: Record<string, unknown> = {}, headSha: string | null = sha) {
    const seq = this.seq++;
    this.send({ type: "run_result", runId, attempt: 1, exit, headSha, report, seq });
    await this.next("ack", (a) => a.runId === runId && a.uptoSeq === seq);
  }

  async close() {
    if (!openWorkers.delete(this)) return;
    const closed = new Promise((resolve) => this.ws.once("close", resolve));
    this.ws.close();
    await closed;
  }
}

async function mcpClient(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "agent-leader", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

describe("Leader chat e2e", () => {
  it("luồng trọn vẹn: gửi tin → run leader → leader_reply → leader_propose → duyệt → task được tạo và có tin hệ thống", async () => {
    const worker = await FakeWorker.connect(await seedMachine(`ldr-1-${tag}`));

    // 1. Tạo thread
    const threadRes = await api<ChatThread>("POST", "/v1/leader/threads", {
      projectId: projectIdA,
      title: "Hỏi về tính năng mới",
    });
    expect(threadRes.status).toBe(200);
    const thread = threadRes.data;
    expect(thread.id).toBeDefined();

    // 2. Gửi tin nhắn đầu tiên
    const sendRes = await api<{ message: ChatMessage; runId: string }>(
      "POST",
      `/v1/leader/threads/${thread.id}/messages`,
      { content: "Tôi cần thêm tính năng xuất báo cáo PDF. Bạn đề xuất gì?", cli: "claude" },
    );
    expect(sendRes.status).toBe(200);
    expect(sendRes.data.message.content).toBe("Tôi cần thêm tính năng xuất báo cáo PDF. Bạn đề xuất gì?");
    const runId = sendRes.data.runId;
    expect(runId).toBeTruthy();

    // 3. Worker nhận job_offer loại leader
    const { spec, runToken } = await worker.take(runId);
    expect((spec as Record<string, unknown>).kind).toBe("leader");
    expect(typeof (spec as Record<string, unknown>).prompt).toBe("string");
    expect((spec as Record<string, unknown>).prompt).toContain("Tôi cần thêm tính năng xuất báo cáo PDF");
    expect((spec as Record<string, unknown>).prompt).toContain("Bối cảnh dự án:");

    // 4. MCP Agent kết nối và kiểm tra readOnlyHint
    const client = await mcpClient(runToken);
    const tools = await client.listTools();
    const replyTool = tools.tools.find((t) => t.name === "leader_reply");
    const proposeTool = tools.tools.find((t) => t.name === "leader_propose");
    expect(replyTool?.annotations?.readOnlyHint).toBe(true);
    expect(proposeTool?.annotations?.readOnlyHint).toBe(true);

    // 5. Agent gọi leader_reply
    const replyRes = await client.callTool({
      name: "leader_reply",
      arguments: {
        threadId: thread.id,
        content: "Tôi đề xuất chúng ta tạo một task mới cho việc xuất PDF.",
      },
    });
    expect((replyRes as { isError?: boolean }).isError).toBeFalsy();

    // 6. Agent gọi leader_propose để đề xuất tạo task
    const proposeRes = await client.callTool({
      name: "leader_propose",
      arguments: {
        threadId: thread.id,
        action: {
          type: "task.create",
          projectId: projectIdA,
          title: "Xuất báo cáo PDF",
          body: "Hỗ trợ xuất báo cáo định dạng PDF từ bảng dữ liệu",
        },
        rationale: "Đề xuất tạo task để theo dõi công việc xuất PDF.",
      },
    });
    expect((proposeRes as { isError?: boolean }).isError).toBeFalsy();

    // 7. Worker báo run kết thúc thành công
    await worker.finish(runId, 0);
    await until(async () => {
      const { rows } = await admin.query("select state from hive.runs where id = $1", [runId]);
      return rows[0]?.state === "succeeded";
    });

    // 8. Đọc lịch sử thread: thấy tin nhắn trả lời và rationale từ leader
    const histRes = await api<{ thread: ChatThread; messages: ChatMessage[] }>(
      "GET",
      `/v1/leader/threads/${thread.id}`,
    );
    expect(histRes.status).toBe(200);
    const msgs = histRes.data.messages;
    expect(msgs.some((m) => m.role === "leader" && m.content.includes("Tôi đề xuất chúng ta tạo một task mới"))).toBe(
      true,
    );
    expect(msgs.some((m) => m.role === "leader" && m.content.includes("Đề xuất tạo task để theo dõi"))).toBe(true);

    // 9. Lấy danh sách approvals: thấy đề xuất đang chờ
    const appListRes = await api<Approval[]>("GET", "/v1/leader/approvals?status=pending");
    expect(appListRes.status).toBe(200);
    const approval = appListRes.data.find((a) => a.threadId === thread.id);
    expect(approval).toBeDefined();
    if (!approval) throw new Error("Không tìm thấy approval");
    expect(approval.status).toBe("pending");
    expect(approval.action.type).toBe("task.create");

    // 10. Duyệt đề xuất (approvals.approve)
    const approveRes = await api<{ approval: Approval; result: { task?: { id: string; title: string } } }>(
      "POST",
      `/v1/leader/approvals/${approval.id}/approve`,
    );
    expect(approveRes.status).toBe(200);
    expect(approveRes.data.approval.status).toBe("approved");
    expect(approveRes.data.result?.task?.title).toBe("Xuất báo cáo PDF");

    // 11. Kiểm tra tin nhắn hệ thống báo kết quả trong thread
    const updatedHist = await api<{ thread: ChatThread; messages: ChatMessage[] }>(
      "GET",
      `/v1/leader/threads/${thread.id}`,
    );
    expect(updatedHist.status).toBe(200);
    expect(
      updatedHist.data.messages.some((m) => m.role === "system" && m.content === "Đề xuất đã được duyệt và thực hiện."),
    ).toBe(true);

    // 12. Kiểm tra audit log
    const audit = (
      await admin.query("select * from hive.audit_log where action = 'leader.approval.approve' and target_id = $1", [
        approval.id,
      ])
    ).rows;
    expect(audit).toHaveLength(1);
  });

  it("từ chối đề xuất: ghi trạng thái rejected, lý do và tin hệ thống vào thread", async () => {
    const worker = await FakeWorker.connect(await seedMachine(`ldr-2-${tag}`));

    // Tạo thread và gửi tin
    const threadRes = await api<ChatThread>("POST", "/v1/leader/threads", {
      projectId: projectIdA,
      title: "Thảo luận tối ưu hoá",
    });
    const thread = threadRes.data;

    const sendRes = await api<{ message: ChatMessage; runId: string }>(
      "POST",
      `/v1/leader/threads/${thread.id}/messages`,
      { content: "Có nên refactor module auth không?", cli: "claude" },
    );
    const runId = sendRes.data.runId;
    const { runToken } = await worker.take(runId);

    const client = await mcpClient(runToken);
    await client.callTool({
      name: "leader_reply",
      arguments: { threadId: thread.id, content: "Tôi đề xuất tạo task refactor." },
    });
    await client.callTool({
      name: "leader_propose",
      arguments: {
        threadId: thread.id,
        action: {
          type: "task.create",
          projectId: projectIdA,
          title: "Refactor auth module",
          body: "Tách nhỏ các hàm xử lý",
        },
        rationale: "Cần refactor module auth để dễ bảo trì.",
      },
    });
    await worker.finish(runId, 0);
    await until(async () => {
      const { rows } = await admin.query("select state from hive.runs where id = $1", [runId]);
      return rows[0]?.state === "succeeded";
    });

    const appListRes = await api<Approval[]>("GET", "/v1/leader/approvals?status=pending");
    const approval = appListRes.data.find((a) => a.threadId === thread.id);
    expect(approval).toBeDefined();
    if (!approval) throw new Error("Không tìm thấy approval");

    // Từ chối đề xuất
    const rejectRes = await api<Approval>("POST", `/v1/leader/approvals/${approval.id}/reject`, {
      reason: "Chưa đúng thời điểm",
    });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.data.status).toBe("rejected");
    expect(rejectRes.data.reason).toBe("Chưa đúng thời điểm");

    // Kiểm tra tin hệ thống
    const hist = await api<{ thread: ChatThread; messages: ChatMessage[] }>("GET", `/v1/leader/threads/${thread.id}`);
    expect(
      hist.data.messages.some(
        (m) => m.role === "system" && m.content.includes("Đề xuất bị từ chối: Chưa đúng thời điểm"),
      ),
    ).toBe(true);
  });

  it("xếp hàng tin nhắn: khi run đang chạy, tin gửi đến không tạo run mới và tự chạy tiếp sau khi run cũ xong", async () => {
    const worker = await FakeWorker.connect(await seedMachine(`ldr-3-${tag}`));

    const threadRes = await api<ChatThread>("POST", "/v1/leader/threads", {
      projectId: projectIdA,
      title: "Luồng xếp hàng",
    });
    const thread = threadRes.data;

    // Gửi tin 1 -> run 1 khởi chạy
    const send1 = await api<{ message: ChatMessage; runId: string }>(
      "POST",
      `/v1/leader/threads/${thread.id}/messages`,
      { content: "Tin nhắn lượt 1", cli: "claude" },
    );
    const run1Id = send1.data.runId;

    // Worker nhận run 1
    const { runToken: token1 } = await worker.take(run1Id);

    // Khi run 1 đang chạy, gửi tiếp tin 2
    const send2 = await api<{ message: ChatMessage; runId: string }>(
      "POST",
      `/v1/leader/threads/${thread.id}/messages`,
      { content: "Tin nhắn lượt 2 gửi chen ngang", cli: "claude" },
    );
    // Trả về cùng run1Id vì run 1 đang active
    expect(send2.data.runId).toBe(run1Id);
    expect(send2.data.message.content).toBe("Tin nhắn lượt 2 gửi chen ngang");

    // Agent trả lời cho run 1 và finish run 1
    const client1 = await mcpClient(token1);
    await client1.callTool({
      name: "leader_reply",
      arguments: { threadId: thread.id, content: "Trả lời cho tin 1" },
    });
    await worker.finish(run1Id, 0);
    await until(async () => {
      const { rows } = await admin.query("select state from hive.runs where id = $1", [run1Id]);
      return rows[0]?.state === "succeeded";
    });

    // Hub phải tự động khởi chạy run 2 cho tin nhắn 2 đã xếp hàng!
    const offer2 = await worker.next("job_offer", (o) => o.runId !== run1Id);
    expect(offer2.spec.prompt).toContain("Tin nhắn lượt 2 gửi chen ngang");

    // Worker xử lý run 2
    worker.send({ type: "job_accept", runId: offer2.runId, attempt: offer2.attempt });
    const lease2 = await worker.next("lease", (l) => l.runId === offer2.runId);
    const client2 = await mcpClient(lease2.runToken);
    await client2.callTool({
      name: "leader_reply",
      arguments: { threadId: thread.id, content: "Trả lời cho tin 2" },
    });
    await worker.finish(offer2.runId, 0);
    await until(async () => {
      const { rows } = await admin.query("select state from hive.runs where id = $1", [offer2.runId]);
      return rows[0]?.state === "succeeded";
    });

    // Cả hai câu trả lời đều có trong thread
    const hist = await api<{ thread: ChatThread; messages: ChatMessage[] }>("GET", `/v1/leader/threads/${thread.id}`);
    expect(hist.data.messages.some((m) => m.content === "Trả lời cho tin 1")).toBe(true);
    expect(hist.data.messages.some((m) => m.content === "Trả lời cho tin 2")).toBe(true);
  });

  it("run leader lỗi hoặc không gọi leader_reply: ghi tin hệ thống tiếng Việt, không treo thread", async () => {
    const worker = await FakeWorker.connect(await seedMachine(`ldr-4-${tag}`));

    const threadRes = await api<ChatThread>("POST", "/v1/leader/threads", {
      projectId: projectIdA,
      title: "Kiểm tra lỗi",
    });
    const thread = threadRes.data;

    // Gửi tin nhắn
    const send = await api<{ message: ChatMessage; runId: string }>(
      "POST",
      `/v1/leader/threads/${thread.id}/messages`,
      { content: "Tin nhắn dẫn đến run lỗi", cli: "claude" },
    );
    const runId = send.data.runId;
    await worker.take(runId);

    // Worker thoát với mã lỗi 1 và không gọi leader_reply
    await worker.finish(runId, 1);
    await until(async () => {
      const { rows } = await admin.query("select state from hive.runs where id = $1", [runId]);
      return rows[0]?.state === "failed";
    });

    // Kiểm tra tin hệ thống ghi vào thread
    const hist = await api<{ thread: ChatThread; messages: ChatMessage[] }>("GET", `/v1/leader/threads/${thread.id}`);
    expect(
      hist.data.messages.some(
        (m) => m.role === "system" && m.content.includes("Leader run gặp lỗi hoặc hết thời gian"),
      ),
    ).toBe(true);

    // Thread không treo: gửi tiếp tin nhắn mới tạo run mới thành công
    const retrySend = await api<{ message: ChatMessage; runId: string }>(
      "POST",
      `/v1/leader/threads/${thread.id}/messages`,
      { content: "Thử lại sau lỗi", cli: "claude" },
    );
    expect(retrySend.status).toBe(200);
    expect(retrySend.data.runId).not.toBe(runId);

    // Xử lý run thử lại
    const retryLease = await worker.take(retrySend.data.runId);
    const retryClient = await mcpClient(retryLease.runToken);
    await retryClient.callTool({
      name: "leader_reply",
      arguments: { threadId: thread.id, content: "Chào bạn, lần này tôi trả lời được rồi." },
    });
    await worker.finish(retrySend.data.runId, 0);
    await until(async () => {
      const { rows } = await admin.query("select state from hive.runs where id = $1", [retrySend.data.runId]);
      return rows[0]?.state === "succeeded";
    });

    // Trường hợp 2: exit 0 nhưng KHÔNG gọi leader_reply
    const sendNoReply = await api<{ message: ChatMessage; runId: string }>(
      "POST",
      `/v1/leader/threads/${thread.id}/messages`,
      { content: "Quên gọi leader_reply", cli: "claude" },
    );
    const runNoReplyId = sendNoReply.data.runId;
    await worker.take(runNoReplyId);
    await worker.finish(runNoReplyId, 0);
    await until(async () => {
      const { rows } = await admin.query("select state from hive.runs where id = $1", [runNoReplyId]);
      return rows[0]?.state === "failed";
    });

    const histNoReply = await api<{ thread: ChatThread; messages: ChatMessage[] }>(
      "GET",
      `/v1/leader/threads/${thread.id}`,
    );
    expect(
      histNoReply.data.messages.some(
        (m) => m.role === "system" && m.content.includes("Leader chưa gửi câu trả lời vào cuộc trò chuyện"),
      ),
    ).toBe(true);
  });

  it("chọn Antigravity cho leader bị từ chối và không lưu tin: agy không gọi được leader_reply khi chạy chỉ đọc", async () => {
    const thread = (
      await api<ChatThread>("POST", "/v1/leader/threads", { projectId: projectIdA, title: "Antigravity" })
    ).data;
    const res = await api<{ data?: { code: string } }>("POST", `/v1/leader/threads/${thread.id}/messages`, {
      content: "Chào",
      cli: "antigravity",
    });
    expect(res.status).toBe(400);
    expect(res.data.data?.code).toBe("CLI_CANNOT_SUBMIT");
    const hist = await api<{ messages: ChatMessage[] }>("GET", `/v1/leader/threads/${thread.id}`);
    expect(hist.data.messages).toHaveLength(0);
  });

  it("phân quyền và RLS: người dùng orgB không xem hay gửi tin vào thread của orgA", async () => {
    const threadRes = await api<ChatThread>("POST", "/v1/leader/threads", {
      projectId: projectIdA,
      title: "Thread bảo mật orgA",
    });
    const thread = threadRes.data;

    // Người dùng thuộc OrgB gọi vào thread của OrgA
    const resB = await fetchApp(
      new Request(`${baseURL}/api/v1/leader/threads/${thread.id}`, {
        method: "GET",
        headers: {
          cookie: cookieOrgB,
          "x-hive-org": orgB.orgId,
        },
      }),
    );
    expect([403, 404]).toContain(resB.status);

    // Không gửi được tin nhắn
    const sendB = await fetchApp(
      new Request(`${baseURL}/api/v1/leader/threads/${thread.id}/messages`, {
        method: "POST",
        headers: {
          cookie: cookieOrgB,
          "x-hive-org": orgB.orgId,
          "content-type": "application/json",
        },
        body: JSON.stringify({ content: "Tin nhắn trái phép" }),
      }),
    );
    expect([403, 404]).toContain(sendB.status);
  });
});

describe("Thẻ artifact trong chat", () => {
  /** Mở cuộc trò chuyện, gửi tin, worker nhận run: trả thread, run, mã run token và prompt giao cho worker. */
  async function startRun(title: string) {
    const worker = await FakeWorker.connect(await seedMachine(`ldr-art-${randomUUID().slice(0, 6)}`));
    const thread = (await api<ChatThread>("POST", "/v1/leader/threads", { projectId: projectIdA, title })).data;
    const sent = await api<{ runId: string }>("POST", `/v1/leader/threads/${thread.id}/messages`, {
      content: "Vẽ giúp tôi sơ đồ luồng đăng nhập",
      cli: "claude",
    });
    const { spec, runToken } = await worker.take(sent.data.runId);
    return { worker, thread, runId: sent.data.runId, runToken, prompt: (spec as { prompt: string }).prompt };
  }
  const history = async (threadId: string) =>
    (await api<{ messages: ChatMessage[] }>("GET", `/v1/leader/threads/${threadId}`)).data.messages;
  const text = (res: unknown) => (res as { content: { text: string }[] }).content.map((c) => c.text).join("\n");

  it("run leader tạo rồi sửa artifact: thẻ đúng thứ tự, artifact trong threads.get, liên kết chat_thread, prompt có hướng dẫn", async () => {
    const { worker, thread, runId, runToken, prompt } = await startRun("Sơ đồ đăng nhập");
    expect(prompt).toContain("artifact_create");
    expect(prompt).toContain("artifact_update");
    const client = await mcpClient(runToken);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["leader_reply", "artifact_create", "artifact_update", "artifact_get", "artifact_list"]),
    );
    const before = (await admin.query("select updated_at from hive.chat_threads where id = $1", [thread.id])).rows[0]
      .updated_at as Date;

    const created = await client.callTool({
      name: "artifact_create",
      arguments: { type: "mermaid", title: "Luồng đăng nhập", content: "graph TD; A-->B", threadId: thread.id },
    });
    expect((created as { isError?: boolean }).isError).toBeFalsy();
    const artifactId = (JSON.parse(text(created)) as { id: string }).id;
    await client.callTool({ name: "leader_reply", arguments: { threadId: thread.id, content: "Đã vẽ xong." } });
    const updated = await client.callTool({
      name: "artifact_update",
      arguments: { id: artifactId, content: "graph TD; A-->B-->C", baseVersion: 1, threadId: thread.id },
    });
    expect((updated as { isError?: boolean }).isError).toBeFalsy();

    const messages = await history(thread.id);
    expect(messages.map((m) => [m.role, m.content, m.artifact?.version ?? null])).toEqual([
      ["user", "Vẽ giúp tôi sơ đồ luồng đăng nhập", null],
      ["leader", "Luồng đăng nhập", 1],
      ["leader", "Đã vẽ xong.", null],
      ["leader", "Luồng đăng nhập", 2],
    ]);
    expect(messages[1]?.artifact).toEqual({
      id: artifactId,
      version: 1,
      title: "Luồng đăng nhập",
      type: "mermaid",
      deleted: false,
    });
    expect(messages[1]?.runId).toBe(runId);
    const after = (await admin.query("select updated_at from hive.chat_threads where id = $1", [thread.id])).rows[0]
      .updated_at as Date;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
    const links = (
      await admin.query("select target_kind, target_id from hive.artifact_links where artifact_id = $1", [artifactId])
    ).rows;
    expect(links).toContainEqual({ target_kind: "chat_thread", target_id: thread.id });

    // Tin nhắn kế tiếp: lịch sử đưa cho Leader nêu id artifact để sửa đúng bản.
    await worker.finish(runId, 0);
    await until(async () => {
      const { rows } = await admin.query("select state from hive.runs where id = $1", [runId]);
      return rows[0]?.state === "succeeded";
    });
    const next = await api<{ runId: string }>("POST", `/v1/leader/threads/${thread.id}/messages`, {
      content: "Thêm bước C nữa",
      cli: "claude",
    });
    const offer = await worker.take(next.data.runId);
    expect((offer.spec as { prompt: string }).prompt).toContain(`[artifact ${artifactId}, phiên bản 2]`);
  });

  it("threadId của run khác bị từ chối ARTIFACT_LINK_FORBIDDEN: không tạo artifact, không thêm thẻ", async () => {
    const { thread, runToken } = await startRun("Thread của run");
    const other = (await api<ChatThread>("POST", "/v1/leader/threads", { projectId: projectIdA, title: "Thread khác" }))
      .data;
    const client = await mcpClient(runToken);
    const denied = await client.callTool({
      name: "artifact_create",
      arguments: { type: "markdown", title: "Lạc thread", content: "x", threadId: other.id },
    });
    expect((denied as { isError?: boolean }).isError).toBe(true);
    // Cổng MCP trả chữ của lỗi, không trả mã: đây là chữ của ARTIFACT_LINK_FORBIDDEN.
    expect(text(denied)).toBe("Không gắn được artifact vào đây.");
    expect(await history(other.id)).toHaveLength(0);
    expect((await history(thread.id)).filter((m) => m.artifact)).toHaveLength(0);
    const { rows } = await admin.query("select 1 from hive.artifacts where org_id = $1 and title = 'Lạc thread'", [
      orgA.orgId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("artifact vào thùng rác: thẻ báo đã xoá; xoá hẳn: thẻ còn, artifact null và tin nhắn còn nguyên tổ chức", async () => {
    const { thread, runToken } = await startRun("Xoá artifact");
    const client = await mcpClient(runToken);
    const created = await client.callTool({
      name: "artifact_create",
      arguments: { type: "markdown", title: "Ghi chú tạm", content: "# tạm", threadId: thread.id },
    });
    const artifactId = (JSON.parse(text(created)) as { id: string }).id;

    await admin.query("update hive.artifacts set deleted_at = now() where id = $1", [artifactId]);
    let card = (await history(thread.id)).find((m) => m.artifact);
    expect(card?.artifact).toMatchObject({ id: artifactId, title: "Ghi chú tạm", deleted: true });

    await admin.query("delete from hive.artifacts where id = $1", [artifactId]);
    card = (await history(thread.id)).find((m) => m.content === "Ghi chú tạm");
    expect(card).toBeDefined();
    expect(card?.artifact).toBeNull();
    const { rows } = await admin.query(
      "select org_id, artifact_id, artifact_version from hive.chat_messages where id = $1",
      [card?.id],
    );
    expect(rows[0]).toEqual({ org_id: orgA.orgId, artifact_id: null, artifact_version: 1 });
  });

  it("xoá cuộc trò chuyện: job dọn xoá liên kết chat_thread còn lại", async () => {
    const { thread, runToken } = await startRun("Xoá cuộc trò chuyện");
    const client = await mcpClient(runToken);
    const created = await client.callTool({
      name: "artifact_create",
      arguments: { type: "markdown", title: "Theo cuộc trò chuyện", content: "x", threadId: thread.id },
    });
    const artifactId = (JSON.parse(text(created)) as { id: string }).id;
    const linked = () =>
      admin.query("select 1 from hive.artifact_links where artifact_id = $1 and target_kind = 'chat_thread'", [
        artifactId,
      ]);
    expect((await linked()).rowCount).toBe(1);
    await admin.query("delete from hive.chat_threads where id = $1", [thread.id]);
    await purgeArtifacts(pool);
    expect((await linked()).rowCount).toBe(0);
    // Artifact không mất theo cuộc trò chuyện: chỉ liên kết.
    expect((await admin.query("select 1 from hive.artifacts where id = $1", [artifactId])).rowCount).toBe(1);
  });
});
