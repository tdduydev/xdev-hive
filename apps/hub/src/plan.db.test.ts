// Plan mode (M7): dự án bật planMode thì run code chờ ở planning, run plan con chỉ đọc nộp kế hoạch qua MCP
// `plan_submit`, người duyệt rồi run code mới chạy với kế hoạch trong prompt. Hub thật trên cổng ngẫu nhiên (aud của run
// token phải khớp baseURL), client `ws` đóng vai worker, client MCP đóng vai agent, người dùng đăng nhập thật để gọi API.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  defaultProjectSettings,
  type Plan,
  type PlanDecision,
  type PlanHistory,
  type Run,
  type Task,
} from "@xdev-hive/contracts";
import { type HubToWorker, hubToWorker, PROTOCOL_VERSION } from "@xdev-hive/contracts/worker-protocol";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, onTestFinished } from "vitest";
import WebSocket from "ws";
import { errorCode, type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import { seedProject } from "../test/project-fixture.ts";
import { createApp } from "./app.ts";
import { loadProject } from "./modules/catalog/index.ts";
import { attachWorkerGateway, registerRunHandlers } from "./modules/fleet/index.ts";
import { createAuth } from "./modules/identity/index.ts";
import { appendLeaderSystemMessage, queuedLeaderPrompt } from "./modules/leader/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "./modules/platform/index.ts";
import { createRunsEngine, type RunsEngine } from "./modules/runs/index.ts";
import { createMemoryProvider, type MemoryProvider } from "./modules/scm/index.ts";
import { getPlan, listPlans, loadTask } from "./modules/tasks/index.ts";

const { adminUrl, appUrl, authUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const authPool = createPool(authUrl);
// Cùng secret với các file test khác: JWKS của Better Auth nằm chung database và được mã hoá bằng secret này.
const secret = "test-secret-0123456789abcdef-0123456789";
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const sha = "e".repeat(40);

let org: OrgFixture & { user: (n: string) => string };
let projectId = "";
let provider: MemoryProvider;
let engine: RunsEngine;
let server: Server;
let gateway: { close: () => Promise<void> };
let unregister: () => void;
let baseURL = "";
let fetchApp: (req: Request) => Response | Promise<Response> = () => new Response(null, { status: 503 });
let cookie = "";
let devUserId = "";
const devEmail = `dev-plan-${tag}@example.com`;
let taskNo = 0;
const clients: Client[] = [];

beforeAll(async () => {
  server = serve({ fetch: (req) => fetchApp(req), port: 0, hostname: "127.0.0.1" }) as Server;
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  org = await seedOrg(admin, `plan-${tag}`);
  const project = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: `pm${tag}`,
  });
  projectId = project.projectId;
  provider = createMemoryProvider("gitlab", ["xdev-team"]);
  provider.seedRepo({ owner: project.owner, name: project.repo });
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
  const app = createApp({
    config: { port: 0, version: "test", publicUrl: baseURL },
    auth,
    pool,
    runs: engine,
    providerFactory,
  });
  fetchApp = (req) => app.fetch(req);
  gateway = attachWorkerGateway(server, { pool, heartbeatSec: 5, logger: quiet });

  // Người giao việc là người dùng thật (phiên Better Auth), thành viên đội sở hữu dự án.
  const res = await fetch(`${baseURL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Dev", email: devEmail, password: "mat-khau-du-dai-123" }),
  });
  expect(res.status).toBe(200);
  cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  devUserId = ((await res.json()) as { user: { id: string } }).user.id;
  await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [
    org.orgId,
    devUserId,
  ]);
  await admin.query("insert into hive.team_members (team_id, org_id, user_id, role) values ($1, $2, $3, 'member')", [
    org.teamId,
    org.orgId,
    devUserId,
  ]);
  // Kênh của nhóm quản trị nhận cả kế hoạch chờ duyệt lẫn run thất bại; config không được giải mã lúc ghi thông báo.
  await admin.query(
    `insert into hive.notification_channels (org_id, kind, name, events, target, config_enc, created_by)
     values ($1, 'telegram', 'quan-tri', $2, '@nhom', 'x', $3)`,
    [org.orgId, ["plan.awaiting_approval", "run.failed"], org.user("admin")],
  );
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  unregister();
  engine.stop();
  await gateway.close();
  await new Promise((resolve) => server.close(resolve));
  await Promise.all([admin.end(), pool.end(), authPool.end()]);
});

// ---- Công cụ ------------------------------------------------------------------------------------------------

async function setPlanMode(on: boolean) {
  const s = defaultProjectSettings();
  s.features.planMode = on;
  await admin.query("update hive.projects set settings = $1 where id = $2", [JSON.stringify(s), projectId]);
}

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${baseURL}/api${path}`, {
    method,
    headers: { "content-type": "application/json", cookie, "x-hive-org": org.orgId },
    body: body === undefined ? null : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as T };
}
type ApiError = { data?: { code?: string } };

/** Người giao việc (dev) tạo task và giao run qua API. */
async function assign(): Promise<{ task: Task; run: Run }> {
  taskNo++;
  const created = await api<Task>("POST", "/v1/tasks", { projectId, title: `Thêm báo cáo ${taskNo}`, body: "Mô tả" });
  expect(created.status).toBe(200);
  const started = await api<Run>("POST", "/v1/runs", { taskId: created.data.id, cli: "claude" });
  expect(started.status).toBe(200);
  return { task: created.data, run: started.data };
}

const runRow = async (id: string) => (await admin.query("select * from hive.runs where id = $1", [id])).rows[0];
const planChildren = async (parentId: string) =>
  (
    await admin.query("select * from hive.runs where parent_run_id = $1 and kind = 'plan' order by created_at", [
      parentId,
    ])
  ).rows;
const taskStatus = async (id: string) =>
  (await admin.query("select status from hive.tasks where id = $1", [id])).rows[0].status as string;
const plansOf = async (taskId: string) =>
  (await admin.query("select * from hive.plans where task_id = $1 order by revision", [taskId])).rows;
const auditOf = async (action: string, targetId: string) =>
  (await admin.query("select * from hive.audit_log where action = $1 and target_id = $2", [action, targetId])).rows;

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
    "insert into hive.machines (org_id, team_id, name, os, version, clis, capacity, shared) values ($1, $2, $3, 'linux', '1', $4, 1, true) returning id",
    [org.orgId, org.teamId, name, clis],
  );
  await admin.query(
    "insert into hive.machine_tokens (org_id, team_id, machine_id, token_hash) values ($1, $2, $3, $4)",
    [org.orgId, org.teamId, rows[0].id, createHash("sha256").update(token).digest("hex")],
  );
  return { name, token, clis };
}

type Msg<T extends HubToWorker["type"]> = Extract<HubToWorker, { type: T }>;
const openWorkers = new Set<FakeWorker>();
afterEach(async () => {
  await Promise.all([...openWorkers].map((w) => w.close()));
  // Run còn dở của kịch bản trước (vd. run plan con chưa ai nhận) sẽ được đề nghị cho máy của kịch bản sau trước run
  // đang thử; máy chỉ có một slot nên run đang thử không bao giờ nhận được job_offer. Huỷ hết để các kịch bản độc lập.
  await admin.query(
    `update hive.runs set state = 'cancelled', offer_machine_id = null, offer_expires_at = null, finished_at = now()
     where org_id = $1 and state not in ('succeeded', 'no_changes', 'needs_review', 'failed', 'cancelled')`,
    [org.orgId],
  );
});

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
      capacity: 1,
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

  /** Nhận đề nghị job của run, nhận lease; trả spec và run token. */
  async take(runId: string) {
    const offer = await this.next("job_offer", (o) => o.runId === runId);
    this.send({ type: "job_accept", runId, attempt: offer.attempt });
    const lease = await this.next("lease", (l) => l.runId === runId);
    return { spec: offer.spec, runToken: lease.runToken };
  }

  async finish(runId: string, exit: number, report: Record<string, unknown>, headSha: string | null = sha) {
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

async function mcp(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "agent-plan", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const submitPlan = (client: Client, args: Record<string, unknown>) =>
  client.callTool({ name: "plan_submit", arguments: args }).then((result) => {
    const r = result as { content: { type: string; text: string }[]; isError?: boolean };
    return { isError: r.isError ?? false, text: r.content.map((c) => c.text).join("\n") };
  });

const planV1 = { summary: "Bản nháp", steps: [{ title: "Đọc code" }] };
const planV2 = {
  summary: "Thêm báo cáo doanh thu theo tháng.",
  steps: [
    { title: "Thêm truy vấn tổng hợp", detail: "Gom theo tháng trong report.ts." },
    { title: "Viết test cho truy vấn" },
  ],
  files: [{ path: "src/report.ts", change: "modify", reason: "Thêm hàm tổng hợp." }],
  risks: ["Dữ liệu lớn làm truy vấn chậm."],
  questions: ["Có cần lọc theo chi nhánh không?"],
};

describe("leader run", () => {
  it("gửi tin, trả lời chỉ đọc, đề xuất rồi thực hiện hành động sau khi duyệt", async () => {
    const machine = await seedMachine(`leader-${tag}`);
    const worker = await FakeWorker.connect(machine);
    const created = await api<{ id: string }>("POST", "/v1/leader/threads", { projectId, title: "Hỗ trợ dự án" });
    expect(created.status).toBe(200);
    const threadId = created.data.id;
    const sent = await api<{ message: { id: string }; runId: string }>(
      "POST",
      `/v1/leader/threads/${threadId}/messages`,
      {
        content: "Tạo task để thêm báo cáo doanh thu.",
        cli: "claude",
      },
    );
    expect(sent.status).toBe(200);
    expect(sent.data.runId).toBeTruthy();
    const { spec, runToken } = await worker.take(sent.data.runId);
    expect(spec).toMatchObject({ kind: "leader", taskId: null, projectId });
    expect(spec.prompt).toContain("Tạo task để thêm báo cáo doanh thu.");
    expect(spec.prompt).toContain("leader_propose");

    const agent = await mcp(runToken);
    const tools = (await agent.listTools()).tools;
    for (const name of ["leader_reply", "leader_propose"])
      expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
    expect(
      (await agent.callTool({ name: "leader_reply", arguments: { threadId, content: "Tôi đề xuất tạo task." } }))
        .isError,
    ).not.toBe(true);
    expect(
      (
        await agent.callTool({
          name: "leader_propose",
          arguments: {
            threadId,
            action: {
              type: "task.create",
              projectId,
              title: "Thêm báo cáo doanh thu",
              body: "Tạo báo cáo theo tháng.",
            },
            rationale: "Tách yêu cầu thành một task để đội triển khai.",
          },
        })
      ).isError,
    ).not.toBe(true);
    await worker.finish(sent.data.runId, 0, { status: "succeeded" });
    await until(async () => (await runRow(sent.data.runId)).state === "succeeded");

    const { rows } = await admin.query("select id from hive.approvals where thread_id = $1", [threadId]);
    expect(rows).toHaveLength(1);
    const approved = await api<{ approval: { status: string }; result: unknown }>(
      "POST",
      `/v1/leader/approvals/${rows[0].id}/approve`,
      {},
    );
    expect(approved.status).toBe(200);
    expect(approved.data.approval.status).toBe("approved");
    const { rows: taskRows } = await admin.query("select id from hive.tasks where project_id = $1 and title = $2", [
      projectId,
      "Thêm báo cáo doanh thu",
    ]);
    expect(taskRows).toHaveLength(1);
    const { rows: messages } = await admin.query("select role, content from hive.chat_messages where thread_id = $1", [
      threadId,
    ]);
    expect(messages.map((message) => message.role)).toContain("leader");
    expect(messages.some((message) => message.role === "system" && message.content.includes("được duyệt"))).toBe(true);
  });
});

/** Giao task, máy nhận run plan, agent nộp kế hoạch rồi thoát: run code chờ duyệt. */
async function planned(w: FakeWorker, plan: Record<string, unknown> = planV2) {
  const { task, run } = await assign();
  expect(run.state).toBe("planning");
  const [child] = await planChildren(run.id);
  const taken = await w.take(child.id);
  expect((await submitPlan(await mcp(taken.runToken), plan)).isError).toBe(false);
  await w.finish(child.id, 0, { status: "succeeded" });
  await until(async () => (await runRow(run.id)).state === "awaiting_plan");
  const [row] = (await plansOf(task.id)).slice(-1);
  return { task, run, childId: child.id as string, planId: row.id as string, spec: taken.spec };
}

// ---- Kịch bản -----------------------------------------------------------------------------------------------

describe("plan mode", () => {
  it("tắt planMode: run code giao thẳng, không có run plan", async () => {
    await setPlanMode(false);
    const w = await FakeWorker.connect(await seedMachine(`off-${tag}`));
    const { task, run } = await assign();
    expect(run.state).toBe("queued");
    const { spec } = await w.take(run.id);
    expect(spec.kind).toBe("code");
    expect(await planChildren(run.id)).toHaveLength(0);
    expect(await taskStatus(task.id)).toBe("running");
    // Kết thúc run để lease hết hạn không đưa nó về hàng đợi của máy ở test sau.
    await w.finish(run.id, 0, { commitCount: 0, changedFiles: [] }, null);
    await until(async () => (await runRow(run.id)).state === "no_changes");
  });

  it("run code của Antigravity: run plan con để dispatch chọn Claude/Codex (agy không gọi được plan_submit)", async () => {
    await setPlanMode(true);
    // Run code của Antigravity chỉ được giao khi dự án cho toàn quyền (agy không giới hạn được trong worktree).
    await admin.query(
      `update hive.projects set settings = settings || '{"runPermissions":{"mode":"full"}}'::jsonb where id = $1`,
      [projectId],
    );
    onTestFinished(async () => {
      await admin.query("update hive.projects set settings = settings - 'runPermissions' where id = $1", [projectId]);
    });
    taskNo++;
    const created = await api<Task>("POST", "/v1/tasks", { projectId, title: `Antigravity lập kế hoạch ${taskNo}` });
    const started = await api<Run>("POST", "/v1/runs", {
      taskId: created.data.id,
      cli: "antigravity",
      model: "gemini-3.8-flash-high",
    });
    expect(started.status).toBe(200);
    expect(started.data).toMatchObject({ state: "planning", cli: "antigravity" });
    const [child] = await planChildren(started.data.id);
    expect(child).toMatchObject({ kind: "plan", cli: null, model: null });
    const w = await FakeWorker.connect(await seedMachine(`agy-plan-${tag}`));
    const { spec } = await w.take(child.id);
    expect(spec).toMatchObject({ kind: "plan", cli: "claude" });
    await api("POST", `/v1/tasks/${created.data.id}/cancel`);
    await w.close();
  });

  it("bật planMode: run plan chỉ đọc → nộp kế hoạch → chờ duyệt → duyệt kèm sửa → run code có kế hoạch trong prompt", async () => {
    await setPlanMode(true);
    const w = await FakeWorker.connect(await seedMachine(`ok-${tag}`));
    const { task, run } = await assign();
    expect(run.state).toBe("planning");
    expect(await taskStatus(task.id)).toBe("queued");
    const [child] = await planChildren(run.id);
    expect(child).toMatchObject({ kind: "plan", task_id: task.id, cli: "claude", branch: run.branch, state: "queued" });

    const { spec, runToken } = await w.take(child.id);
    expect(spec).toMatchObject({ kind: "plan", cli: "claude", branch: run.branch, baseBranch: "main" });
    expect(String(spec.prompt)).toContain("plan_submit");
    expect(String(spec.prompt)).toContain("Không sửa file, không commit, không push");
    expect(await taskStatus(task.id)).toBe("running");

    // Run plan thấy plan_submit, đánh dấu chỉ đọc để Claude Code ở chế độ plan cho gọi; không thấy review_submit.
    const agent = await mcp(runToken);
    const tools = (await agent.listTools()).tools;
    expect(tools.find((t) => t.name === "plan_submit")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.map((t) => t.name)).not.toContain("review_submit");
    // Gọi lại thì lần sau cùng được tính.
    expect((await submitPlan(agent, planV1)).isError).toBe(false);
    expect((await submitPlan(agent, planV2)).isError).toBe(false);
    await w.finish(child.id, 0, { status: "succeeded" });

    await until(async () => (await runRow(run.id)).state === "awaiting_plan");
    expect((await runRow(child.id)).state).toBe("succeeded");
    expect(await taskStatus(task.id)).toBe("awaiting_plan");
    const [stored] = await plansOf(task.id);
    expect(stored).toMatchObject({
      status: "awaiting",
      revision: 1,
      run_id: run.id,
      plan_run_id: child.id,
      org_id: org.orgId,
      team_id: org.teamId,
    });
    expect(stored.content.summary).toBe(planV2.summary);
    expect(await auditOf("plan.submit", stored.id)).toHaveLength(1);

    // Người giao việc được báo qua kênh của nhóm quản trị.
    const { rows: sent } = await admin.query(
      "select * from hive.notifications where org_id = $1 and event = 'plan.awaiting_approval' and title like $2",
      [org.orgId, `%${task.key}%`],
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain(`Người giao việc: Dev <${devEmail}>`);
    expect(sent[0].body).toContain("1. Thêm truy vấn tổng hợp");
    expect(sent[0].link).toBe(`${baseURL}/tasks/${task.key}`);

    const got = await api<Plan>("GET", `/v1/tasks/${task.id}/plan`);
    expect(got.status).toBe(200);
    expect(got.data).toMatchObject({ id: stored.id, status: "awaiting", content: { questions: planV2.questions } });
    // Đang chờ duyệt thì không đổi tay trạng thái task được.
    const manual = await api<ApiError>("PATCH", `/v1/tasks/${task.id}`, { status: "done" });
    expect(manual.status).toBe(409);
    expect(manual.data.data?.code).toBe("TASK_RUN_ACTIVE");

    const edited = { ...planV2, steps: [...planV2.steps, { title: "Cập nhật tài liệu báo cáo" }] };
    const approved = await api<PlanDecision>("POST", `/v1/tasks/${task.id}/plan/approve`, {
      planId: stored.id,
      note: "Không cần lọc theo chi nhánh.",
      content: edited,
    });
    expect(approved.status).toBe(200);
    expect(approved.data.plan).toMatchObject({
      status: "approved",
      decidedBy: devUserId,
      note: "Không cần lọc theo chi nhánh.",
      editedContent: { steps: edited.steps },
    });
    expect(approved.data.run).toMatchObject({ id: run.id, state: "queued", kind: "code" });
    expect(await auditOf("plan.approve", stored.id)).toEqual([
      expect.objectContaining({ actor_user_id: devUserId, data: expect.objectContaining({ edited: true }) }),
    ]);

    const code = await w.take(run.id);
    expect(code.spec.kind).toBe("code");
    const prompt = String(code.spec.prompt);
    expect(prompt).toContain("Kế hoạch đã được người duyệt chấp thuận");
    expect(prompt).toContain("Cập nhật tài liệu báo cáo");
    expect(prompt).toContain("`src/report.ts` (sửa): Thêm hàm tổng hợp.");
    expect(prompt).toContain("Ghi chú của người duyệt: Không cần lọc theo chi nhánh.");
    expect(await taskStatus(task.id)).toBe("running");

    // Run code không nộp kế hoạch được.
    const coder = await mcp(code.runToken);
    expect((await coder.listTools()).tools.map((t) => t.name)).not.toContain("plan_submit");
    await expect(submitPlan(coder, planV1)).rejects.toThrow(/plan_submit/);

    await w.finish(run.id, 0, { commitCount: 1, changedFiles: ["src/report.ts"] });
    await until(async () => (await runRow(run.id)).state === "succeeded");
    expect(await taskStatus(task.id)).toBe("review");

    const again = await api<ApiError>("POST", `/v1/tasks/${task.id}/plan/approve`, { planId: stored.id });
    expect(again.status).toBe(409);
    expect(again.data.data?.code).toBe("PLAN_DECIDED");
  });

  it("từ chối: run code bị huỷ, task về todo; lập lại thì run plan mới đọc kế hoạch bị từ chối và lý do", async () => {
    await setPlanMode(true);
    const w = await FakeWorker.connect(await seedMachine(`reject-${tag}`));
    const first = await planned(w);
    const empty = await api<ApiError>("POST", `/v1/tasks/${first.task.id}/plan/reject`, {
      planId: first.planId,
      reason: " ",
    });
    expect(empty.status).toBe(400);
    const rejected = await api<PlanDecision>("POST", `/v1/tasks/${first.task.id}/plan/reject`, {
      planId: first.planId,
      reason: "Thiếu bước migration.",
    });
    expect(rejected.status).toBe(200);
    expect(rejected.data.plan).toMatchObject({
      status: "rejected",
      note: "Thiếu bước migration.",
      decidedBy: devUserId,
    });
    expect(rejected.data.run).toMatchObject({ id: first.run.id, state: "cancelled" });
    expect(await taskStatus(first.task.id)).toBe("todo");
    expect(await auditOf("plan.reject", first.planId)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ replan: false, reason: "Thiếu bước migration." }) }),
    ]);

    // Lập lại: run code cũ huỷ, run code mới đi lại từ planning.
    const second = await planned(w);
    const replan = await api<PlanDecision>("POST", `/v1/tasks/${second.task.id}/plan/reject`, {
      planId: second.planId,
      reason: "Cần tách thành hai PR.",
      replan: true,
    });
    expect(replan.status).toBe(200);
    expect(replan.data.plan.status).toBe("rejected");
    const next = replan.data.run;
    expect(next).toMatchObject({ state: "planning", kind: "code", taskId: second.task.id, createdBy: devUserId });
    expect(next.id).not.toBe(second.run.id);
    expect((await runRow(second.run.id)).state).toBe("cancelled");
    expect(await taskStatus(second.task.id)).toBe("queued");

    const [child] = await planChildren(next.id);
    const { spec, runToken } = await w.take(child.id);
    const prompt = String(spec.prompt);
    expect(prompt).toContain("đã bị người duyệt từ chối");
    expect(prompt).toContain("Lý do: Cần tách thành hai PR.");
    expect(prompt).toContain(planV2.summary);
    // Duyệt kế hoạch cũ sau khi đã lập lại: không duyệt nhầm bản cũ.
    const stale = await api<ApiError>("POST", `/v1/tasks/${second.task.id}/plan/approve`, { planId: second.planId });
    expect(stale.status).toBe(409);

    await submitPlan(await mcp(runToken), { summary: "Tách hai PR.", steps: [{ title: "PR 1" }, { title: "PR 2" }] });
    await w.finish(child.id, 0, {});
    await until(async () => (await runRow(next.id)).state === "awaiting_plan");
    const revisions = await plansOf(second.task.id);
    expect(revisions.map((p) => [p.revision, p.status])).toEqual([
      [1, "rejected"],
      [2, "awaiting"],
    ]);
    expect((await api<Plan>("GET", `/v1/tasks/${second.task.id}/plan`)).data).toMatchObject({
      revision: 2,
      runId: next.id,
    });
    // Lịch sử cho màn duyệt: lần mới nhất trước, bản bị từ chối giữ lý do.
    const history = await api<PlanHistory>("GET", `/v1/tasks/${second.task.id}/plans`);
    expect(history.status).toBe(200);
    expect(history.data.canDecide).toBe(true);
    expect(history.data.plans.map((p) => [p.revision, p.status, p.note])).toEqual([
      [2, "awaiting", null],
      [1, "rejected", "Cần tách thành hai PR."],
    ]);
  });

  it("quyền duyệt như người giao việc: thành viên và quản trị đội được, người xem và đội khác không", async () => {
    await setPlanMode(true);
    const w = await FakeWorker.connect(await seedMachine(`perm-${tag}`));
    const { task, run, planId } = await planned(w);
    const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
      withTenant(pool, { userId: org.user(who), orgId: org.orgId }, fn);
    const approve = (who: string) =>
      as(who, (tx) => engine.planActions.approve(tx, org.user(who), { id: task.id, planId, note: "" }));
    const reject = (who: string) =>
      as(who, (tx) =>
        engine.planActions.reject(tx, org.user(who), { id: task.id, planId, reason: "Không", replan: false }),
      );

    // Người xem đọc được kế hoạch nhưng không duyệt hay từ chối được.
    expect((await as("tviewer", (tx) => getPlan(tx, org.user("tviewer"), task.id))).id).toBe(planId);
    // Lịch sử báo người xem không duyệt được, để web hiện màn chỉ đọc; quản trị đội thì được.
    const history = (who: string) => as(who, (tx) => listPlans(tx, org.user(who), task.id));
    expect(await history("tviewer")).toMatchObject({ canDecide: false, plans: [{ id: planId }] });
    expect((await history("tmember")).canDecide).toBe(true);
    expect((await history("tadmin")).canDecide).toBe(true);
    expect(await errorCode(() => history("oadmin"))).toBe("TASK_NOT_FOUND");
    expect(await errorCode(() => approve("tviewer"))).toBe("TEAM_ROLE_REQUIRED");
    expect(await errorCode(() => reject("tviewer"))).toBe("TEAM_ROLE_REQUIRED");
    expect(await errorCode(() => approve("oadmin"))).toBe("TASK_NOT_FOUND");
    expect(await errorCode(() => as("oadmin", (tx) => getPlan(tx, org.user("oadmin"), task.id)))).toBe(
      "TASK_NOT_FOUND",
    );
    expect((await plansOf(task.id))[0].status).toBe("awaiting");

    const { result } = await approve("tadmin");
    expect(result.plan).toMatchObject({
      status: "approved",
      decidedBy: org.user("tadmin"),
      editedContent: null,
      note: null,
    });
    expect(result.run).toMatchObject({ id: run.id, state: "queued" });
    // Không giao run (bỏ afterCommit) và huỷ luôn, để đề nghị job không giữ slot của máy ở test sau.
    expect((await api<Run>("POST", `/v1/runs/${run.id}/cancel`, {})).data.state).toBe("cancelled");
  });

  it("run plan lỗi, hết giờ hay không gọi plan_submit: run code thất bại, task về todo, báo nhóm quản trị", async () => {
    await setPlanMode(true);
    const w = await FakeWorker.connect(await seedMachine(`fail-${tag}`));
    for (const tc of [
      { exit: 0, report: { status: "succeeded" }, want: "chưa gọi plan_submit" },
      { exit: 1, report: { status: "timeout", error: "context deadline exceeded" }, want: "mã lỗi 1" },
    ]) {
      const { task, run } = await assign();
      const [child] = await planChildren(run.id);
      await w.take(child.id);
      await w.finish(child.id, tc.exit, tc.report);
      await until(async () => (await runRow(run.id)).state === "failed");
      expect((await runRow(child.id)).state).toBe("failed");
      const reasons = (await runRow(run.id)).result.reasons.join(" ");
      expect(reasons).toContain("Không lập được kế hoạch");
      expect(reasons).toContain(tc.want);
      expect(await taskStatus(task.id)).toBe("todo");
      expect(await plansOf(task.id)).toHaveLength(0);
      const { rows } = await admin.query(
        "select 1 from hive.notifications where org_id = $1 and event = 'run.failed' and title like $2",
        [org.orgId, `%${task.key}%`],
      );
      expect(rows).toHaveLength(1);
      // Task không treo: giao lại được ngay.
      const again = await api<Run>("POST", "/v1/runs", { taskId: task.id, cli: "claude" });
      expect(again.status).toBe(200);
      // Run plan của lần giao lại đã được đề nghị cho máy duy nhất: phải huỷ xong (bỏ đề nghị) trước kịch bản sau,
      // không thì máy còn bận và run plan kế tiếp không nhận được job_offer.
      const cancelled = await api<Run>("POST", `/v1/runs/${again.data.id}/cancel`, {});
      expect(cancelled.status, JSON.stringify(cancelled.data)).toBe(200);
      await until(async () =>
        (await planChildren(again.data.id)).every(
          (r: { state: string; offer_machine_id: string | null }) => r.state === "cancelled" && !r.offer_machine_id,
        ),
      );
    }
  });

  it("huỷ run plan khi chưa có máy: run code thất bại vì kế hoạch bị huỷ", async () => {
    await setPlanMode(true);
    const { task, run } = await assign();
    const [child] = await planChildren(run.id);
    const cancelled = await api<Run>("POST", `/v1/runs/${child.id}/cancel`, {});
    expect(cancelled.data.state).toBe("cancelled");
    await until(async () => (await runRow(run.id)).state === "failed");
    expect((await runRow(run.id)).result.reasons[0]).toContain("run lập kế hoạch đã bị huỷ");
    expect(await taskStatus(task.id)).toBe("todo");
  });

  it("huỷ task: đang lập kế hoạch thì huỷ cả run plan; đang chờ duyệt thì kế hoạch thành superseded", async () => {
    await setPlanMode(true);
    const w = await FakeWorker.connect(await seedMachine(`cancel-${tag}`));
    const planning = await assign();
    const [child] = await planChildren(planning.run.id);
    await w.take(child.id);
    const res = await api<Task>("POST", `/v1/tasks/${planning.task.id}/cancel`, {});
    expect(res.data.status).toBe("cancelled");
    expect((await runRow(planning.run.id)).state).toBe("cancelled");
    // Run plan đang trên máy: hub gửi lệnh huỷ, máy xác nhận bằng run_result.
    expect((await runRow(child.id)).state).toBe("cancelling");
    await w.next("cancel", (c) => c.runId === child.id);
    await w.finish(child.id, 1, { status: "cancelled" });
    await until(async () => (await runRow(child.id)).state === "cancelled");
    await engine.verify(org.orgId, planning.run.id);
    expect((await runRow(planning.run.id)).state).toBe("cancelled");

    const waiting = await planned(w);
    const cancelRun = await api<Run>("POST", `/v1/runs/${waiting.run.id}/cancel`, {});
    expect(cancelRun.data.state).toBe("cancelled");
    expect((await plansOf(waiting.task.id))[0].status).toBe("superseded");
    expect(await taskStatus(waiting.task.id)).toBe("todo");
    const late = await api<ApiError>("POST", `/v1/tasks/${waiting.task.id}/plan/approve`, { planId: waiting.planId });
    expect(late.status).toBe(409);
  });

  it("issue mới khi bật planMode: run cũng lập kế hoạch trước (queueRun của hệ thống)", async () => {
    await setPlanMode(true);
    taskNo++;
    const { rows } = await admin.query(
      `insert into hive.tasks (org_id, team_id, project_id, number, key, title, body, status, created_by)
       values ($1, $2, $3, $4, $5, 'Từ issue', '', 'todo', 'github:lan') returning id`,
      [org.orgId, org.teamId, projectId, 1000 + taskNo, `pm${tag}-${1000 + taskNo}`],
    );
    const { row, afterCommit } = await withTenant(pool, { orgId: org.orgId }, async (tx) => {
      const task = await loadTask(tx, rows[0].id);
      if (!task) throw new Error("Không thấy task");
      return engine.queueRun(tx, task, await loadProject(tx, projectId), { cli: null, createdBy: "github:lan" });
    });
    afterCommit();
    expect(row.state).toBe("planning");
    const [child] = await planChildren(row.id);
    expect(child.cli).toBeNull();
    // Máy chỉ có Gemini không nhận run plan (không gọi được plan_submit); máy có Claude nhận.
    const gemini = await FakeWorker.connect(await seedMachine(`gem-${tag}`, ["gemini"]));
    const claude = await FakeWorker.connect(await seedMachine(`cl-${tag}`));
    const { spec } = await claude.take(child.id);
    expect(spec.cli).toBe("claude");
    await expect(gemini.next("job_offer", (o) => o.runId === child.id, 300)).rejects.toThrow();
  });
});
