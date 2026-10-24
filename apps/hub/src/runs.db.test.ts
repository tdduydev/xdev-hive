// Luồng trọn của run: hub thật trên cổng ngẫu nhiên, client `ws` đóng vai worker Go, GitProvider giả trong bộ nhớ.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import {
  type AgentPolicyInput,
  type CostSummary,
  DEFAULT_AGENT_POLICY,
  defaultProjectSettings,
  defaultRouting,
  defaultTokenSaving,
  type ProjectBrief,
  type ProjectSettings,
  type Run,
  type Task,
  workflowInput,
} from "@xdev-hive/contracts";
import {
  type CostEventData,
  type HubToWorker,
  hubToWorker,
  PROTOCOL_VERSION,
  RUN_GIT_TOKEN_CAPABILITY,
} from "@xdev-hive/contracts/worker-protocol";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import WebSocket from "ws";
import { type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import { seedProject } from "../test/project-fixture.ts";
import { createApp } from "./app.ts";
import { loadProject } from "./modules/catalog/index.ts";
import { costSummary } from "./modules/cost/index.ts";
import { attachWorkerGateway, pauseMachine, registerRunHandlers, setMachineShared } from "./modules/fleet/index.ts";
import { createAuth } from "./modules/identity/index.ts";
import { saveDoc } from "./modules/knowledge/docs.ts";
import { proposeWithReview } from "./modules/knowledge/reviews.ts";
import { setOrgEntry } from "./modules/layers/index.ts";
import { createChannel } from "./modules/notify/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "./modules/platform/index.ts";
import {
  createRunsEngine,
  createRunTokenVerifier,
  parseCursor,
  RunNotifier,
  type RunsEngine,
} from "./modules/runs/index.ts";
import { createMemoryProvider, type MemoryProvider, type ProviderFactory } from "./modules/scm/index.ts";
import { loadTask } from "./modules/tasks/index.ts";

const { adminUrl, appUrl, authUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const authPool = createPool(authUrl);
// Cùng secret với các file test khác: JWKS của Better Auth nằm chung database và được mã hoá bằng secret này.
const secret = "test-secret-0123456789abcdef-0123456789";
const publicUrl = "http://hub.test";
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

let org: OrgFixture & { user: (n: string) => string };
let projectId = "";
let provider: MemoryProvider;
let engine: RunsEngine;
let notifier: RunNotifier;
let server: Server;
let gateway: { close: () => Promise<void> };
let unregister: () => void;
let base = "";
let cookie = "";
let devUserId = "";

beforeAll(async () => {
  org = await seedOrg(admin, `runs-${tag}`);
  const project = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: `hd-${tag}`,
    settings: { ...defaultProjectSettings(), models: { claude: { code: "claude-project-model" } } },
  });
  projectId = project.projectId;
  provider = createMemoryProvider("gitlab", ["xdev-team"]);
  provider.seedRepo({ owner: project.owner, name: project.repo });
  const providerFactory: ProviderFactory = () => provider;

  const auth = createAuth({ pool: authPool, baseURL: publicUrl, secret, allowEmailSignUp: true });
  engine = createRunsEngine({
    pool,
    publicUrl,
    authSecret: secret,
    masterKey,
    providerFactory,
    offerTtlSec: 30,
    leaseSec: 60,
    logger: quiet,
  });
  unregister = registerRunHandlers(engine.handlers);
  notifier = new RunNotifier(pool);
  const app = createApp({
    config: { port: 0, version: "test", publicUrl },
    auth,
    pool,
    runs: engine,
    runNotifier: notifier,
    providerFactory,
  });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve()) as Server;
  });
  gateway = attachWorkerGateway(server, { pool, heartbeatSec: 5, logger: quiet });
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Người dùng thật (phiên Better Auth) là thành viên đội sở hữu dự án.
  const res = await fetch(`http://${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Dev", email: `dev-${tag}@example.com`, password: "mat-khau-du-dai-123" }),
  });
  expect(res.status).toBe(200);
  cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  devUserId = ((await res.json()) as { user: { id: string } }).user.id;
  const userId = devUserId;
  await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [
    org.orgId,
    userId,
  ]);
  await admin.query("insert into hive.team_members (team_id, org_id, user_id, role) values ($1, $2, $3, 'member')", [
    org.teamId,
    org.orgId,
    userId,
  ]);
});

afterAll(async () => {
  unregister();
  engine.stop();
  await notifier.close();
  await gateway.close();
  await new Promise((resolve) => server.close(resolve));
  await Promise.all([admin.end(), pool.end(), authPool.end()]);
});

// ---- Công cụ ------------------------------------------------------------------------------------------------

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`http://${base}/api${path}`, {
    method,
    headers: { "content-type": "application/json", cookie, "x-hive-org": org.orgId },
    body: body === undefined ? null : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as T };
}

async function newTask(title: string, extra: Record<string, unknown> = {}): Promise<Task> {
  const { status, data } = await api<Task>("POST", "/v1/tasks", { projectId, title, body: "Mô tả", ...extra });
  expect(status).toBe(200);
  return data;
}

async function startRun(taskId: string, extra: Record<string, unknown> = {}): Promise<Run> {
  const { status, data } = await api<Run>("POST", "/v1/runs", { taskId, ...extra });
  expect(status).toBe(200);
  return data;
}

async function runRow(id: string) {
  return (await admin.query("select * from hive.runs where id = $1", [id])).rows[0];
}

async function taskStatus(id: string): Promise<string> {
  return (await admin.query("select status from hive.tasks where id = $1", [id])).rows[0].status;
}

async function until(check: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Hết thời gian chờ");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Seed máy và machine token bằng superuser: luồng đăng ký đã có test riêng ở fleet. */
/**
 * Máy thử mặc định là máy dùng chung của đội (như máy chủ CI), để các kịch bản không nói về chủ máy nhận run của bất
 * kỳ ai; `owner` cho máy cá nhân của một người (ADR 0017).
 */
async function seedMachine(name: string, clis: string[] = ["claude"], capacity = 1, owner?: string) {
  const token = `hwm_${randomBytes(32).toString("base64url")}`;
  const { rows } = await admin.query(
    "insert into hive.machines (org_id, team_id, name, os, version, clis, capacity, shared, registered_by) values ($1, $2, $3, 'linux', '1', $4, $5, $6, $7) returning id",
    [org.orgId, org.teamId, name, clis, capacity, owner === undefined, owner ?? null],
  );
  await admin.query(
    "insert into hive.machine_tokens (org_id, team_id, machine_id, token_hash) values ($1, $2, $3, $4)",
    [org.orgId, org.teamId, rows[0].id, createHash("sha256").update(token).digest("hex")],
  );
  return { id: rows[0].id as string, name, token, clis, capacity };
}

type Msg<T extends HubToWorker["type"]> = Extract<HubToWorker, { type: T }>;

const openWorkers = new Set<FakeWorker>();
// Máy của kịch bản trước còn nối (vì test hỏng giữa chừng) sẽ nhận job của kịch bản sau; luôn đóng hết.
afterEach(async () => {
  await Promise.all([...openWorkers].map((w) => w.close()));
});

/** Worker giả: gom gói nhận được, test chờ gói theo loại (bỏ qua gói khác như ack, welcome). */
class FakeWorker {
  readonly ws: WebSocket;
  private inbox: HubToWorker[] = [];
  private waiters: Array<{ match: (m: HubToWorker) => boolean; resolve: (m: HubToWorker) => void }> = [];
  private seq = 0;

  constructor(token: string) {
    this.ws = new WebSocket(`ws://${base}/ws/worker`, { headers: { authorization: `Bearer ${token}` } });
    this.ws.on("message", (data) => {
      const msg = hubToWorker.parse(JSON.parse(data.toString()));
      const i = this.waiters.findIndex((w) => w.match(msg));
      if (i >= 0) this.waiters.splice(i, 1)[0]?.resolve(msg);
      else this.inbox.push(msg);
    });
  }

  static async connect(m: {
    name: string;
    token: string;
    clis: string[];
    capacity: number;
    capabilities?: string[];
    localProjects?: { bound: string[]; full: string[] };
  }) {
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
      capacity: m.capacity,
      ...(m.capabilities ? { capabilities: m.capabilities } : {}),
      ...(m.localProjects ? { localProjects: m.localProjects } : {}),
    });
    await w.next("welcome");
    return w;
  }

  send(msg: Record<string, unknown>) {
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), ...msg }));
  }

  /** Gói run có seq tăng dần như worker thật. */
  sendRun(msg: Record<string, unknown>, seq = this.seq++) {
    this.send({ ...msg, seq });
    return seq;
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

  /** Có gói loại này trong hộp thư (đã nhận nhưng chưa ai lấy) không. */
  has(type: HubToWorker["type"]): boolean {
    return this.inbox.some((m) => m.type === type);
  }

  async close() {
    if (!openWorkers.delete(this)) return;
    const closed = new Promise((resolve) => this.ws.once("close", resolve));
    this.ws.close();
    await closed;
  }
}

/** Đọc luồng SSE tới khi gặp sự kiện `end` (hoặc hết giờ). */
async function readSse(runId: string, lastEventId?: string, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const headers: Record<string, string> = { cookie, "x-hive-org": org.orgId };
  if (lastEventId) headers["last-event-id"] = lastEventId;
  const res = await fetch(`http://${base}/api/v1/runs/${runId}/stream`, { headers, signal: ctrl.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const out: Array<{ id: string | undefined; event: string; data: Record<string, unknown> }> = [];
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(part, { stream: true });
      let idx = buf.indexOf("\n\n");
      while (idx >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        idx = buf.indexOf("\n\n");
        const fields: Record<string, string> = {};
        for (const line of block.split("\n")) {
          const m = /^(\w+): ?(.*)$/.exec(line);
          if (m?.[1]) fields[m[1]] = m[2] ?? "";
        }
        if (!fields.event) continue;
        out.push({ id: fields.id, event: fields.event, data: JSON.parse(fields.data ?? "{}") });
        if (fields.event === "end") {
          ctrl.abort();
          return out;
        }
      }
    }
  } catch (e) {
    if (!ctrl.signal.aborted) throw e;
  } finally {
    clearTimeout(timer);
  }
  return out;
}

const sha = "c".repeat(40);

// ---- Kịch bản -----------------------------------------------------------------------------------------------

describe("run từ đầu tới PR", () => {
  it("máy nhận job, gửi sự kiện, log, kết quả → run succeeded, PR mở, task chờ review, SSE nhận đủ", async () => {
    const m = await seedMachine(`ok-${tag}`);
    const w = await FakeWorker.connect(m);
    const task = await newTask("Sửa lỗi làm tròn hoá đơn");
    const run = await startRun(task.id);
    expect(run).toMatchObject({ state: "queued", attempt: 1, branch: `ai/${task.key}` });
    const live = readSse(run.id);

    const offer = await w.next("job_offer", (o) => o.runId === run.id);
    expect(offer.attempt).toBe(1);
    expect(offer.spec).toMatchObject({
      taskKey: task.key,
      branch: `ai/${task.key}`,
      baseBranch: "main",
      cli: "claude",
      model: "claude-project-model",
      runPermissions: "workspace",
      repoUrl: expect.stringContaining("gitlab.com"),
    });
    expect(offer.spec.checks).toBeUndefined();
    w.send({ type: "job_accept", runId: run.id, attempt: 1 });
    const lease = await w.next("lease", (l) => l.runId === run.id);
    const claims = createRunTokenVerifier({ authSecret: secret, publicUrl })(lease.runToken);
    expect(claims).toMatchObject({ run_id: run.id, task_id: task.id, org_id: org.orgId, aud: `${publicUrl}/mcp` });
    expect((await runRow(run.id)).state).toBe("leased");
    expect(await taskStatus(task.id)).toBe("running");

    // Heartbeat gia hạn lease.
    w.send({ type: "heartbeat", load: 1, runs: [{ runId: run.id, attempt: 1, leaseId: lease.leaseId }] });
    const hb = await w.next("heartbeat_ack");
    expect(hb).toMatchObject({ renewed: [lease.leaseId], cancel: [] });

    const s0 = w.sendRun({ type: "run_event", runId: run.id, attempt: 1, event: "phase", data: { phase: "prepare" } });
    expect((await w.next("ack", (a) => a.uptoSeq === s0)).runId).toBe(run.id);
    const s1 = w.sendRun({ type: "run_event", runId: run.id, attempt: 1, event: "phase", data: { phase: "running" } });
    await w.next("ack", (a) => a.uptoSeq === s1);
    expect((await runRow(run.id)).state).toBe("running");
    // Gửi lại gói đã gửi (worker nối lại): ack lại nhưng không ghi trùng.
    w.sendRun({ type: "run_event", runId: run.id, attempt: 1, event: "phase", data: { phase: "running" } }, s1);
    await w.next("ack", (a) => a.uptoSeq === s1);
    const s2 = w.sendRun({
      type: "log_chunk",
      runId: run.id,
      attempt: 1,
      offset: 0,
      bytes: Buffer.from("xin chào\n").toString("base64"),
    });
    await w.next("ack", (a) => a.uptoSeq === s2);
    const s3 = w.sendRun({
      type: "run_event",
      runId: run.id,
      attempt: 1,
      event: "agent_report",
      data: { summary: "Đã sửa", details: { token: `ghp_${"A".repeat(36)}` } },
    });
    await w.next("ack", (a) => a.uptoSeq === s3);
    const s4 = w.sendRun({
      type: "run_result",
      runId: run.id,
      attempt: 1,
      exit: 0,
      headSha: sha,
      report: { commitCount: 1, changedFiles: ["src/hoa-don.ts"], errorDetails: { token: `ghp_${"A".repeat(36)}` } },
    });
    await w.next("ack", (a) => a.uptoSeq === s4);

    await until(async () => (await runRow(run.id)).state === "succeeded");
    const row = await runRow(run.id);
    expect(row.pr_url).toMatch(/\/pull\/\d+$/);
    expect(row.head_sha).toBe(sha);
    expect(row.result.checks).toEqual([expect.objectContaining({ check: "changes", passed: true })]);
    expect(await taskStatus(task.id)).toBe("review");
    const pr = [...provider.repos.values()][0]?.pulls.find((p) => p.head === `ai/${task.key}`);
    expect(pr).toMatchObject({ base: "main", title: `${task.key}: ${task.title}` });
    const dup = await admin.query("select count(*)::int as n from hive.run_events where run_id = $1 and seq = $2", [
      run.id,
      s1,
    ]);
    expect(dup.rows[0].n).toBe(1);
    const reports = await admin.query(
      "select data from hive.run_events where run_id = $1 and type in ('agent_report', 'result')",
      [run.id],
    );
    expect(JSON.stringify(reports.rows)).not.toContain(`ghp_${"A".repeat(36)}`);

    // SSE mở từ đầu nhận đủ chuyển trạng thái, sự kiện của worker và log, kết thúc bằng end.
    const events = await live;
    const states = events.filter((e) => e.event === "run_event" && e.data.type === "state").map((e) => e.data.data);
    expect(states.map((s) => (s as { to: string }).to)).toEqual([
      "queued",
      "leased",
      "preparing",
      "running",
      "verifying",
      "succeeded",
    ]);
    expect(events.some((e) => e.event === "run_event" && e.data.type === "agent_report")).toBe(true);
    const logs = events.filter((e) => e.event === "log");
    expect(Buffer.from(String(logs[0]?.data.bytes), "base64").toString()).toBe("xin chào\n");
    expect(events.at(-1)).toMatchObject({ event: "end", data: { state: "succeeded" } });

    // Nối lại bằng Last-Event-ID: chỉ nhận phần sau con trỏ.
    const cut = events.findIndex((e) => e.event === "run_event" && e.data.type === "agent_report");
    const resumed = await readSse(run.id, events[cut]?.id);
    const at = parseCursor(events[cut]?.id);
    const resumedEvents = resumed.filter((e) => e.event === "run_event");
    expect(resumedEvents.length).toBeGreaterThan(0);
    expect(resumedEvents.every((e) => Number(e.data.id) > at.e)).toBe(true);
    expect(resumed.filter((e) => e.event === "log").every((e) => Number(e.data.id) > at.l)).toBe(true);
    expect(resumed.length).toBeLessThan(events.length);

    // API events/logs đọc lại được như SSE.
    const evs = await api<Array<{ type: string }>>("GET", `/v1/runs/${run.id}/events?after=0`);
    expect(evs.data.filter((e) => e.type === "phase")).toHaveLength(2);
    const lg = await api<Array<{ bytes: string }>>("GET", `/v1/runs/${run.id}/logs`);
    expect(lg.data).toHaveLength(1);
    const storedLogs = await admin.query("select count(*)::int as n from hive.run_logs where run_id = $1", [run.id]);
    expect(storedLogs.rows[0].n).toBe(0);
    await w.close();
  });
});

describe("máy tạm dừng", () => {
  it("run đã nhận tiếp tục tới xong; offer mới được chuyển sang máy khác", async () => {
    const firstMachine = await seedMachine(`pause-a-${tag}`);
    const firstWorker = await FakeWorker.connect(firstMachine);
    const runningTask = await newTask("Run đang chạy khi tạm dừng");
    const running = await startRun(runningTask.id);
    await firstWorker.next("job_offer", (offer) => offer.runId === running.id);
    firstWorker.send({ type: "job_accept", runId: running.id, attempt: 1 });
    await firstWorker.next("lease", (lease) => lease.runId === running.id);

    await withTenant(pool, { userId: org.user("admin"), orgId: org.orgId }, (tx) =>
      pauseMachine(tx, org.user("admin"), firstMachine.id),
    );
    const secondMachine = await seedMachine(`pause-b-${tag}`);
    const secondWorker = await FakeWorker.connect(secondMachine);
    const queuedTask = await newTask("Run mới sau khi tạm dừng");
    const queued = await startRun(queuedTask.id);
    const offer = await secondWorker.next("job_offer", (message) => message.runId === queued.id);
    expect(offer.runId).toBe(queued.id);
    expect(await firstWorker.has("job_offer")).toBe(false);

    firstWorker.sendRun({
      type: "run_result",
      runId: running.id,
      attempt: 1,
      exit: 0,
      headSha: null,
      report: { commitCount: 0 },
    });
    await until(async () => (await runRow(running.id)).state === "no_changes");
    await secondWorker.close();
    await firstWorker.close();
  });
});

describe("lệnh kiểm của chính sách kết quả (RUN-07)", () => {
  it.each([
    { exit: 0, required: true, outcome: "succeeded" },
    { exit: 1, required: true, outcome: "failed" },
    { exit: -1, required: true, outcome: "failed" },
    { exit: 1, required: false, outcome: "needs_review" },
    { exit: undefined, required: true, outcome: "needs_review" },
  ])("lệnh trả $exit, bắt buộc $required → $outcome", async ({ exit, required, outcome }) => {
    const settings = defaultProjectSettings();
    settings.outcome.default.push(
      { check: "command", required, run: "pnpm test", timeout: "20s" },
      { check: "command", required, run: "pnpm lint", timeout: "2m" },
      { check: "command", required, run: "pnpm build", timeout: "2h" },
    );
    const p = await seedProject(admin, pool, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: `cmd-${randomUUID().slice(0, 6)}`,
      settings,
    });
    provider.seedRepo({ owner: p.owner, name: p.repo });
    const w = await FakeWorker.connect(await seedMachine(`cmd-${randomUUID().slice(0, 6)}`));
    const task = await newTask("Kiểm tra kết quả lệnh", { projectId: p.projectId });
    const run = await startRun(task.id);
    const offer = await w.next("job_offer", (o) => o.runId === run.id);
    expect(offer.spec.checks).toEqual({
      commands: [
        { run: "pnpm test", timeoutSec: 20 },
        { run: "pnpm lint", timeoutSec: 120 },
        { run: "pnpm build", timeoutSec: 3600 },
      ],
    });
    // Kết luận phải dùng bản chụp của run dù quản trị đổi chính sách khi worker đang chạy.
    await admin.query(
      "update hive.projects set settings = jsonb_set(settings, '{outcome,default}', '[]') where id = $1",
      [p.projectId],
    );
    w.send({ type: "job_accept", runId: run.id, attempt: 1 });
    await w.next("lease", (l) => l.runId === run.id);
    const commands = ["pnpm test", "pnpm lint", "pnpm build"].map((run, i) => ({
      run,
      exit: i === 0 ? exit : 0,
      durationMs: 1200,
      tail: "kết quả lệnh",
    }));
    w.sendRun({
      type: "run_result",
      runId: run.id,
      attempt: 1,
      exit: 0,
      headSha: sha,
      report: { commitCount: 1, changedFiles: ["src/a.ts"], ...(exit === undefined ? {} : { commands }) },
    });
    await until(async () => (await runRow(run.id)).state === outcome);
    const row = await runRow(run.id);
    expect(row.result.checks.filter((c: { check: string }) => c.check === "command")).toHaveLength(3);
    expect(row.result.checks[1].passed).toBe(exit === undefined ? null : exit === 0);
    if (outcome === "succeeded") expect(row.pr_url).toMatch(/\/pull\/\d+$/);
    else expect(row.pr_url).toBeNull();
    await w.close();
  });
});

describe("bí mật tại máy (specs/031)", () => {
  const rogue = {
    secretNames: ["STRIPE_KEY"],
    secrets: { STRIPE_KEY: "sk_live_do_not_store" },
    secretValues: ["sk_live_do_not_store"],
  };

  it.each([
    { name: "số hợp lệ", sent: 2, stored: 2 },
    { name: "số 0", sent: 0, stored: 0 },
    { name: "vượt trần 64", sent: 65, stored: undefined },
    { name: "không phải số nguyên", sent: 1.5, stored: undefined },
    { name: "không phải số", sent: "2", stored: undefined },
    { name: "worker cũ không báo", sent: undefined, stored: undefined },
  ])("run_result báo $name: hub chỉ giữ số lượng, không giữ tên hay giá trị", async ({ sent, stored }) => {
    const w = await FakeWorker.connect(await seedMachine(`sec-${randomUUID().slice(0, 6)}`));
    const task = await newTask("Dùng bí mật tại máy");
    const run = await startRun(task.id);
    await w.next("job_offer", (o) => o.runId === run.id);
    w.send({ type: "job_accept", runId: run.id, attempt: 1 });
    await w.next("lease", (l) => l.runId === run.id);
    w.sendRun({
      type: "run_result",
      runId: run.id,
      attempt: 1,
      exit: 0,
      headSha: sha,
      report: {
        commitCount: 1,
        changedFiles: ["src/a.ts"],
        ...rogue,
        ...(sent === undefined ? {} : { secretsInjected: sent }),
      },
    });
    await until(async () => (await runRow(run.id)).state === "succeeded");

    const view = await api<Run>("GET", `/v1/runs/${run.id}`);
    expect(view.data.result?.secretsInjected).toBe(stored);
    const events = await api<unknown[]>("GET", `/v1/runs/${run.id}/events?after=0`);
    const stores = JSON.stringify([
      await runRow(run.id),
      (await admin.query("select * from hive.run_events where run_id = $1", [run.id])).rows,
      view.data,
      events.data,
    ]);
    // Cả cơ sở dữ liệu lẫn mọi route đọc đều không có tên, giá trị hay khoá nào ngoài số lượng.
    expect(stores).not.toMatch(/STRIPE_KEY|sk_live_do_not_store|secretNames|secretValues/);
    expect(stores).not.toMatch(/"secrets"/);
    const row = await runRow(run.id);
    expect(Object.keys(row.result.report).filter((k) => /secret/i.test(k))).toEqual(
      stored === undefined ? [] : ["secretsInjected"],
    );
    await w.close();
  });
});

describe("model theo cấu hình dự án", () => {
  it("đưa model cấu hình vào spec và cho người giao ghi đè", async () => {
    const m = await seedMachine(`model-${tag}`);
    const w = await FakeWorker.connect(m);
    const task = await newTask("Chọn model");
    const run = await startRun(task.id, { model: "claude-override-model" });
    expect(run.model).toBe("claude-override-model");
    const offer = await w.next("job_offer", (o) => o.runId === run.id);
    expect(offer.spec).toMatchObject({ model: "claude-override-model" });
    await w.close();
  });
});

describe("định tuyến model và effort theo cấp độ task", () => {
  let plainProject = "";
  let offProject = "";
  let customProject = "";
  const seed = (key: string, settings: ProjectSettings) =>
    seedProject(admin, pool, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key,
      settings,
    });

  beforeAll(async () => {
    // Dự án mặc định của file này có sẵn models.claude.code, mà model cấu hình thắng định tuyến.
    plainProject = (await seed(`rtp-${tag}`, defaultProjectSettings())).projectId;
    offProject = (
      await seed(`rto-${tag}`, { ...defaultProjectSettings(), routing: { ...defaultRouting, enabled: false } })
    ).projectId;
    customProject = (
      await seed(`rtc-${tag}`, {
        ...defaultProjectSettings(),
        budget: { maxTurns: 33 },
        routing: {
          enabled: true,
          tiers: {
            ...defaultRouting.tiers,
            medium: { model: "haiku", effort: "low", maxTurns: 90, advisor: "opus" },
          },
        },
      })
    ).projectId;
  });

  it("task không có tín hiệu: cấp vừa, sonnet + effort high, 120 lượt; run hiện lý do", async () => {
    const m = await seedMachine(`rt-default-${tag}`);
    const w = await FakeWorker.connect(m);
    const task = await newTask("Việc bình thường", { projectId: plainProject });
    const run = await startRun(task.id);
    const offer = await w.next("job_offer", (o) => o.runId === run.id);
    expect(offer.spec).toMatchObject({ model: "sonnet", effort: "high", tier: "medium", budget: { maxTurns: 120 } });
    expect(offer.spec.advisor).toBeUndefined();
    const view = await api<Run>("GET", `/v1/runs/${run.id}`);
    expect(view.data.routing).toMatchObject({
      tier: "medium",
      baseTier: "medium",
      source: "default",
      model: "sonnet",
      effort: "high",
      maxTurns: 120,
    });
    expect(view.data.routing?.reasons.join(" ")).toContain("cấp vừa");
    await w.close();
  });

  it("loại task docs → nhẹ; nhãn issue tier:heavy → nặng; người đặt tay thắng tất cả", async () => {
    const m = await seedMachine(`rt-tiers-${tag}`, ["claude"], 4);
    const w = await FakeWorker.connect(m);
    const docs = await newTask("Sửa chữ", { type: "docs", projectId: plainProject });
    const docsRun = await startRun(docs.id);
    const docsOffer = await w.next("job_offer", (o) => o.runId === docsRun.id);
    expect(docsOffer.spec).toMatchObject({
      model: "sonnet",
      effort: "medium",
      tier: "light",
      budget: { maxTurns: 60 },
    });

    const heavy = await newTask("Việc lớn", { projectId: plainProject });
    await admin.query(`update hive.tasks set source = source || '{"labels":["Tier:heavy"]}'::jsonb where id = $1`, [
      heavy.id,
    ]);
    const heavyRun = await startRun(heavy.id);
    const heavyOffer = await w.next("job_offer", (o) => o.runId === heavyRun.id);
    expect(heavyOffer.spec).toMatchObject({ model: "opus", effort: "high", tier: "heavy", budget: { maxTurns: 200 } });

    const manual = await newTask("Đặt tay nhẹ", { type: "security", projectId: plainProject });
    const manualRun = await startRun(manual.id, { tier: "light" });
    expect(manualRun.tier).toBe("light");
    const manualOffer = await w.next("job_offer", (o) => o.runId === manualRun.id);
    expect(manualOffer.spec).toMatchObject({ model: "sonnet", effort: "medium", tier: "light" });
    const view = await api<Run>("GET", `/v1/runs/${manualRun.id}`);
    expect(view.data.routing).toMatchObject({ source: "manual", tier: "light" });
    await w.close();
  });

  it("lease hết hạn rồi thử lại thì nâng một cấp, ghi lý do", async () => {
    const m = await seedMachine(`rt-retry-${tag}`);
    const w = await FakeWorker.connect(m);
    const task = await newTask("Việc nhẹ nhưng máy treo", { type: "docs", projectId: plainProject });
    const run = await startRun(task.id);
    const offer1 = await w.next("job_offer", (o) => o.runId === run.id && o.attempt === 1);
    expect(offer1.spec).toMatchObject({ tier: "light", model: "sonnet", effort: "medium" });
    w.send({ type: "job_accept", runId: run.id, attempt: 1 });
    const lease1 = await w.next("lease", (l) => l.runId === run.id);
    await admin.query("update hive.run_leases set expires_at = now() - interval '1 second' where id = $1", [
      lease1.leaseId,
    ]);
    await engine.fire({ kind: "lease", orgId: org.orgId, runId: run.id, leaseId: lease1.leaseId });
    const offer2 = await w.next("job_offer", (o) => o.runId === run.id && o.attempt === 2);
    expect(offer2.spec).toMatchObject({ tier: "medium", model: "sonnet", effort: "high" });
    const view = await api<Run>("GET", `/v1/runs/${run.id}`);
    expect(view.data.routing).toMatchObject({ tier: "medium", baseTier: "light" });
    expect(view.data.routing?.reasons.join(" ")).toContain("Thử lại sau lỗi nên nâng từ cấp nhẹ lên vừa");
    await w.close();
  });

  it("run trước của task đã lỗi thì run mới (attempt 1) cũng lên một cấp", async () => {
    const m = await seedMachine(`rt-prior-${tag}`);
    const w = await FakeWorker.connect(m);
    const task = await newTask("Sửa chữ nhưng lần trước lỗi", { type: "docs", projectId: plainProject });
    const first = await startRun(task.id);
    const offer1 = await w.next("job_offer", (o) => o.runId === first.id);
    expect(offer1.spec).toMatchObject({ tier: "light", model: "sonnet", effort: "medium" });
    w.send({ type: "job_accept", runId: first.id, attempt: 1 });
    await w.next("lease", (l) => l.runId === first.id);
    w.sendRun({
      type: "run_result",
      runId: first.id,
      attempt: 1,
      exit: 1,
      headSha: null,
      report: { status: "failed" },
    });
    await until(async () => (await runRow(first.id)).state === "failed");

    const second = await startRun(task.id);
    const offer2 = await w.next("job_offer", (o) => o.runId === second.id);
    expect(offer2.attempt).toBe(1);
    expect(offer2.spec).toMatchObject({ tier: "medium", model: "sonnet", effort: "high", budget: { maxTurns: 120 } });
    await w.close();
  });

  it("model người chọn thắng định tuyến, effort vẫn theo cấp", async () => {
    const m = await seedMachine(`rt-explicit-${tag}`);
    const w = await FakeWorker.connect(m);
    const task = await newTask("Chọn model tay", { projectId: plainProject });
    const run = await startRun(task.id, { model: "claude-override-model" });
    const offer = await w.next("job_offer", (o) => o.runId === run.id);
    expect(offer.spec).toMatchObject({ model: "claude-override-model", effort: "high" });
    const view = await api<Run>("GET", `/v1/runs/${run.id}`);
    expect(view.data.routing?.model).toBe("claude-override-model");
    expect(view.data.routing?.reasons.join(" ")).toContain("định tuyến chỉ chọn effort");
    await w.close();
  });

  it("dự án tắt định tuyến: spec không có effort, tier, model, trần lượt", async () => {
    const m = await seedMachine(`rt-off-${tag}`);
    const w = await FakeWorker.connect(m);
    const task = await newTask("Không định tuyến", { projectId: offProject });
    const run = await startRun(task.id);
    const offer = await w.next("job_offer", (o) => o.runId === run.id);
    expect(offer.spec.effort).toBeUndefined();
    expect(offer.spec.tier).toBeUndefined();
    expect(offer.spec.model).toBeNull();
    expect(offer.spec.budget).toBeUndefined();
    const view = await api<Run>("GET", `/v1/runs/${run.id}`);
    expect(view.data.routing).toBeNull();
    await w.close();
  });

  it("ánh xạ riêng của dự án; budget.maxTurns của dự án thắng trần lượt theo cấp; cố vấn đi vào spec", async () => {
    const m = await seedMachine(`rt-custom-${tag}`);
    const w = await FakeWorker.connect(m);
    const task = await newTask("Ánh xạ riêng", { projectId: customProject });
    const run = await startRun(task.id);
    const offer = await w.next("job_offer", (o) => o.runId === run.id);
    expect(offer.spec).toMatchObject({
      model: "haiku",
      effort: "low",
      advisor: "opus",
      tier: "medium",
      budget: { maxTurns: 33 },
    });
    await w.close();
  });

  it("Codex chỉ nhận effort: model giữ nguyên, không có trần lượt", async () => {
    const m = await seedMachine(`rt-codex-${tag}`, ["codex"]);
    const w = await FakeWorker.connect(m);
    const task = await newTask("Codex định tuyến", { type: "security", projectId: plainProject });
    const run = await startRun(task.id, { cli: "codex" });
    const offer = await w.next("job_offer", (o) => o.runId === run.id);
    expect(offer.spec).toMatchObject({ effort: "high", tier: "heavy", model: null });
    expect(offer.spec.budget).toBeUndefined();
    await w.close();
  });
});

describe("quyền CLI theo cấu hình dự án", () => {
  it("đưa chế độ full của dự án vào spec", async () => {
    await withTenant(pool, { userId: org.user("admin"), orgId: org.orgId }, async (tx) => {
      await tx.$client.query(
        `update hive.projects set settings = settings || '{"runPermissions":{"mode":"full"}}'::jsonb where id = $1`,
        [projectId],
      );
    });
    try {
      const m = await seedMachine(`permissions-${tag}`);
      const w = await FakeWorker.connect(m);
      try {
        const task = await newTask("Kiểm quyền CLI");
        const run = await startRun(task.id);
        const offer = await w.next("job_offer", (o) => o.runId === run.id);
        expect(offer.spec).toMatchObject({ runPermissions: "full" });
      } finally {
        await w.close();
      }
    } finally {
      await withTenant(pool, { userId: org.user("admin"), orgId: org.orgId }, async (tx) => {
        await tx.$client.query("update hive.projects set settings = settings - 'runPermissions' where id = $1", [
          projectId,
        ]);
      });
    }
  });
});

describe("MCP server ngoài theo quy tắc (MCP-06)", () => {
  it("run code nhận server được phép; server bị chặn và cổng MCP của hub không nằm trong danh sách", async () => {
    const insert = (name: string, rule: string, matchType: string, pattern: string, launch: string[] | null) =>
      admin.query(
        `insert into hive.mcp_server_rules (org_id, project_id, name, rule, match_type, pattern, transport, command,
           args, updated_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'test')`,
        [
          org.orgId,
          projectId,
          name,
          rule,
          matchType,
          pattern,
          launch ? "stdio" : null,
          launch?.[0] ?? null,
          JSON.stringify(launch?.slice(1) ?? []),
        ],
      );
    await insert("GitHub", "allow", "name", "github", ["npx", "-y", "@modelcontextprotocol/server-github"]);
    await insert("Filesystem", "allow", "name", "filesystem", ["npx", "@modelcontextprotocol/server-filesystem"]);
    await insert("Chặn filesystem", "deny", "command", "npx @modelcontextprotocol/server-filesystem", null);
    try {
      const m = await seedMachine(`mcp-ext-${tag}`);
      const w = await FakeWorker.connect(m);
      try {
        const task = await newTask("Dùng MCP server ngoài");
        const run = await startRun(task.id);
        const offer = await w.next("job_offer", (o) => o.runId === run.id);
        expect(offer.spec.mcpServers).toEqual([
          { name: "github", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
        ]);
      } finally {
        await w.close();
      }
    } finally {
      await admin.query("delete from hive.mcp_server_rules where org_id = $1", [org.orgId]);
    }
  });
});

describe("từ chối, huỷ, không có máy", () => {
  it("máy từ chối → hub đề nghị máy khác; huỷ run đang chạy gửi cancel tới máy", async () => {
    const mb = await seedMachine(`rj-b-${tag}`);
    const mc = await seedMachine(`rj-c-${tag}`);
    const b = await FakeWorker.connect(mb);
    const c = await FakeWorker.connect(mc);
    const task = await newTask("Tác vụ bị từ chối");
    const run = await startRun(task.id);
    // Không chờ bằng next() trên cả hai máy: waiter của máy thua sẽ nuốt mất đề nghị thứ hai.
    await until(async () => b.has("job_offer") || c.has("job_offer"));
    const first = b.has("job_offer") ? { w: b, other: c, id: mb.id } : { w: c, other: b, id: mc.id };
    await first.w.next("job_offer", (o) => o.runId === run.id);
    first.w.send({ type: "job_reject", runId: run.id, attempt: 1, reason: "đang bận" });
    const offer = await first.other.next("job_offer", (o) => o.runId === run.id);
    expect(offer.attempt).toBe(1);
    first.other.send({ type: "job_accept", runId: run.id, attempt: 1 });
    const lease = await first.other.next("lease");
    const row = await runRow(run.id);
    expect(row.state).toBe("leased");
    expect(row.rejected_by).toEqual([first.id]);
    const rejected = await admin.query(
      "select data from hive.run_events where run_id = $1 and type = 'offer_rejected'",
      [run.id],
    );
    expect(rejected.rows[0].data).toMatchObject({ machineId: first.id, reason: "đang bận" });

    // Huỷ: run sang cancelling, máy nhận cancel; heartbeat kèm lệnh huỷ và không gia hạn lease nữa.
    const cancelled = await api<Run>("POST", `/v1/runs/${run.id}/cancel`);
    expect(cancelled.data.state).toBe("cancelling");
    expect((await first.other.next("cancel", (m) => m.runId === run.id)).graceSec).toBeGreaterThan(0);
    first.other.send({ type: "heartbeat", load: 1, runs: [{ runId: run.id, attempt: 1, leaseId: lease.leaseId }] });
    expect(await first.other.next("heartbeat_ack")).toMatchObject({ renewed: [], cancel: [run.id] });
    // Worker dừng agent rồi gửi kết quả: run cancelled, task quay về todo.
    first.other.sendRun({ type: "run_result", runId: run.id, attempt: 1, exit: 130, headSha: null, report: null });
    await until(async () => (await runRow(run.id)).state === "cancelled");
    expect(await taskStatus(task.id)).toBe("todo");
    await Promise.all([b.close(), c.close()]);
  });

  it("máy đang được giao run khác (tranh khoá máy) thì giao lại ngay khi khoá nhả, không chờ heartbeat", async () => {
    const m = await seedMachine(`lk-${tag}`, ["claude"], 2);
    const w = await FakeWorker.connect(m);
    // Giao dịch khác đang giữ khoá giao việc của máy, như khi hai run cùng được giao một lúc (e2e 10a).
    const holder = await admin.connect();
    await holder.query("begin");
    await holder.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`runs:machine:${m.id}`]);
    const task = await newTask("Giao lúc máy đang bị khoá");
    const run = await startRun(task.id);
    await new Promise((r) => setTimeout(r, 300));
    await holder.query("commit");
    holder.release();
    const offer = await w.next("job_offer", (o) => o.runId === run.id, 2000);
    expect(offer.attempt).toBe(1);
    const waiting = await admin.query("select 1 from hive.run_events where run_id = $1 and type = 'waiting_machine'", [
      run.id,
    ]);
    expect(waiting.rowCount).toBe(0);
    w.send({ type: "job_reject", runId: run.id, attempt: 1, reason: "test xong" });
    await api<Run>("POST", `/v1/runs/${run.id}/cancel`);
    await w.close();
  });

  it("không máy nào có CLI phù hợp thì giữ queued; huỷ run đang chờ thì cancelled ngay", async () => {
    const task = await newTask("Cần Gemini");
    const run = await startRun(task.id, { cli: "gemini" });
    await new Promise((r) => setTimeout(r, 200));
    expect(await runRow(run.id)).toMatchObject({ state: "queued", offer_machine_id: null });
    const again = await api<{ data?: { code: string } }>("POST", "/v1/runs", { taskId: task.id });
    expect(again.status).toBe(409);
    expect(again.data.data?.code).toBe("RUN_ACTIVE");
    const res = await api<Run>("POST", `/v1/runs/${run.id}/cancel`);
    expect(res.data.state).toBe("cancelled");
    expect(await taskStatus(task.id)).toBe("todo");
  });

  it("huỷ task huỷ luôn run đang chờ", async () => {
    const task = await newTask("Huỷ cả task");
    const run = await startRun(task.id, { cli: "gemini" });
    const res = await api<Task>("POST", `/v1/tasks/${task.id}/cancel`);
    expect(res.data.status).toBe("cancelled");
    expect((await runRow(run.id)).state).toBe("cancelled");
    expect((await api("POST", "/v1/runs", { taskId: task.id })).status).toBe(409);
  });
});

describe("lease hết hạn và fencing", () => {
  it("lease hết hạn → lost → thử lại với attempt mới; gói của attempt cũ bị bỏ; hết lượt thì failed", async () => {
    const m = await seedMachine(`ls-${tag}`);
    const w = await FakeWorker.connect(m);
    const task = await newTask("Máy treo giữa chừng");
    const run = await startRun(task.id);
    await w.next("job_offer", (o) => o.runId === run.id);
    w.send({ type: "job_accept", runId: run.id, attempt: 1 });
    const lease1 = await w.next("lease", (l) => l.runId === run.id);

    // Máy im lặng quá hạn lease: hẹn giờ kiểm lease chuyển run sang lost rồi queued (attempt 2), đề nghị lại.
    await admin.query("update hive.run_leases set expires_at = now() - interval '1 second' where id = $1", [
      lease1.leaseId,
    ]);
    await engine.fire({ kind: "lease", orgId: org.orgId, runId: run.id, leaseId: lease1.leaseId });
    const offer2 = await w.next("job_offer", (o) => o.runId === run.id && o.attempt === 2);
    expect(offer2.attempt).toBe(2);
    const states = await admin.query(
      "select data->>'to' as to from hive.run_events where run_id = $1 and type = 'state' order by id",
      [run.id],
    );
    expect(states.rows.map((r) => r.to)).toEqual(["queued", "leased", "lost", "queued"]);
    expect(await taskStatus(task.id)).toBe("queued");

    w.send({ type: "job_accept", runId: run.id, attempt: 2 });
    const lease2 = await w.next("lease", (l) => l.runId === run.id && l.attempt === 2);

    // Worker cũ sống lại gửi gói attempt 1: hub ack để worker bỏ khỏi bộ đệm, nhưng không ghi và không đổi run.
    const stale = w.sendRun(
      { type: "run_event", runId: run.id, attempt: 1, event: "phase", data: { phase: "running" } },
      100,
    );
    await w.next("ack", (a) => a.uptoSeq === stale);
    w.sendRun({ type: "run_result", runId: run.id, attempt: 1, exit: 0, headSha: sha, report: null }, 101);
    await w.next("ack", (a) => a.uptoSeq === 101);
    const old = await admin.query(
      "select count(*)::int as n from hive.run_events where run_id = $1 and attempt = 1 and seq is not null",
      [run.id],
    );
    expect(old.rows[0].n).toBe(0);
    expect(await runRow(run.id)).toMatchObject({ state: "leased", attempt: 2 });
    // Heartbeat với lease cũ không được gia hạn.
    w.send({ type: "heartbeat", load: 1, runs: [{ runId: run.id, attempt: 1, leaseId: lease1.leaseId }] });
    expect(await w.next("heartbeat_ack")).toMatchObject({ renewed: [], cancel: [run.id] });

    // Hết lượt thử: lease lần 2 hết hạn thì failed.
    await admin.query("update hive.runs set max_attempts = 2 where id = $1", [run.id]);
    await admin.query("update hive.run_leases set expires_at = now() - interval '1 second' where id = $1", [
      lease2.leaseId,
    ]);
    await engine.fire({ kind: "lease", orgId: org.orgId, runId: run.id, leaseId: lease2.leaseId });
    const failed = await runRow(run.id);
    expect(failed.state).toBe("failed");
    expect(failed.result.reasons[0]).toContain("2/2");
    expect(await taskStatus(task.id)).toBe("todo");
    await w.close();
  });

  it("lease còn hạn thì hẹn giờ không làm gì", async () => {
    const m = await seedMachine(`ok2-${tag}`);
    const w = await FakeWorker.connect(m);
    const task = await newTask("Lease còn hạn");
    const run = await startRun(task.id);
    await w.next("job_offer", (o) => o.runId === run.id);
    w.send({ type: "job_accept", runId: run.id, attempt: 1 });
    const lease = await w.next("lease", (l) => l.runId === run.id);
    await engine.fire({ kind: "lease", orgId: org.orgId, runId: run.id, leaseId: lease.leaseId });
    expect(await runRow(run.id)).toMatchObject({ state: "leased", attempt: 1 });
    // Kết thúc không có commit: no_changes, task về todo, không mở PR.
    w.sendRun({ type: "run_result", runId: run.id, attempt: 1, exit: 0, headSha: null, report: { commitCount: 0 } });
    await until(async () => (await runRow(run.id)).state === "no_changes");
    expect((await runRow(run.id)).pr_url).toBeNull();
    expect(await taskStatus(task.id)).toBe("todo");
    await w.close();
  });
});

describe("thông báo cho nhóm quản trị", () => {
  const notes = async (taskKey: string) =>
    (
      await admin.query(
        "select event, title, body, link from hive.notifications where org_id = $1 and title like $2 order by created_at",
        [org.orgId, `%${taskKey}%`],
      )
    ).rows;

  it("run lỗi (exit khác 0) và run hết lượt vì mất máy đều có thông báo run.failed kèm lý do và link task", async () => {
    await withTenant(pool, { userId: org.user("admin"), orgId: org.orgId }, (tx) =>
      createChannel(tx, masterKey, org.user("admin"), {
        name: `quan-tri-${tag}`,
        events: ["run.failed", "run.needs_review"],
        config: { kind: "telegram", botToken: "123456:ABCdefGhIJKlmnOPQrstUVwxyz0123456789", chatId: "-1" },
      }),
    );
    const m = await seedMachine(`nt-${tag}`);
    const w = await FakeWorker.connect(m);

    const task = await newTask("Agent thoát lỗi");
    const run = await startRun(task.id);
    await w.next("job_offer", (o) => o.runId === run.id);
    w.send({ type: "job_accept", runId: run.id, attempt: 1 });
    await w.next("lease", (l) => l.runId === run.id);
    const s = w.sendRun({ type: "run_result", runId: run.id, attempt: 1, exit: 2, headSha: null, report: null });
    await w.next("ack", (a) => a.uptoSeq === s);
    await until(async () => (await runRow(run.id)).state === "failed");
    const [failed] = await notes(task.key);
    expect(failed).toMatchObject({
      event: "run.failed",
      title: `Run của ${task.key} thất bại`,
      link: `${publicUrl}/tasks/${task.key}`,
    });
    expect(failed.body).toContain("Agent thoát lỗi");
    const { rows: inbox } = await admin.query(
      "select user_id, event, link from hive.inbox_items where org_id = $1 and event_key = $2",
      [org.orgId, `${run.id}:1:failed`],
    );
    expect(inbox).toEqual([{ user_id: devUserId, event: "run.failed", link: `${publicUrl}/tasks/${task.key}` }]);

    const lost = await newTask("Máy mất giữa chừng");
    await admin.query("update hive.tasks set created_by = $1 where id = $2", [org.user("tmember"), lost.id]);
    const run2 = await startRun(lost.id);
    await admin.query("update hive.runs set max_attempts = 1 where id = $1", [run2.id]);
    await w.next("job_offer", (o) => o.runId === run2.id);
    w.send({ type: "job_accept", runId: run2.id, attempt: 1 });
    const lease = await w.next("lease", (l) => l.runId === run2.id);
    await admin.query("update hive.run_leases set expires_at = now() - interval '1 second' where id = $1", [
      lease.leaseId,
    ]);
    await engine.fire({ kind: "lease", orgId: org.orgId, runId: run2.id, leaseId: lease.leaseId });
    const [gone] = await notes(lost.key);
    expect(gone).toMatchObject({ event: "run.failed" });
    expect(gone.body).toContain("Mất kết nối với máy");
    expect(
      (
        await admin.query("select user_id from hive.inbox_items where org_id = $1 and event_key = $2", [
          org.orgId,
          `${run2.id}:1:failed`,
        ])
      ).rows
        .map((r) => r.user_id)
        .sort(),
    ).toEqual([devUserId, org.user("tmember")].sort());
    await w.close();
  });
});

describe("chỉ dẫn cho run đang chạy", () => {
  async function steer(runId: string, input: string) {
    const { status, afterCommit } = await withTenant(pool, { orgId: org.orgId }, (tx) =>
      engine.steerRun(tx, runId, input, "dev"),
    );
    afterCommit();
    return status;
  }
  const audits = async (runId: string) =>
    (
      await admin.query(
        "select action, actor_user_id, data from hive.audit_log where target_id = $1 and action like 'run.steer%' order by created_at, id",
        [runId],
      )
    ).rows;

  it("gói steer mang steerId và attempt; worker báo đã/chưa đưa vào agent; lần thử sau vẫn mang chỉ dẫn", async () => {
    const m = await seedMachine(`steer-${tag}`);
    const w = await FakeWorker.connect(m);
    const task = await newTask("Chỉ dẫn giữa chừng");
    const run = await startRun(task.id);
    await w.next("job_offer", (o) => o.runId === run.id);
    w.send({ type: "job_accept", runId: run.id, attempt: 1 });
    const lease = await w.next("lease", (l) => l.runId === run.id);
    const s0 = w.sendRun({ type: "run_event", runId: run.id, attempt: 1, event: "phase", data: { phase: "running" } });
    await w.next("ack", (a) => a.uptoSeq === s0);

    expect(await steer(run.id, "thêm test cho số âm")).toBe("sent");
    const first = await w.next("steer", (s) => s.runId === run.id);
    expect(first).toMatchObject({ attempt: 1, input: "thêm test cho số âm", steerId: expect.stringMatching(/^\d+$/) });
    expect(await steer(run.id, "đổi tên biến")).toBe("sent");
    const second = await w.next("steer", (s) => s.runId === run.id && s.input === "đổi tên biến");

    const results = [
      { steerId: first.steerId, applied: true },
      { steerId: second.steerId, applied: false, reason: "CLI codex chưa nhận chỉ dẫn giữa chừng" },
      // id không phải chỉ dẫn của run này: vẫn lưu sự kiện nhưng không ghi audit.
      { steerId: "999999999", applied: true },
    ];
    for (const data of results) {
      const seq = w.sendRun({ type: "run_event", runId: run.id, attempt: 1, event: "steer_result", data });
      await w.next("ack", (a) => a.uptoSeq === seq);
    }

    expect(await audits(run.id)).toEqual([
      { action: "run.steer_applied", actor_user_id: null, data: { steerId: Number(first.steerId), attempt: 1 } },
      {
        action: "run.steer_not_applied",
        actor_user_id: null,
        data: { steerId: Number(second.steerId), attempt: 1, reason: "CLI codex chưa nhận chỉ dẫn giữa chừng" },
      },
    ]);

    // Web ghép steer với steer_result theo id: sự kiện steer giữ delivered false, kết quả nằm ở steer_result.
    const { data: events } = await api<Array<{ id: number; type: string; data: Record<string, unknown> }>>(
      "GET",
      `/v1/runs/${run.id}/events`,
    );
    const steers = events.filter((e) => e.type === "steer");
    expect(steers.map((e) => [String(e.id), e.data])).toEqual([
      [first.steerId, { input: "thêm test cho số âm", by: "dev", delivered: false, sent: true }],
      [second.steerId, { input: "đổi tên biến", by: "dev", delivered: false, sent: true }],
    ]);
    expect(events.filter((e) => e.type === "steer_result").map((e) => e.data)).toEqual(results);

    // Mất máy: lần thử sau làm lại từ đầu nên vẫn nhận mọi chỉ dẫn trong prompt, kể cả chỉ dẫn đã vào lần thử trước.
    await admin.query("update hive.run_leases set expires_at = now() - interval '1 second' where id = $1", [
      lease.leaseId,
    ]);
    await engine.fire({ kind: "lease", orgId: org.orgId, runId: run.id, leaseId: lease.leaseId });
    const retry = await w.next("job_offer", (o) => o.runId === run.id && o.attempt === 2);
    expect(retry.spec.instructions).toEqual(["thêm test cho số âm", "đổi tên biến"]);
    await w.close();
  });

  it("run chưa tới máy: chỉ ghi lại, không gửi gói steer", async () => {
    const task = await newTask("Chỉ dẫn khi chờ máy", { preferredCli: "gemini" });
    const run = await startRun(task.id);
    expect(await steer(run.id, "nhớ chạy lint")).toBe("pending");
    const { rows } = await admin.query("select data from hive.run_events where run_id = $1 and type = 'steer'", [
      run.id,
    ]);
    expect(rows).toEqual([{ data: { input: "nhớ chạy lint", by: "dev", delivered: false, sent: false } }]);
    await api("POST", `/v1/runs/${run.id}/cancel`);
  });
});

describe("quyền", () => {
  it("người ngoài tổ chức không mở được SSE của run", async () => {
    const task = await newTask("Quyền SSE");
    const run = await startRun(task.id, { cli: "gemini" });
    const res = await fetch(`http://${base}/api/v1/runs/${run.id}/stream`, {
      headers: { cookie, "x-hive-org": randomUUID() },
    });
    expect([403, 404]).toContain(res.status);
    const anon = await fetch(`http://${base}/api/v1/runs/${run.id}/stream`, { headers: { "x-hive-org": org.orgId } });
    expect(anon.status).toBe(401);
    await api("POST", `/v1/runs/${run.id}/cancel`);
  });
});

describe("ai được tác động vào run đã có chủ (ADR 0017)", () => {
  interface Actor {
    id: string;
    cookie: string;
  }
  // Người thật có phiên Better Auth, vì quyền kiểm theo người gọi; fixture seedOrg không có mật khẩu.
  async function actor(name: string, orgRole: "member" | "admin", teamRole: "member" | "admin" | null): Promise<Actor> {
    const res = await fetch(`http://${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, email: `${name}-${tag}@example.com`, password: "mat-khau-du-dai-123" }),
    });
    expect(res.status).toBe(200);
    const id = ((await res.json()) as { user: { id: string } }).user.id;
    await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, $3)", [
      org.orgId,
      id,
      orgRole,
    ]);
    if (teamRole) {
      await admin.query("insert into hive.team_members (team_id, org_id, user_id, role) values ($1, $2, $3, $4)", [
        org.teamId,
        org.orgId,
        id,
        teamRole,
      ]);
    }
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    return { id, cookie };
  }
  async function as(who: Actor, path: string, body: unknown) {
    const res = await fetch(`http://${base}/api${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: who.cookie, "x-hive-org": org.orgId },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as { data?: { code?: string }; status?: string } };
  }
  const steerAs = (who: Actor, runId: string) => as(who, `/v1/runs/${runId}/steer`, { input: "đổi hướng làm" });
  const cancelAs = (who: Actor, runId: string) => as(who, `/v1/runs/${runId}/cancel`, {});

  let peer: Actor;
  let teamAdmin: Actor;
  let orgAdmin: Actor;
  beforeAll(async () => {
    peer = await actor("peer", "member", "member");
    teamAdmin = await actor("tadm", "member", "admin");
    orgAdmin = await actor("oadm", "admin", null);
  });

  async function teamRun(): Promise<string> {
    const task = await newTask("Việc của đội");
    const project = await withTenant(pool, { orgId: org.orgId }, (tx) => loadProject(tx, projectId));
    const queued = await withTenant(pool, { orgId: org.orgId }, async (tx) => {
      const t = await loadTask(tx, task.id);
      if (!t || !project) throw new Error("thiếu task hoặc dự án");
      return engine.queueRun(tx, t, project, { cli: null, createdBy: "github:octocat", actorUserId: null });
    });
    queued.afterCommit();
    return queued.row.id;
  }

  it("steer run của dev: chỉ dev; thành viên khác, quản trị đội và quản trị tổ chức đều bị chặn", async () => {
    const run = await startRun((await newTask("Steer của chủ")).id);
    for (const other of [peer, teamAdmin, orgAdmin]) {
      const res = await steerAs(other, run.id);
      expect(res.status).toBe(403);
      expect(res.data.data?.code).toBe("RUN_NOT_YOURS");
    }
    const own = await api<{ status: string }>("POST", `/v1/runs/${run.id}/steer`, { input: "thêm test" });
    expect(own.status).toBe(200);
    const { rows } = await admin.query("select data from hive.run_events where run_id = $1 and type = 'steer'", [
      run.id,
    ]);
    expect(rows.map((r) => r.data.by)).toEqual([devUserId]);
    await api("POST", `/v1/runs/${run.id}/cancel`);
  });

  it("steer run của đội: quản trị đội và quản trị tổ chức được, thành viên thường không", async () => {
    const runId = await teamRun();
    const denied = await steerAs(peer, runId);
    expect(denied.status).toBe(403);
    expect(denied.data.data?.code).toBe("RUN_NOT_YOURS");
    expect((await api<{ data?: { code?: string } }>("POST", `/v1/runs/${runId}/steer`, { input: "x" })).status).toBe(
      403,
    );
    expect((await steerAs(teamAdmin, runId)).status).toBe(200);
    expect((await steerAs(orgAdmin, runId)).status).toBe(200);
    await cancelAs(orgAdmin, runId);
  });

  it("huỷ run của dev: thành viên khác bị chặn, quản trị đội huỷ được; run của đội thì thành viên huỷ được", async () => {
    const run = await startRun((await newTask("Huỷ của chủ")).id);
    const denied = await cancelAs(peer, run.id);
    expect(denied.status).toBe(403);
    expect(denied.data.data?.code).toBe("RUN_NOT_YOURS");
    expect((await runRow(run.id)).state).not.toBe("cancelled");
    expect((await cancelAs(teamAdmin, run.id)).status).toBe(200);
    expect((await runRow(run.id)).state).toBe("cancelled");
    const teamRunId = await teamRun();
    expect((await cancelAs(peer, teamRunId)).status).toBe(200);
  });
});

describe("chi phí và ngân sách", () => {
  const today = new Date().toISOString().slice(0, 10);
  let costProject = "";
  let budgetProject = "";
  let rtkProject = "";
  let userId = "";
  let costTaskId = "";

  beforeAll(async () => {
    const seed = (key: string, settings?: ProjectSettings) =>
      seedProject(admin, pool, {
        orgId: org.orgId,
        teamId: org.teamId,
        systemId: org.systemId,
        adminUserId: org.user("admin"),
        masterKey,
        key,
        ...(settings ? { settings } : {}),
      });
    costProject = (await seed(`cp-${tag}`)).projectId;
    rtkProject = (await seed(`rk-${tag}`)).projectId;
    budgetProject = (
      await seed(`bp-${tag}`, {
        ...defaultProjectSettings(),
        budget: { perRunUsd: 0.4, perTaskUsd: 0.5, maxTurns: 7, perRunTokens: 100_000 },
      })
    ).projectId;
    userId = devUserId;
  });

  // Run còn chờ từ kịch bản trước sẽ được giao cho máy mới (giao cũ trước) và nằm lại trong hộp thư của worker giả,
  // làm các khẳng định "không có job_offer" hỏng tuỳ thời điểm; huỷ để mỗi kịch bản chỉ có run của nó.
  beforeEach(async () => {
    await admin.query("update hive.runs set state = 'cancelled' where org_id = $1 and state = 'queued'", [org.orgId]);
  });

  const cost = (v: Partial<CostEventData> = {}) => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    turns: null,
    model: null,
    ...v,
  });

  async function sendCost(w: FakeWorker, runId: string, attempt: number, data: Record<string, unknown>) {
    const s = w.sendRun({ type: "run_event", runId, attempt, event: "cost", data });
    await w.next("ack", (a) => a.runId === runId && a.uptoSeq === s);
  }

  async function costCols(id: string) {
    const r = await runRow(id);
    return {
      tokensIn: Number(r.tokens_in),
      tokensOut: Number(r.tokens_out),
      cacheRead: Number(r.cache_read),
      cacheWrite: Number(r.cache_write),
      costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
      turns: r.turns,
    };
  }

  it("sự kiện cost luỹ kế chỉ làm cột tăng, cộng qua các lần thử, bỏ gói của máy khác và gói sai dạng", async () => {
    const m = await seedMachine(`cost-${tag}`);
    const w = await FakeWorker.connect(m);
    const task = await newTask("Đo chi phí", { projectId: costProject });
    costTaskId = task.id;
    const run = await startRun(task.id);
    expect(run.cost).toEqual({
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: null,
      turns: null,
      accountId: null,
    });
    const offer = await w.next("job_offer", (o) => o.runId === run.id);
    // Chỉ có trần lượt mặc định của cấp vừa (định tuyến); không có trần tiền hay token.
    expect(offer.spec.budget).toEqual({ maxTurns: defaultRouting.tiers.medium.maxTurns });
    expect(offer.spec.tokenSaving).toEqual(defaultTokenSaving);
    w.send({ type: "job_accept", runId: run.id, attempt: 1 });
    const lease1 = await w.next("lease", (l) => l.runId === run.id);

    const first = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 50, costUsd: 0.1 };
    await sendCost(w, run.id, 1, cost({ ...first, turns: 1, model: "claude-opus-5-5", accountId: "claude-1" }));
    await sendCost(
      w,
      run.id,
      1,
      cost({
        inputTokens: 300,
        outputTokens: 40,
        cacheReadTokens: 3000,
        cacheWriteTokens: 80,
        costUsd: 0.25,
        turns: 3,
      }),
    );
    const after = { tokensIn: 300, tokensOut: 40, cacheRead: 3000, cacheWrite: 80, costUsd: 0.25, turns: 3 };
    expect(await costCols(run.id)).toEqual(after);
    // Gói đến muộn mang số luỹ kế nhỏ hơn: không làm giảm.
    await sendCost(w, run.id, 1, cost({ ...first, turns: 1 }));
    // Sai dạng (worker cũ, số âm): ghi sự kiện nhưng không cộng.
    await sendCost(w, run.id, 1, { inputTokens: -5 });
    expect(await costCols(run.id)).toEqual(after);

    // Máy khác gửi cost cho run không phải của nó: bị bỏ (fencing).
    const other = await FakeWorker.connect(await seedMachine(`cost-x-${tag}`));
    await sendCost(other, run.id, 1, cost({ inputTokens: 9_999_999, costUsd: 99 }));
    await other.close();
    expect(await costCols(run.id)).toEqual(after);

    // Mất máy, run giao lại ở lần thử 2: số luỹ kế đếm lại từ 0 và cộng thêm vào tổng của run.
    await admin.query("update hive.run_leases set expires_at = now() - interval '1 second' where id = $1", [
      lease1.leaseId,
    ]);
    await engine.fire({ kind: "lease", orgId: org.orgId, runId: run.id, leaseId: lease1.leaseId });
    await w.next("job_offer", (o) => o.runId === run.id && o.attempt === 2);
    w.send({ type: "job_accept", runId: run.id, attempt: 2 });
    await w.next("lease", (l) => l.runId === run.id && l.attempt === 2);
    // Codex: không báo USD và lượt; cột USD giữ nguyên.
    await sendCost(w, run.id, 2, cost({ inputTokens: 50, outputTokens: 5, cacheReadTokens: 10 }));
    // Gói attempt 1 đến sau khi đã sang attempt 2: bỏ.
    await sendCost(w, run.id, 1, cost({ inputTokens: 5000, costUsd: 5 }));
    w.sendRun({ type: "run_result", runId: run.id, attempt: 2, exit: 0, headSha: null, report: { commitCount: 0 } });
    await until(async () => (await runRow(run.id)).state === "no_changes");

    const got = await api<Run>("GET", `/v1/runs/${run.id}`);
    expect(got.data.cost).toEqual({
      tokensIn: 350,
      tokensOut: 45,
      cacheRead: 3010,
      cacheWrite: 80,
      costUsd: 0.25,
      turns: 3,
      // Lần thử 2 của worker không báo gói (đăng nhập mặc định): giữ gói đã biết thay vì xoá.
      accountId: "claude-1",
    });
    await w.close();
  });

  it("RTK: số liệu luỹ kế theo lần thử, gói đến muộn nhỏ hơn bị bỏ, lần thử mới ghi đè", async () => {
    const m = await seedMachine(`rtk-${tag}`);
    const w = await FakeWorker.connect({ ...m, capabilities: ["rtk"] });
    const task = await newTask("Đo RTK", { projectId: rtkProject });
    const run = await startRun(task.id);
    expect(run.rtk).toBeNull();
    await w.next("job_offer", (o) => o.runId === run.id);
    w.send({ type: "job_accept", runId: run.id, attempt: 1 });
    const lease = await w.next("lease", (l) => l.runId === run.id);
    await sendCost(w, run.id, 1, cost({ rtk: { commands: 4, savedTokens: 1200 } }));
    await sendCost(w, run.id, 1, cost({ rtk: { commands: 9, savedTokens: 5000 } }));
    // Gói đến muộn mang số luỹ kế nhỏ hơn: không làm giảm.
    await sendCost(w, run.id, 1, cost({ rtk: { commands: 6, savedTokens: 3000 } }));
    expect((await api<Run>("GET", `/v1/runs/${run.id}`)).data.rtk).toEqual({ commands: 9, savedTokens: 5000 });
    // Gói cost không có rtk (run không dùng RTK ở giai đoạn này) không xoá số đã có.
    await sendCost(w, run.id, 1, cost({ inputTokens: 5 }));
    expect((await api<Run>("GET", `/v1/runs/${run.id}`)).data.rtk).toEqual({ commands: 9, savedTokens: 5000 });

    await admin.query("update hive.run_leases set expires_at = now() - interval '1 second' where id = $1", [
      lease.leaseId,
    ]);
    await engine.fire({ kind: "lease", orgId: org.orgId, runId: run.id, leaseId: lease.leaseId });
    await w.next("job_offer", (o) => o.runId === run.id && o.attempt === 2);
    w.send({ type: "job_accept", runId: run.id, attempt: 2 });
    await w.next("lease", (l) => l.runId === run.id && l.attempt === 2);
    // Lần thử 2 đếm lại từ 0: số nhỏ hơn của lần thử trước vẫn được ghi.
    await sendCost(w, run.id, 2, cost({ rtk: { commands: 1, savedTokens: 80 } }));
    expect((await api<Run>("GET", `/v1/runs/${run.id}`)).data.rtk).toEqual({ commands: 1, savedTokens: 80 });
    await api("POST", `/v1/runs/${run.id}/cancel`);
    await w.close();
  });

  it("guard: spec có taskText của task, số guard luỹ kế theo lần thử và không lùi", async () => {
    const m = await seedMachine(`guard-${tag}`);
    const w = await FakeWorker.connect(m);
    const task = await newTask("Sửa LoginHandler trả 500", { projectId: rtkProject });
    const run = await startRun(task.id);
    expect(run.tokenGuard).toBeNull();
    const offer = await w.next("job_offer", (o) => o.runId === run.id);
    // Chỉ phần của task: không lẫn brief hay hướng dẫn chung của prompt.
    expect(offer.spec.taskText).toBe("Sửa LoginHandler trả 500\n\nMô tả");
    w.send({ type: "job_accept", runId: run.id, attempt: 1 });
    await w.next("lease", (l) => l.runId === run.id);
    await sendCost(w, run.id, 1, cost({ guard: { contextPackFiles: 12, exploreBlocked: 0, truncatedChars: 0 } }));
    await sendCost(w, run.id, 1, cost({ guard: { contextPackFiles: 12, exploreBlocked: 3, truncatedChars: 9000 } }));
    await sendCost(w, run.id, 1, cost({ guard: { contextPackFiles: 12, exploreBlocked: 1, truncatedChars: 100 } }));
    await sendCost(w, run.id, 1, cost({ inputTokens: 7 }));
    expect((await api<Run>("GET", `/v1/runs/${run.id}`)).data.tokenGuard).toEqual({
      contextPackFiles: 12,
      exploreBlocked: 3,
      truncatedChars: 9000,
    });
    await api("POST", `/v1/runs/${run.id}/cancel`);
    await w.close();
  });

  it("prompt nhắc codegraph_explore chỉ khi máy có CodeGraph, dự án bật và công tắc tổng bật", async () => {
    const withGraph = await seedMachine(`cg-${tag}`, ["claude"], 4);
    const w = await FakeWorker.connect({ ...withGraph, capabilities: ["codegraph", "rtk"] });
    const offerPrompt = async (title: string) => {
      const run = await startRun((await newTask(title, { projectId: rtkProject })).id);
      const offer = await w.next("job_offer", (o) => o.runId === run.id);
      await api("POST", `/v1/runs/${run.id}/cancel`);
      return String(offer.spec.prompt);
    };
    const setSaving = (patch: Record<string, unknown>) =>
      admin.query("update hive.projects set settings = jsonb_set(settings, '{tokenSaving}', $2::jsonb) where id = $1", [
        rtkProject,
        JSON.stringify({ ...defaultTokenSaving, ...patch }),
      ]);

    expect(await offerPrompt("Có CodeGraph")).toContain("`codegraph_explore`");
    // Settings lưu trước khi có mục codegraph: coi là bật.
    const { codegraph: _c, rtk: _r, ...old } = defaultTokenSaving;
    await admin.query(
      "update hive.projects set settings = jsonb_set(settings, '{tokenSaving}', $2::jsonb) where id = $1",
      [rtkProject, JSON.stringify(old)],
    );
    expect(await offerPrompt("Settings cũ")).toContain("`codegraph_explore`");
    await setSaving({ codegraph: false });
    expect(await offerPrompt("Dự án tắt CodeGraph")).not.toContain("codegraph_explore");
    await setSaving({ enabled: false });
    expect(await offerPrompt("Công tắc tổng tắt")).not.toContain("codegraph_explore");
    await w.close();

    await setSaving({});
    const plain = await seedMachine(`cg-none-${tag}`);
    const w2 = await FakeWorker.connect({ ...plain, capabilities: ["rtk"] });
    const run = await startRun((await newTask("Máy không có CodeGraph", { projectId: rtkProject })).id);
    const offer = await w2.next("job_offer", (o) => o.runId === run.id);
    expect(String(offer.spec.prompt)).not.toContain("codegraph_explore");
    await api("POST", `/v1/runs/${run.id}/cancel`);
    await w2.close();
  });

  it("spec mang trần của dự án; vượt trần thì failed; task đã tiêu hết ngân sách thì không giao thêm", async () => {
    const m = await seedMachine(`budget-${tag}`);
    const w = await FakeWorker.connect(m);
    const task = await newTask("Có ngân sách", { projectId: budgetProject });

    const run1 = await startRun(task.id);
    const offer1 = await w.next("job_offer", (o) => o.runId === run1.id);
    expect(offer1.spec.budget).toEqual({ maxCostUsd: 0.4, maxTokens: 100_000, maxTurns: 7 });
    w.send({ type: "job_accept", runId: run1.id, attempt: 1 });
    await w.next("lease", (l) => l.runId === run1.id);
    await sendCost(w, run1.id, 1, cost({ inputTokens: 10, costUsd: 0.3, turns: 2 }));
    w.sendRun({ type: "run_result", runId: run1.id, attempt: 1, exit: 0, headSha: null, report: { commitCount: 0 } });
    await until(async () => (await runRow(run1.id)).state === "no_changes");

    // Task đã tiêu 0.3/0.5: trần USD của run sau là phần còn lại (0.2), nhỏ hơn perRunUsd.
    const run2 = await startRun(task.id);
    const offer2 = await w.next("job_offer", (o) => o.runId === run2.id);
    expect((offer2.spec.budget as { maxCostUsd: number }).maxCostUsd).toBeCloseTo(0.2, 9);
    w.send({ type: "job_accept", runId: run2.id, attempt: 1 });
    await w.next("lease", (l) => l.runId === run2.id);
    // Worker dừng CLI vì vượt trần: gửi usage cuối rồi kết quả failed.
    await sendCost(w, run2.id, 1, cost({ inputTokens: 10, costUsd: 0.25, turns: 3 }));
    w.sendRun({
      type: "run_result",
      runId: run2.id,
      attempt: 1,
      exit: 1,
      headSha: null,
      report: { status: "failed", error: "Vượt ngân sách: chi phí $0.2500 > $0.2000" },
    });
    await until(async () => (await runRow(run2.id)).state === "failed");

    await admin.query("update hive.team_members set role = 'admin' where team_id = $1 and user_id = $2", [
      org.teamId,
      userId,
    ]);
    try {
      const stopped = await api<Array<Record<string, unknown>>>(
        "GET",
        `/v1/costs/budget-stopped?projectId=${budgetProject}`,
      );
      expect(stopped.status).toBe(200);
      expect(stopped.data).toEqual([
        expect.objectContaining({
          runId: run2.id,
          taskId: task.id,
          taskKey: task.key,
          reason: "per_task_usd",
          measured: 0.55,
          limit: 0.5,
        }),
      ]);
    } finally {
      await admin.query("update hive.team_members set role = 'member' where team_id = $1 and user_id = $2", [
        org.teamId,
        userId,
      ]);
    }

    const refused = await api<{ message: string; data?: { code: string } }>("POST", "/v1/runs", { taskId: task.id });
    expect(refused.status).toBe(400);
    expect(refused.data.message).toBe("Task đã dùng hết ngân sách");
    expect(refused.data.data?.code).toBe("TASK_BUDGET_EXHAUSTED");
    expect(await w.has("job_offer")).toBe(false);
    await w.close();
  });

  it("costs.summary: chỉ quản trị đội; nhóm theo task, CLI, máy, ngày; lọc theo khoảng ngày", async () => {
    const q = (params: Record<string, string>) =>
      api<CostSummary & { message?: string }>(
        "GET",
        `/v1/costs/summary?${new URLSearchParams({ projectId: costProject, from: today, to: today, ...params })}`,
      );
    // Người dùng là thành viên đội, chưa phải quản trị.
    const denied = await q({ groupBy: "task" });
    expect(denied.status).toBe(403);
    // Dự án không thấy được thì báo không tồn tại.
    expect((await q({ projectId: randomUUID() })).status).toBe(404);

    await admin.query("update hive.team_members set role = 'admin' where team_id = $1 and user_id = $2", [
      org.teamId,
      userId,
    ]);
    try {
      const byTask = await q({ groupBy: "task" });
      expect(byTask.status).toBe(200);
      expect(byTask.data.groups).toEqual([
        { key: costTaskId, runs: 1, tokensIn: 350, tokensOut: 45, cacheRead: 3010, cacheWrite: 80, costUsd: 0.25 },
      ]);
      expect(byTask.data.total).toEqual({
        runs: 1,
        tokensIn: 350,
        tokensOut: 45,
        cacheRead: 3010,
        cacheWrite: 80,
        costUsd: 0.25,
      });
      const byCli = await q({ groupBy: "cli" });
      expect(byCli.data.groups.map((g) => [g.key, g.runs])).toEqual([["claude", 1]]);
      const byAccount = await q({ groupBy: "account" });
      expect(byAccount.data.groups.map((g) => [g.key, g.runs, g.cacheRead, g.cacheWrite])).toEqual([
        ["claude-1", 1, 3010, 80],
      ]);
      const byMachine = await q({ groupBy: "machine" });
      const machineId = (
        await runRow((await admin.query("select id from hive.runs where task_id = $1", [costTaskId])).rows[0].id)
      ).machine_id;
      expect(byMachine.data.groups.map((g) => g.key)).toEqual([machineId]);
      const byDay = await q({});
      expect(byDay.data).toMatchObject({ groupBy: "day", groups: [{ key: today, runs: 1 }] });
      // Khoảng ngày không có run.
      const empty = await q({ from: "2020-01-01", to: "2020-01-31" });
      expect(empty.data).toMatchObject({ groups: [], total: { runs: 0, costUsd: 0 } });
      expect((await q({ from: today, to: "2020-01-01" })).status).toBe(400);
    } finally {
      await admin.query("update hive.team_members set role = 'member' where team_id = $1 and user_id = $2", [
        org.teamId,
        userId,
      ]);
    }
  });
});

describe("chính sách agent của tổ chức", () => {
  const setPolicy = (patch: Partial<AgentPolicyInput>) =>
    admin.query(
      `insert into hive.agent_policies (org_id, policy) values ($1, $2)
       on conflict (org_id) do update set policy = excluded.policy`,
      [org.orgId, JSON.stringify({ ...DEFAULT_AGENT_POLICY, ...patch })],
    );
  const limits = (patch: Partial<AgentPolicyInput["limits"]>) => ({ ...DEFAULT_AGENT_POLICY.limits, ...patch });
  const policyEvents = async (runId: string) =>
    (
      await admin.query(
        "select type, data from hive.run_events where run_id = $1 and type like 'policy%' order by id",
        [runId],
      )
    ).rows as Array<{ type: string; data: { message: string } }>;

  // Run còn chờ từ kịch bản trước sẽ chiếm slot của máy mới (giao cũ trước); huỷ để mỗi kịch bản chỉ có run của nó.
  beforeEach(async () => {
    await admin.query("update hive.runs set state = 'cancelled' where org_id = $1 and state = 'queued'", [org.orgId]);
  });

  afterEach(async () => {
    await admin.query("delete from hive.agent_policies where org_id = $1", [org.orgId]);
    await admin.query("delete from hive.config_layer_entries where org_id = $1", [org.orgId]);
  });

  it.each([false, true])("model và hook theo chính sách; quyền, ngân sách hai lớp với khoá %s", async (locked) => {
    await setPolicy({
      allowedModels: { claude: ["claude-sonnet-5-5", "claude-haiku-5-5"], codex: [], gemini: [] },
      allowFullPermission: true,
      hooks: [{ event: "Stop", name: "Test nhanh", command: "pnpm test" }],
      managedHooksOnly: true,
      limits: limits({ perRunUsd: 2 }),
    });
    await admin.query(
      `update hive.projects set settings = settings || '{"runPermissions":{"mode":"full"},"budget":{"perRunUsd":10}}'::jsonb
       where id = $1`,
      [projectId],
    );
    if (locked) {
      await withTenant(pool, { userId: org.user("owner"), orgId: org.orgId }, async (tx) => {
        await setOrgEntry(tx, org.user("owner"), { key: "agent.permissionMode", locked: true });
        await setOrgEntry(tx, org.user("owner"), { key: "limits.perRunUsd", locked: true });
      });
    }
    const m = await seedMachine(`policy-${locked}-${tag}`);
    const w = await FakeWorker.connect(m);
    try {
      const run = await startRun((await newTask("Theo chính sách")).id);
      const offer = await w.next("job_offer", (o) => o.runId === run.id);
      expect(offer.spec).toMatchObject({
        model: "claude-sonnet-5-5",
        runPermissions: locked ? "workspace" : "full",
        budget: { maxCostUsd: locked ? 2 : 10 },
        policy: { hooks: [{ event: "Stop", name: "Test nhanh", command: "pnpm test" }], managedHooksOnly: true },
      });
      const messages = (await policyEvents(run.id)).map((e) => e.data.message);
      expect(messages).toEqual([expect.stringContaining("không cho dùng claude-project-model")]);
      expect((await runRow(run.id)).agent_policy_snapshot).toMatchObject({
        model: "claude-sonnet-5-5",
        requestedModel: "claude-project-model",
        runPermissions: locked ? "workspace" : "full",
        sandbox: false,
        budget: { maxCostUsd: locked ? 2 : 10 },
        managedHooksOnly: true,
      });
    } finally {
      await w.close();
      await admin.query("update hive.projects set settings = settings - 'runPermissions' - 'budget' where id = $1", [
        projectId,
      ]);
    }
  });

  it.each([
    ["deny", true],
    ["approve", true],
    ["allow", false],
  ] as const)("bí mật tại máy %s: spec có policy là %s, bản chụp chính sách giữ lựa chọn", async (injection, sent) => {
    await setPolicy({ secretInjection: injection });
    const w = await FakeWorker.connect(await seedMachine(`policy-secret-${injection}-${tag}`));
    try {
      const run = await startRun((await newTask(`Bí mật ${injection}`)).id);
      const { spec } = await w.next("job_offer", (o) => o.runId === run.id);
      // Giữ spec như cũ khi không có gì cần báo, để worker cũ và worker mới nhận cùng một gói.
      if (sent) expect(spec).toMatchObject({ policy: { secretInjection: injection } });
      else expect(spec).not.toHaveProperty("policy");
      expect((await runRow(run.id)).agent_policy_snapshot).toMatchObject({ secretInjection: injection });
    } finally {
      await w.close();
    }
  });

  it("tổ chức cấm toàn quyền thì dự án ghi đè full vẫn chạy trong worktree", async () => {
    await setPolicy({ allowFullPermission: false });
    await admin.query(
      `update hive.projects set settings = settings || '{"runPermissions":{"mode":"full"}}'::jsonb where id = $1`,
      [projectId],
    );
    const w = await FakeWorker.connect(await seedMachine(`policy-nofull-${tag}`));
    try {
      const run = await startRun((await newTask("Dự án full khi tổ chức cấm")).id);
      expect((await w.next("job_offer", (o) => o.runId === run.id)).spec).toMatchObject({
        runPermissions: "workspace",
      });
    } finally {
      await w.close();
      await admin.query("update hive.projects set settings = settings - 'runPermissions' where id = $1", [projectId]);
    }
  });

  it("run không chỉ định model: CLI tự chọn, trừ khi cấm tự lên model đắt nhất", async () => {
    const m = await seedMachine(`policy-codex-${tag}`, ["codex"]);
    const w = await FakeWorker.connect(m);
    try {
      const models = { claude: [], codex: ["gpt-5-codex", "gpt-5"], gemini: [] };
      await setPolicy({ allowedModels: models });
      const free = await startRun((await newTask("Codex tự chọn")).id, { cli: "codex" });
      expect((await w.next("job_offer", (o) => o.runId === free.id)).spec).toMatchObject({ model: null });
      w.send({ type: "job_reject", runId: free.id, attempt: 1, reason: "test" });
      await setPolicy({ allowedModels: models, neverAutoUpgrade: true });
      const pinned = await startRun((await newTask("Codex theo chính sách")).id, { cli: "codex" });
      expect((await w.next("job_offer", (o) => o.runId === pinned.id)).spec).toMatchObject({ model: "gpt-5-codex" });
    } finally {
      await w.close();
    }
  });

  it("dự án không cho toàn quyền: giao run code Antigravity bị từ chối, máy chỉ có agy không nhận run tự chọn CLI", async () => {
    const { status, data } = await api<{ code: string; message: string }>("POST", "/v1/runs", {
      taskId: (await newTask("Antigravity khi chỉ có quyền workspace")).id,
      cli: "antigravity",
    });
    expect(status).toBe(409);
    expect(JSON.stringify(data)).toContain("CLI_NEEDS_FULL_PERMISSIONS");
    expect(JSON.stringify(data)).toContain("toàn quyền");
    const agy = await FakeWorker.connect(await seedMachine(`agy-ws-${tag}`, ["antigravity", "claude"]));
    try {
      const run = await startRun((await newTask("Tự chọn CLI khi chỉ có quyền workspace")).id);
      const offer = await agy.next("job_offer", (o) => o.runId === run.id);
      expect(offer.spec).toMatchObject({ cli: "claude" });
      agy.send({ type: "job_reject", runId: run.id, attempt: 1, reason: "test" });
    } finally {
      await agy.close();
    }
  });

  it("run Antigravity chỉ giao cho máy có agy và theo model chính sách cho Antigravity", async () => {
    // agy không giới hạn được trong worktree nên chỉ chạy run code khi dự án cho toàn quyền.
    await admin.query(
      `update hive.projects set settings = settings || '{"runPermissions":{"mode":"full"}}'::jsonb where id = $1`,
      [projectId],
    );
    const claude = await FakeWorker.connect(await seedMachine(`agy-cl-${tag}`, ["claude"]));
    const agy = await FakeWorker.connect(await seedMachine(`agy-${tag}`, ["antigravity"]));
    try {
      await setPolicy({
        allowedModels: { claude: [], codex: [], gemini: [], antigravity: ["gemini-3.8-flash-high"] },
        neverAutoUpgrade: true,
      });
      const run = await startRun((await newTask("Việc cho Antigravity")).id, { cli: "antigravity" });
      expect(run.cli).toBe("antigravity");
      const offer = await agy.next("job_offer", (o) => o.runId === run.id);
      expect(offer.spec).toMatchObject({ kind: "code", cli: "antigravity", model: "gemini-3.8-flash-high" });
      await expect(claude.next("job_offer", (o) => o.runId === run.id, 300)).rejects.toThrow();
      agy.send({ type: "job_reject", runId: run.id, attempt: 1, reason: "test" });
    } finally {
      await setPolicy({});
      await Promise.all([claude.close(), agy.close()]);
      await admin.query("update hive.projects set settings = settings - 'runPermissions' where id = $1", [projectId]);
    }
  });

  // ADR 0020: toàn quyền theo dự án, bật tại máy. Worker báo dự án đã gắn và dự án máy cho toàn quyền trong hello và
  // heartbeat; hub gửi fullAllowed cho worker tự áp, và chọn máy chạy được Antigravity theo đó.
  describe("toàn quyền bật tại máy", () => {
    const machineProjects = async (id: string) =>
      (await admin.query("select bound_projects, full_projects from hive.machines where id = $1", [id])).rows[0] as {
        bound_projects: string[];
        full_projects: string[];
      };

    it("job mang projectId và fullAllowed theo chính sách tổ chức", async () => {
      const w = await FakeWorker.connect(await seedMachine(`full-spec-${tag}`));
      try {
        const run = await startRun((await newTask("Spec có fullAllowed")).id);
        const offer = await w.next("job_offer", (o) => o.runId === run.id);
        expect(offer.spec).toMatchObject({ projectId, runPermissions: "workspace", fullAllowed: true });
        w.send({ type: "job_reject", runId: run.id, attempt: 1, reason: "test" });
        await setPolicy({ allowFullPermission: false });
        const denied = await startRun((await newTask("Spec khi tổ chức cấm")).id);
        expect((await w.next("job_offer", (o) => o.runId === denied.id)).spec).toMatchObject({ fullAllowed: false });
        w.send({ type: "job_reject", runId: denied.id, attempt: 1, reason: "test" });
      } finally {
        await w.close();
      }
    });

    it("máy cá nhân bật toàn quyền cho dự án: Antigravity chạy dù dự án chỉ workspace; tắt qua heartbeat thì thôi", async () => {
      const m = await seedMachine(`full-own-${tag}`, ["antigravity", "claude"], 1, devUserId);
      const w = await FakeWorker.connect({ ...m, localProjects: { bound: [projectId], full: [projectId] } });
      try {
        expect(await machineProjects(m.id)).toEqual({ bound_projects: [projectId], full_projects: [projectId] });
        const run = await startRun((await newTask("Antigravity nhờ máy cho toàn quyền")).id, { cli: "antigravity" });
        const offer = await w.next("job_offer", (o) => o.runId === run.id);
        // Spec vẫn mang quyền của dự án; worker tự nâng theo projects.json và fullAllowed.
        expect(offer.spec).toMatchObject({
          cli: "antigravity",
          projectId,
          runPermissions: "workspace",
          fullAllowed: true,
        });
        expect((await runRow(run.id)).agent_policy_snapshot).toMatchObject({ runPermissions: "full" });
        expect((await policyEvents(run.id)).map((e) => e.data.message)).toEqual([
          expect.stringContaining("đã bật toàn quyền cho dự án này"),
        ]);
        w.send({ type: "job_reject", runId: run.id, attempt: 1, reason: "test" });
        // Run không chọn CLI: máy cho toàn quyền thì Antigravity (CLI đầu của máy) được chọn.
        const auto = await startRun((await newTask("Tự chọn CLI trên máy toàn quyền")).id);
        expect((await w.next("job_offer", (o) => o.runId === auto.id)).spec).toMatchObject({ cli: "antigravity" });
        w.send({ type: "job_reject", runId: auto.id, attempt: 1, reason: "test" });

        // Tắt công tắc trong app: heartbeat sau đó mang danh sách mới.
        w.send({ type: "heartbeat", load: 0, runs: [], localProjects: { bound: [projectId], full: [] } });
        await w.next("heartbeat_ack");
        expect(await machineProjects(m.id)).toEqual({ bound_projects: [projectId], full_projects: [] });
        const off = await api<{ code: string }>("POST", "/v1/runs", {
          taskId: (await newTask("Antigravity khi máy đã tắt")).id,
          cli: "antigravity",
        });
        expect(off.status).toBe(409);
        expect(JSON.stringify(off.data)).toContain("CLI_NEEDS_FULL_PERMISSIONS");
        const fallback = await startRun((await newTask("Tự chọn CLI khi máy đã tắt")).id);
        expect((await w.next("job_offer", (o) => o.runId === fallback.id)).spec).toMatchObject({ cli: "claude" });
        w.send({ type: "job_reject", runId: fallback.id, attempt: 1, reason: "test" });

        // Heartbeat không mang danh sách (worker cũ hơn trong cùng phiên không có) giữ giá trị đã biết.
        w.send({ type: "heartbeat", load: 0, runs: [] });
        await w.next("heartbeat_ack");
        expect(await machineProjects(m.id)).toEqual({ bound_projects: [projectId], full_projects: [] });
      } finally {
        await w.close();
      }
    });

    it("tổ chức cấm toàn quyền thì công tắc của máy không có tác dụng", async () => {
      await setPolicy({ allowFullPermission: false });
      const m = await seedMachine(`full-deny-${tag}`, ["antigravity", "claude"], 1, devUserId);
      const w = await FakeWorker.connect({ ...m, localProjects: { bound: [projectId], full: [projectId] } });
      try {
        const res = await api<{ code: string }>("POST", "/v1/runs", {
          taskId: (await newTask("Antigravity khi tổ chức cấm")).id,
          cli: "antigravity",
        });
        expect(res.status).toBe(409);
        const auto = await startRun((await newTask("Tự chọn CLI khi tổ chức cấm")).id);
        expect((await w.next("job_offer", (o) => o.runId === auto.id)).spec).toMatchObject({
          cli: "claude",
          fullAllowed: false,
        });
        w.send({ type: "job_reject", runId: auto.id, attempt: 1, reason: "test" });
      } finally {
        await w.close();
      }
    });

    it("dự án cho toàn quyền: máy đã gắn mà chưa bật không nhận Antigravity, máy chưa gắn vẫn nhận", async () => {
      await admin.query(
        `update hive.projects set settings = settings || '{"runPermissions":{"mode":"full"}}'::jsonb where id = $1`,
        [projectId],
      );
      const boundOff = await seedMachine(`full-off-${tag}`, ["antigravity"]);
      const plain = await seedMachine(`full-plain-${tag}`, ["antigravity"]);
      const a = await FakeWorker.connect({ ...boundOff, localProjects: { bound: [projectId], full: [] } });
      const b = await FakeWorker.connect(plain);
      try {
        const run = await startRun((await newTask("Antigravity trên máy chưa gắn")).id, { cli: "antigravity" });
        expect((await b.next("job_offer", (o) => o.runId === run.id)).spec).toMatchObject({ runPermissions: "full" });
        await expect(a.next("job_offer", (o) => o.runId === run.id, 300)).rejects.toThrow();
        b.send({ type: "job_reject", runId: run.id, attempt: 1, reason: "test" });
        // Máy duy nhất còn lại chưa bật toàn quyền: run chờ và ghi lý do.
        await until(
          async () =>
            (
              await admin.query("select 1 from hive.run_events where run_id = $1 and type = 'waiting_machine'", [
                run.id,
              ])
            ).rows.length > 0,
        );
        const waiting = await admin.query(
          "select data from hive.run_events where run_id = $1 and type = 'waiting_machine'",
          [run.id],
        );
        expect(waiting.rows[0].data.message).toContain("Antigravity cần toàn quyền");
      } finally {
        await Promise.all([a.close(), b.close()]);
        await admin.query("update hive.projects set settings = settings - 'runPermissions' where id = $1", [projectId]);
      }
    });

    it("worker cũ nối lại không báo dự án: hub xoá danh sách của lần trước", async () => {
      const m = await seedMachine(`full-old-${tag}`);
      const w = await FakeWorker.connect({ ...m, localProjects: { bound: [projectId], full: [projectId] } });
      await w.close();
      const old = await FakeWorker.connect(m);
      try {
        await until(async () => (await machineProjects(m.id)).bound_projects.length === 0);
        expect(await machineProjects(m.id)).toEqual({ bound_projects: [], full_projects: [] });
      } finally {
        await old.close();
      }
    });
  });

  it("tổ chức chạm trần ngày: run chờ, báo một lần; nâng trần thì giao", async () => {
    const task = await newTask("Đã tiêu nhiều");
    await admin.query(
      `insert into hive.runs (org_id, team_id, project_id, task_id, branch, policy_snapshot, created_by, state, cost_usd,
         finished_at)
       values ($1, $2, $3, $4, 'ai/x', '[]', $5, 'succeeded', 100, now())`,
      [org.orgId, org.teamId, projectId, task.id, org.user("admin")],
    );
    await setPolicy({ limits: limits({ dailyUsd: 50 }) });
    const m = await seedMachine(`policy-cap-${tag}`);
    const w = await FakeWorker.connect(m);
    try {
      const run = await startRun((await newTask("Chờ ngày sau")).id);
      await new Promise((r) => setTimeout(r, 800));
      expect(w.has("job_offer")).toBe(false);
      w.send({ type: "heartbeat", load: 0, runs: [] });
      await w.next("heartbeat_ack");
      const capped = await policyEvents(run.id);
      expect(capped.map((e) => e.type)).toEqual(["policy_daily_cap"]);
      expect(capped[0]?.data.message).toContain("50 USD");
      await setPolicy({ limits: limits({ dailyUsd: 1000 }) });
      w.send({ type: "heartbeat", load: 0, runs: [] });
      await w.next("job_offer", (o) => o.runId === run.id);
    } finally {
      await w.close();
      await admin.query("delete from hive.runs where task_id = $1", [task.id]);
    }
  });

  it("số run cùng lúc mỗi máy thấp hơn sức chứa máy", async () => {
    await setPolicy({ limits: limits({ maxParallelPerMachine: 1 }) });
    const m = await seedMachine(`policy-slots-${tag}`, ["claude"], 2);
    const w = await FakeWorker.connect(m);
    try {
      const first = await startRun((await newTask("Run một")).id);
      await w.next("job_offer", (o) => o.runId === first.id);
      const second = await startRun((await newTask("Run hai")).id);
      await new Promise((r) => setTimeout(r, 800));
      expect(w.has("job_offer")).toBe(false);
      await setPolicy({});
      w.send({ type: "heartbeat", load: 0, runs: [] });
      await w.next("job_offer", (o) => o.runId === second.id);
    } finally {
      await w.close();
    }
  });

  it("bắt buộc sandbox: dự án chưa có image thì báo ngay khi giao", async () => {
    await setPolicy({ requireSandbox: true });
    const task = await newTask("Cần sandbox");
    const { status, data } = await api<{ data?: { code: string } }>("POST", "/v1/runs", { taskId: task.id });
    expect(status).toBe(409);
    expect(data.data?.code).toBe("SANDBOX_IMAGE_REQUIRED");
  });

  describe("token git theo run (specs/027 R9)", () => {
    const revoked: string[] = [];
    let issued = 0;
    const gitlabTokens = (fail = false) =>
      Object.assign(provider, {
        async issueRunToken() {
          if (fail) throw new Error("GitLab lỗi");
          issued += 1;
          return {
            host: "gitlab.com",
            username: "oauth2",
            token: `glpat-run-${issued}`,
            expiresAt: new Date(Date.now() + 86_400_000),
            externalId: String(issued),
          };
        },
        async revokeRunToken(_ref: unknown, id: string) {
          revoked.push(id);
        },
      });
    afterEach(() => {
      delete provider.issueRunToken;
      delete provider.revokeRunToken;
    });

    it("bắt buộc mà kết nối không cấp được: run chờ, báo một lần; bỏ bắt buộc thì giao", async () => {
      await setPolicy({ git: { requireRunGitToken: true } });
      const m = await seedMachine(`git-none-${tag}`);
      const w = await FakeWorker.connect({ ...m, capabilities: [RUN_GIT_TOKEN_CAPABILITY] });
      try {
        const run = await startRun((await newTask("Cần token git")).id);
        await new Promise((r) => setTimeout(r, 800));
        expect(w.has("job_offer")).toBe(false);
        w.send({ type: "heartbeat", load: 0, runs: [] });
        await w.next("heartbeat_ack");
        const events = await policyEvents(run.id);
        expect(events.map((e) => e.type)).toEqual(["policy_git_token"]);
        expect(events[0]?.data.message).toContain("token git theo run");
        await setPolicy({});
        w.send({ type: "heartbeat", load: 0, runs: [] });
        await w.next("job_offer", (o) => o.runId === run.id);
      } finally {
        await w.close();
      }
    });

    it("lease mang token git, máy xin lại được, run xong thì thu hồi; không lưu giá trị token", async () => {
      gitlabTokens();
      await setPolicy({ git: { requireRunGitToken: true } });
      const m = await seedMachine(`git-issue-${tag}`);
      const w = await FakeWorker.connect({ ...m, capabilities: [RUN_GIT_TOKEN_CAPABILITY] });
      try {
        const run = await startRun((await newTask("Có token git")).id);
        await w.next("job_offer", (o) => o.runId === run.id);
        w.send({ type: "job_accept", runId: run.id, attempt: 1 });
        const lease = await w.next("lease", (l) => l.runId === run.id);
        expect(lease.git).toMatchObject({ host: "gitlab.com", username: "oauth2", repo: expect.any(String) });
        const first = lease.git?.token;
        w.send({ type: "git_token_request", runId: run.id, attempt: 1 });
        const renewed = await w.next("git_token", (g) => g.runId === run.id);
        expect(renewed.git.token).not.toBe(first);
        const stored = await admin.query("select * from hive.run_git_tokens where run_id = $1", [run.id]);
        expect(stored.rows).toHaveLength(2);
        expect(JSON.stringify(stored.rows)).not.toContain("glpat-run");
        const s = w.sendRun({
          type: "run_result",
          runId: run.id,
          attempt: 1,
          exit: 0,
          headSha: sha,
          report: { commitCount: 1, changedFiles: ["src/a.ts"] },
        });
        await w.next("ack", (a) => a.uptoSeq === s);
        const ids = stored.rows.map((r) => r.external_id as string);
        await until(async () => ids.every((id) => revoked.includes(id)));
        const open = () =>
          admin.query("select 1 from hive.run_git_tokens where run_id = $1 and revoked_at is null", [run.id]);
        await until(async () => (await open()).rows.length === 0);
      } finally {
        await w.close();
      }
    });

    it("bắt buộc mà cấp lỗi lúc nhận lease: huỷ trên máy, run về hàng đợi", async () => {
      gitlabTokens(true);
      await setPolicy({ git: { requireRunGitToken: true } });
      const m = await seedMachine(`git-fail-${tag}`);
      const w = await FakeWorker.connect({ ...m, capabilities: [RUN_GIT_TOKEN_CAPABILITY] });
      try {
        const task = await newTask("Cấp token lỗi");
        const run = await startRun(task.id);
        await w.next("job_offer", (o) => o.runId === run.id);
        w.send({ type: "job_accept", runId: run.id, attempt: 1 });
        await w.next("cancel", (c) => c.runId === run.id);
        expect(w.has("lease")).toBe(false);
        const row = await runRow(run.id);
        expect([row.state, row.machine_id]).toEqual(["queued", null]);
        expect(await taskStatus(task.id)).toBe("queued");
        expect((await policyEvents(run.id)).map((e) => e.type)).toEqual(["policy_git_token"]);
        const leases = await admin.query("select 1 from hive.run_leases where run_id = $1", [run.id]);
        expect(leases.rows).toHaveLength(0);
      } finally {
        await w.close();
        await setPolicy({});
      }
    });

    it("không bắt buộc mà kết nối không cấp được: lease báo git null, máy dùng thông tin git của máy", async () => {
      await setPolicy({});
      const m = await seedMachine(`git-null-${tag}`);
      const w = await FakeWorker.connect(m);
      try {
        const run = await startRun((await newTask("Không token git")).id);
        await w.next("job_offer", (o) => o.runId === run.id);
        w.send({ type: "job_accept", runId: run.id, attempt: 1 });
        const lease = await w.next("lease", (l) => l.runId === run.id);
        expect(lease.git).toBeNull();
      } finally {
        await w.close();
      }
    });

    it("bắt buộc: không giao cho worker cũ chưa khai run_git_token, báo cần cập nhật worker", async () => {
      gitlabTokens();
      await setPolicy({ git: { requireRunGitToken: true } });
      const m = await seedMachine(`git-old-${tag}`);
      const w = await FakeWorker.connect(m);
      try {
        const run = await startRun((await newTask("Worker cũ")).id);
        await new Promise((r) => setTimeout(r, 800));
        expect(w.has("job_offer")).toBe(false);
        const waiting = await admin.query(
          "select data from hive.run_events where run_id = $1 and type = 'waiting_machine'",
          [run.id],
        );
        expect(waiting.rows[0]?.data.message).toContain("worker dùng được token");
      } finally {
        await w.close();
        await setPolicy({});
      }
    });

    it("không bắt buộc: worker cũ nhận lease không có token, hub không cấp token thừa", async () => {
      gitlabTokens();
      await setPolicy({});
      const m = await seedMachine(`git-skip-${tag}`);
      const w = await FakeWorker.connect(m);
      try {
        const before = issued;
        const run = await startRun((await newTask("Worker cũ không bắt buộc")).id);
        await w.next("job_offer", (o) => o.runId === run.id);
        w.send({ type: "job_accept", runId: run.id, attempt: 1 });
        const lease = await w.next("lease", (l) => l.runId === run.id);
        expect(lease.git).toBeNull();
        expect(issued).toBe(before);
      } finally {
        await w.close();
      }
    });

    it("job_accept gửi lại khi run đang chạy mà cấp token lỗi: không huỷ, run vẫn chạy", async () => {
      gitlabTokens();
      await setPolicy({ git: { requireRunGitToken: true } });
      const m = await seedMachine(`git-resend-${tag}`);
      const w = await FakeWorker.connect({ ...m, capabilities: [RUN_GIT_TOKEN_CAPABILITY] });
      try {
        const run = await startRun((await newTask("Gửi lại accept")).id);
        await w.next("job_offer", (o) => o.runId === run.id);
        w.send({ type: "job_accept", runId: run.id, attempt: 1 });
        await w.next("lease", (l) => l.runId === run.id);
        const s = w.sendRun({
          type: "run_event",
          runId: run.id,
          attempt: 1,
          event: "phase",
          data: { phase: "running" },
        });
        await w.next("ack", (a) => a.uptoSeq === s);
        expect((await runRow(run.id)).state).toBe("running");
        gitlabTokens(true);
        w.send({ type: "job_accept", runId: run.id, attempt: 1 });
        await new Promise((r) => setTimeout(r, 800));
        expect(w.has("cancel")).toBe(false);
        expect((await runRow(run.id)).state).toBe("running");
      } finally {
        await w.close();
        await setPolicy({});
      }
    });
  });
});

describe("run kiểm tài liệu (gate AI của quy trình duyệt)", () => {
  it("chỉ giao cho máy khai doccheck, run chỉ đọc nộp điểm rồi gate AI đi tiếp", async () => {
    await admin.query("update hive.runs set state = 'cancelled' where org_id = $1 and state = 'queued'", [org.orgId]);
    const projectKey = (await admin.query("select key from hive.projects where id = $1", [projectId])).rows[0]
      .key as string;
    const key = `project/${projectKey}/prd-ai`;
    await admin.query(
      `insert into hive.review_workflows (org_id, team_id, name, preset, doc_prefixes, phases, updated_by)
       values ($1, $2, 'PRD có AI', 'custom', $3, $4, 'seed')`,
      [
        org.orgId,
        org.teamId,
        [`project/${projectKey}/prd`],
        JSON.stringify([
          {
            name: "Inception",
            outputs: [],
            gates: [
              {
                id: "ai",
                name: "AI kiểm đủ mục",
                kind: "ai",
                ai: { checks: ["Mỗi yêu cầu có tiêu chí"], passScore: 7 },
                conditions: { docTypes: [], keywords: [], minChangedLines: null, skipFormattingOnly: false },
                slaHours: null,
                onReject: "author",
                onPass: "next",
              },
              {
                id: "po",
                name: "PO duyệt",
                kind: "human",
                reviewers: { users: [], roles: ["team-admin"], quorum: 1 },
                conditions: { docTypes: [], keywords: [], minChangedLines: null, skipFormattingOnly: false },
                slaHours: 24,
                onReject: "author",
                onPass: "next",
              },
            ],
          },
        ]),
      ],
    );
    const instanceId = await withTenant(pool, { userId: org.user("tadmin"), orgId: org.orgId }, async (tx) => {
      const d = await saveDoc(
        tx,
        { kind: "user", userId: org.user("tadmin") },
        { key, title: "PRD", content: "# PRD\n", baseVersion: 0 },
      );
      const p = await proposeWithReview(
        tx,
        { kind: "user", userId: org.user("tadmin") },
        { kind: "doc", key, content: "# PRD\n\n- R-1: Hoàn tiền\n", baseVersion: d.version, reason: "thêm R-1" },
        {},
      );
      const { rows } = await tx.$client.query("select id from hive.review_instances where proposal_id = $1", [p.id]);
      return rows[0].id as string;
    });
    const old = await FakeWorker.connect(await seedMachine(`dc-old-${tag}`));
    await engine.startDocCheck(org.orgId, instanceId);
    const { rows } = await admin.query("select * from hive.runs where branch = $1", [`doccheck/${instanceId}`]);
    const run = rows[0];
    expect(run).toMatchObject({ kind: "doccheck", task_id: null, state: "queued" });
    // Worker cũ (không khai doccheck) sẽ chạy run như run code có quyền ghi: không được giao.
    await new Promise((r) => setTimeout(r, 800));
    expect(old.has("job_offer")).toBe(false);
    const m = await seedMachine(`dc-new-${tag}`);
    const w = await FakeWorker.connect({ ...m, capabilities: ["doccheck"] });
    const offer = await w.next("job_offer", (o) => o.runId === run.id);
    expect(offer.spec).toMatchObject({ kind: "doccheck", cli: "claude", taskId: null });
    expect(String(offer.spec.prompt)).toContain("Mỗi yêu cầu có tiêu chí");
    expect(String(offer.spec.prompt)).toContain("R-1: Hoàn tiền");
    w.send({ type: "job_accept", runId: run.id, attempt: 1 });
    await w.next("lease", (l) => l.runId === run.id);
    // Agent gọi doc_check_submit (tool MCP đã có test riêng): ghi thẳng sự kiện như tool ghi.
    await admin.query(
      `insert into hive.run_events (org_id, run_id, attempt, seq, type, data) values ($1, $2, 1, null, 'doccheck_result', $3)`,
      [
        org.orgId,
        run.id,
        JSON.stringify({
          score: 8,
          checklist: [{ label: "Mỗi yêu cầu có tiêu chí", passed: true, note: null }],
          summary: "Ổn",
        }),
      ],
    );
    w.sendRun({ type: "run_result", runId: run.id, attempt: 1, exit: 0, headSha: null, report: null });
    await until(async () => (await runRow(run.id)).state === "succeeded", 15_000);
    const inst = (await admin.query("select gate_index, status from hive.review_instances where id = $1", [instanceId]))
      .rows[0];
    expect(inst).toMatchObject({ gate_index: 1, status: "in_review" });
    const gate = (
      await admin.query(
        "select status, score, run_id from hive.review_gate_runs where instance_id = $1 and gate_index = 0",
        [instanceId],
      )
    ).rows[0];
    expect(gate).toMatchObject({ status: "passed", score: 8, run_id: run.id });
    await Promise.all([old.close(), w.close()]);
  });
});

describe("run trợ lý tài liệu (DOC-05)", () => {
  it("chạy trên máy của chính người nhờ, chỉ máy khai docassist; xong thì có tóm tắt và số đề xuất", async () => {
    await admin.query("update hive.runs set state = 'cancelled' where org_id = $1 and state = 'queued'", [org.orgId]);
    const projectKey = (await admin.query("select key from hive.projects where id = $1", [projectId])).rows[0]
      .key as string;
    const key = `project/${projectKey}/prd-assist`;
    const me = org.user("tadmin");
    const as = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(pool, { userId: me, orgId: org.orgId }, fn);
    await as((tx) =>
      saveDoc(
        tx,
        { kind: "user", userId: me },
        { key, title: "PRD", content: "# PRD\n\n- R-1: Hoàn tiền\n", baseVersion: 0 },
      ),
    );
    const assist = engine.docAssist;
    // Máy của người khác trong đội, và máy của mình nhưng worker cũ: đều không chạy được.
    const others = await seedMachine(`da-other-${tag}`);
    await admin.query("update hive.machines set registered_by = $2, capabilities = '{docassist}' where id = $1", [
      others.id,
      org.user("tmember"),
    ]);
    const old = await seedMachine(`da-old-${tag}`);
    await admin.query("update hive.machines set registered_by = $2 where id = $1", [old.id, me]);
    const wOther = await FakeWorker.connect({ ...others, capabilities: ["docassist"] });
    const wOld = await FakeWorker.connect(old);
    await until(async () => (await as((tx) => assist.targets(tx, me))).some((t) => t.online));
    expect(await as((tx) => assist.targets(tx, me))).toEqual([
      expect.objectContaining({ machineId: old.id, online: true, ready: false }),
    ]);
    await expect(as((tx) => assist.start(tx, me, { key, action: "acceptance", cli: "claude" }))).rejects.toMatchObject({
      code: "ASSIST_NO_MACHINE",
    });

    const mine = await seedMachine(`da-mine-${tag}`);
    await admin.query("update hive.machines set registered_by = $2 where id = $1", [mine.id, me]);
    const w = await FakeWorker.connect({ ...mine, capabilities: ["docassist"] });
    await until(async () => (await as((tx) => assist.targets(tx, me))).some((t) => t.ready && t.online));
    const { assist: started, afterCommit } = await as((tx) =>
      assist.start(tx, me, { key, action: "acceptance", cli: "claude", prompt: "Viết theo Given/When/Then" }),
    );
    afterCommit();
    const offer = await w.next("job_offer", (o) => o.runId === started.runId);
    expect(offer.spec).toMatchObject({ kind: "docassist", cli: "claude", taskId: null });
    expect(String(offer.spec.prompt)).toContain("Soạn tiêu chí chấp nhận");
    expect(String(offer.spec.prompt)).toContain("Given/When/Then");
    expect(String(offer.spec.prompt)).toContain("R-1: Hoàn tiền");
    expect(wOther.has("job_offer")).toBe(false);
    expect(wOld.has("job_offer")).toBe(false);
    w.send({ type: "job_accept", runId: started.runId, attempt: 1 });
    await w.next("lease", (l) => l.runId === started.runId);
    // Agent gọi doc_suggest và doc_assist_submit (tool MCP có test riêng): ghi như tool ghi.
    await admin.query(
      `insert into hive.doc_suggestions (org_id, team_id, project_id, key, before, after, author_run_id)
       values ($1, $2, $3, $4, '', '- Given đơn trong 7 ngày', $5)`,
      [org.orgId, org.teamId, projectId, key, started.runId],
    );
    await admin.query(
      `insert into hive.run_events (org_id, run_id, attempt, seq, type, data) values ($1, $2, 1, null, 'docassist_result', $3)`,
      [org.orgId, started.runId, JSON.stringify({ summary: "Thêm tiêu chí cho R-1" })],
    );
    w.sendRun({ type: "run_result", runId: started.runId, attempt: 1, exit: 0, headSha: null, report: null });
    await until(async () => (await runRow(started.runId)).state === "succeeded", 15_000);
    expect(await as((tx) => assist.list(tx, me, key))).toEqual([
      expect.objectContaining({
        runId: started.runId,
        action: "acceptance",
        machine: mine.name,
        state: "succeeded",
        prompt: "Viết theo Given/When/Then",
        summary: "Thêm tiêu chí cho R-1",
        suggestions: 1,
        comments: 0,
      }),
    ]);
  });
});

describe("máy cá nhân và máy dùng chung (ADR 0017)", () => {
  it("run của một người chỉ chạy trên máy của chính họ, không chạy trên máy cá nhân của người khác", async () => {
    const others = await seedMachine(`own-other-${tag}`, ["claude"], 1, org.user("tmember"));
    const mine = await seedMachine(`own-mine-${tag}`, ["claude"], 1, devUserId);
    const wOther = await FakeWorker.connect(others);
    const task = await newTask("Việc của dev");
    const run = await startRun(task.id);
    await new Promise((r) => setTimeout(r, 800));
    expect(wOther.has("job_offer")).toBe(false);
    expect((await runRow(run.id)).owner_user_id).toBe(devUserId);
    const wMine = await FakeWorker.connect(mine);
    const offer = await wMine.next("job_offer", (o) => o.runId === run.id);
    expect(offer.runId).toBe(run.id);
    expect(wOther.has("job_offer")).toBe(false);
    await api("POST", `/v1/runs/${run.id}/cancel`);
  });

  it("run của đội (không có chủ) chờ máy dùng chung và nói rõ vì sao", async () => {
    const personal = await seedMachine(`team-personal-${tag}`, ["claude"], 1, devUserId);
    const wPersonal = await FakeWorker.connect(personal);
    const task = await newTask("Việc từ webhook");
    const project = await withTenant(pool, { orgId: org.orgId }, (tx) => loadProject(tx, projectId));
    const queued = await withTenant(pool, { orgId: org.orgId }, async (tx) => {
      const t = await loadTask(tx, task.id);
      if (!t || !project) throw new Error("thiếu task hoặc dự án");
      return engine.queueRun(tx, t, project, { cli: null, createdBy: "github:octocat", actorUserId: null });
    });
    queued.afterCommit();
    const runId = queued.row.id;
    await until(async () => {
      const { rows } = await admin.query(
        "select 1 from hive.run_events where run_id = $1 and type = 'waiting_machine'",
        [runId],
      );
      return rows.length > 0;
    });
    expect(wPersonal.has("job_offer")).toBe(false);
    const { rows } = await admin.query(
      "select data from hive.run_events where run_id = $1 and type = 'waiting_machine'",
      [runId],
    );
    expect(String(rows[0].data.message)).toContain("máy dùng chung");
    const shared = await seedMachine(`team-shared-${tag}`);
    const wShared = await FakeWorker.connect(shared);
    expect((await wShared.next("job_offer", (o) => o.runId === runId)).runId).toBe(runId);
    await api("POST", `/v1/runs/${runId}/cancel`);
  });

  it("chọn máy cá nhân của người khác bị từ chối; chỉ quản trị đội bật được dùng chung", async () => {
    const others = await seedMachine(`pick-other-${tag}`, ["claude"], 1, org.user("tmember"));
    const task = await newTask("Chọn máy");
    const res = await api<{ data?: { code: string } }>("POST", "/v1/runs", { taskId: task.id, machineId: others.id });
    expect(res.status).toBe(403);
    expect(res.data.data?.code).toBe("MACHINE_NOT_YOURS");
    // Dev là thành viên, không phải quản trị đội.
    const denied = await api("POST", `/v1/machines/${others.id}/shared`, { shared: true });
    expect(denied.status).toBe(403);
    const shared = await withTenant(pool, { userId: org.user("tadmin"), orgId: org.orgId }, (tx) =>
      setMachineShared(tx, org.user("tadmin"), others.id, true),
    );
    expect(shared).toMatchObject({ shared: true, registeredBy: org.user("tmember") });
    const again = await api<{ id: string }>("POST", "/v1/runs", { taskId: task.id, machineId: others.id });
    expect(again.status, JSON.stringify(again.data)).toBe(200);
    await api("POST", `/v1/runs/${again.data.id}/cancel`);
  });
});

describe("brief của dự án và khảo sát trước khi sửa (ADR 0022)", () => {
  let briefProject = "";
  let briefKey = "";
  const baseSha = "a".repeat(40);
  const laterSha = "b".repeat(40);

  beforeAll(async () => {
    await admin.query("update hive.runs set state = 'cancelled' where org_id = $1 and state = 'queued'", [org.orgId]);
    briefKey = `br-${tag}`;
    briefProject = (
      await seedProject(admin, pool, {
        orgId: org.orgId,
        teamId: org.teamId,
        systemId: org.systemId,
        adminUserId: org.user("admin"),
        masterKey,
        key: briefKey,
      })
    ).projectId;
  });

  const briefRuns = async () =>
    (
      await admin.query("select id, state, owner_user_id from hive.runs where project_id = $1 and kind = 'brief'", [
        briefProject,
      ])
    ).rows as Array<{ id: string; state: string; owner_user_id: string | null }>;

  it("không máy nào làm được brief thì giao run code không xếp run brief", async () => {
    const m = await seedMachine(`br-old-${tag}`);
    const w = await FakeWorker.connect(m);
    const task = await newTask("Chưa có brief", { projectId: briefProject });
    const run = await startRun(task.id);
    const offer = await w.next("job_offer", (o) => o.runId === run.id);
    // Chưa có brief: chỉ có chỉ dẫn khảo sát, spec không mang commit của brief.
    expect(String(offer.spec.prompt)).toMatch(/^# Cách khảo sát repo/);
    expect(String(offer.spec.prompt)).toContain("memory_search");
    expect(String(offer.spec.prompt)).toContain("memory_write");
    expect(offer.spec.brief).toBeUndefined();
    expect(await briefRuns()).toEqual([]);
    await api("POST", `/v1/runs/${run.id}/cancel`);
    await w.close();
  });

  it("Làm mới: run brief chỉ đọc bằng sonnet trên máy khai brief; nộp xong thì brief có version và commit", async () => {
    const m = await seedMachine(`br-${tag}`, ["claude"], 2);
    const w = await FakeWorker.connect({ ...m, capabilities: ["brief"] });
    const res = await api<{ runId: string }>("POST", "/v1/briefs/refresh", { project: briefKey });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    // Bấm lần nữa khi run còn sống thì trả lại đúng run đó.
    expect((await api<{ runId: string }>("POST", "/v1/briefs/refresh", { project: briefKey })).data.runId).toBe(
      res.data.runId,
    );
    const offer = await w.next("job_offer", (o) => o.runId === res.data.runId);
    expect(offer.spec).toMatchObject({ kind: "brief", cli: "claude", model: "sonnet", taskId: null });
    expect(String(offer.spec.prompt)).toContain("brief_submit");
    expect(String(offer.spec.prompt)).not.toContain("# Cách khảo sát repo");
    expect((await runRow(res.data.runId)).owner_user_id).toBe(devUserId);
    w.send({ type: "job_accept", runId: res.data.runId, attempt: 1 });
    await w.next("lease", (l) => l.runId === res.data.runId);
    // Agent gọi brief_submit (tool MCP chỉ ghi sự kiện, như các tool nộp kết quả khác).
    await admin.query(
      `insert into hive.run_events (org_id, run_id, attempt, seq, type, data) values ($1, $2, 1, null, 'brief_report', $3)`,
      [org.orgId, res.data.runId, JSON.stringify({ content: "# Brief\n\nHub ở apps/hub.", commitSha: baseSha })],
    );
    w.sendRun({ type: "run_result", runId: res.data.runId, attempt: 1, exit: 0, headSha: null, report: null });
    await until(async () => (await runRow(res.data.runId)).state === "succeeded", 15_000);
    const brief = await api<ProjectBrief>("GET", `/v1/briefs?project=${briefKey}`);
    expect(brief.data).toMatchObject({
      projectId: briefProject,
      content: "# Brief\n\nHub ở apps/hub.",
      version: 1,
      commitSha: baseSha,
      source: "agent",
      updatedBy: { userId: null, runId: res.data.runId },
      commitsBehind: 0,
      refreshRunId: null,
    });
    // Sửa tay với phiên bản cũ thì CONFLICT, không ghi đè brief agent vừa viết.
    const stale = await api<{ data?: { code: string } }>("POST", "/v1/briefs", {
      project: briefKey,
      content: "Bản cũ",
      baseVersion: 0,
    });
    expect(stale.status).toBe(409);
    await w.close();
  });

  it("run code nhận brief đầu prompt, báo khảo sát và độ lệch; lệch quá ngưỡng thì xếp run brief mới", async () => {
    const m = await seedMachine(`br-code-${tag}`, ["claude"], 2);
    const w = await FakeWorker.connect({ ...m, capabilities: ["brief"] });
    const task = await newTask("Có brief", { projectId: briefProject });
    const run = await startRun(task.id);
    // Brief vừa viết (0 commit, hôm nay) nên giao run code không làm mới.
    expect((await briefRuns()).filter((r) => r.state === "queued")).toEqual([]);
    const offer = await w.next("job_offer", (o) => o.runId === run.id);
    const prompt = String(offer.spec.prompt);
    expect(prompt).toMatch(/^# Brief của dự án \(bản tóm tắt repo, viết ở commit a{12}\)/);
    expect(prompt).toContain("Hub ở apps/hub.");
    expect(prompt.indexOf("Hub ở apps/hub.")).toBeLessThan(prompt.indexOf("Có brief"));
    expect(offer.spec.brief).toEqual({ sha: baseSha });
    w.send({ type: "job_accept", runId: run.id, attempt: 1 });
    await w.next("lease", (l) => l.runId === run.id);

    const send = async (data: Record<string, unknown>) => {
      const s = w.sendRun({ type: "run_event", runId: run.id, attempt: 1, event: "cost", data });
      await w.next("ack", (a) => a.runId === run.id && a.uptoSeq === s);
    };
    const usage = { inputTokens: 500, outputTokens: 50, cacheReadTokens: 9000, cacheWriteTokens: 100 };
    const usageEvent = { ...usage, costUsd: 0.2, turns: 9, model: null };
    await send({ ...usageEvent, explore: { edited: true, turns: 6, ...usage, inputTokens: 300 } });
    // Gói đến muộn mang số trước khi sửa: không ghi đè số đã chốt.
    await send({ ...usageEvent, explore: { edited: false, turns: 5, ...usage, inputTokens: 200 } });
    const view = await api<Run>("GET", `/v1/runs/${run.id}`);
    expect(view.data.explore).toEqual({ edited: true, turns: 6, ...usage, inputTokens: 300 });

    w.sendRun({
      type: "run_result",
      runId: run.id,
      attempt: 1,
      exit: 1,
      headSha: null,
      report: { repo: { baseSha: laterSha, briefBehind: 60 } },
    });
    await until(async () => (await briefRuns()).some((r) => r.state !== "succeeded"), 15_000);
    const brief = await api<ProjectBrief>("GET", `/v1/briefs?project=${briefKey}`);
    expect(brief.data).toMatchObject({ headSha: laterSha, commitsBehind: 60 });
    expect(brief.data.refreshRunId).toEqual(expect.any(String));
    // Run brief tự động đi bằng máy của người đã giao run code.
    expect((await briefRuns()).find((r) => r.id === brief.data.refreshRunId)?.owner_user_id).toBe(devUserId);

    const summary = await withTenant(pool, { userId: org.user("tadmin"), orgId: org.orgId }, (tx) =>
      costSummary(tx, org.user("tadmin"), {
        projectId: briefProject,
        from: new Date().toISOString().slice(0, 10),
        to: new Date().toISOString().slice(0, 10),
        groupBy: "cli",
      }),
    );
    expect(summary.explore).toMatchObject({ runs: 1, edited: 1, turns: 6, totalTurns: 9 });
    expect(summary.explore?.costShare).toBeGreaterThan(0);
    expect(summary.explore?.costShare).toBeLessThan(1);
    await admin.query("update hive.runs set state = 'cancelled' where project_id = $1 and state = 'queued'", [
      briefProject,
    ]);
    await w.close();
  });
});

describe("run đề xuất skill (specs/014)", () => {
  let learnProject = "";
  const proposalReport = {
    proposals: [{ kind: "new", name: "lam-tron-tien", description: "d", content: "c", reason: "r" }],
  };
  const createRun = (projectId: string, prompt = "Tóm tắt các run khó") =>
    withTenant(pool, { orgId: org.orgId }, (tx) =>
      engine.skillLearning.createRun(tx, { projectId, batchId: randomUUID(), prompt }),
    );

  beforeAll(async () => {
    await admin.query("update hive.runs set state = 'cancelled' where org_id = $1 and state = 'queued'", [org.orgId]);
    learnProject = (
      await seedProject(admin, pool, {
        orgId: org.orgId,
        teamId: org.teamId,
        systemId: org.systemId,
        adminUserId: org.user("admin"),
        masterKey,
        key: `sl-${tag}`,
      })
    ).projectId;
  });

  it("máy chưa khai skill_proposal thì không tạo run, để lô thử lại sau", async () => {
    const m = await seedMachine(`sl-old-${tag}`, ["claude"], 2);
    const w = await FakeWorker.connect({ ...m, capabilities: ["brief"] });
    expect(await createRun(learnProject)).toEqual({ ok: false, reason: "no_machine" });
    expect(
      (await admin.query("select 1 from hive.runs where project_id = $1 and kind = 'skill_proposal'", [learnProject]))
        .rowCount,
    ).toBe(0);
    await w.close();
  });

  it("giao cho máy đã khai: chỉ đọc, sonnet, effort medium, lời nhắc của lô; nộp xong thì succeeded", async () => {
    const m = await seedMachine(`sl-${tag}`, ["claude"], 2);
    const w = await FakeWorker.connect({ ...m, capabilities: ["skill_proposal"] });
    const started = await createRun(learnProject, "Các việc khó của dự án");
    if (!started.ok) throw new Error(started.reason);
    started.afterCommit();
    const offer = await w.next("job_offer", (o) => o.runId === started.runId);
    expect(offer.spec).toMatchObject({
      kind: "skill_proposal",
      cli: "claude",
      model: "sonnet",
      effort: "medium",
      taskId: null,
      prompt: "Các việc khó của dự án",
    });
    expect((await runRow(started.runId)).owner_user_id).toBeNull();
    w.send({ type: "job_accept", runId: started.runId, attempt: 1 });
    await w.next("lease", (l) => l.runId === started.runId);
    await admin.query(
      `insert into hive.run_events (org_id, run_id, attempt, seq, type, data) values ($1, $2, 1, null, 'skill_proposal_report', $3)`,
      [org.orgId, started.runId, JSON.stringify(proposalReport)],
    );
    w.sendRun({ type: "run_result", runId: started.runId, attempt: 1, exit: 0, headSha: null, report: null });
    await until(async () => (await runRow(started.runId)).state === "succeeded", 15_000);
    await w.close();
  });

  it("agent thoát êm mà không nộp thì run failed", async () => {
    const m = await seedMachine(`sl2-${tag}`, ["claude"], 2);
    const w = await FakeWorker.connect({ ...m, capabilities: ["skill_proposal"] });
    const started = await createRun(learnProject);
    if (!started.ok) throw new Error(started.reason);
    started.afterCommit();
    await w.next("job_offer", (o) => o.runId === started.runId);
    w.send({ type: "job_accept", runId: started.runId, attempt: 1 });
    await w.next("lease", (l) => l.runId === started.runId);
    w.sendRun({ type: "run_result", runId: started.runId, attempt: 1, exit: 0, headSha: null, report: null });
    await until(async () => (await runRow(started.runId)).state === "failed", 15_000);
    await w.close();
  });
});

describe("quy trình review code (specs/009)", () => {
  let crProject = "";
  let crKey = "";
  let workflowId = "";

  beforeAll(async () => {
    await admin.query("update hive.runs set state = 'cancelled' where org_id = $1 and state = 'queued'", [org.orgId]);
    crKey = `cr-${tag}`;
    const p = await seedProject(admin, pool, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: crKey,
    });
    crProject = p.projectId;
    provider.seedRepo({ owner: p.owner, name: p.repo });
    const phases = [
      {
        name: "Review",
        gates: [
          {
            id: "rules",
            name: "Quy tắc",
            kind: "rule",
            rules: ["max-files", "command"],
            commands: [{ run: "pnpm test", timeoutSec: 300 }],
            maxFiles: 5,
            slaHours: null,
          },
          {
            id: "lead",
            name: "Người duyệt",
            kind: "human",
            reviewers: { users: [], roles: ["team-member"], teams: [], quorum: 1, allowRequester: false },
            slaHours: 24,
          },
        ],
      },
    ];
    // Lưu đúng dạng saveWorkflow ghi: đã qua zod (giá trị mặc định đầy đủ).
    const w = workflowInput.parse({
      name: "Code dự án CR",
      preset: "custom",
      subject: "code",
      teamId: org.teamId,
      docPrefixes: [],
      code: { projects: [crKey] },
      phases,
      enabled: true,
    });
    const { rows } = await admin.query(
      `insert into hive.review_workflows (org_id, team_id, name, preset, subject, doc_prefixes, code, phases, enabled)
       values ($1, $2, 'Code dự án CR', 'custom', 'code', '{}', $3, $4, true) returning id`,
      [org.orgId, org.teamId, JSON.stringify(w.code), JSON.stringify(w.phases)],
    );
    workflowId = rows[0].id;
  });

  afterAll(async () => {
    await admin.query("delete from hive.review_workflows where id = $1", [workflowId]);
  });

  const reviewOf = async (runId: string) =>
    (await admin.query("select * from hive.code_reviews where run_id = $1", [runId])).rows[0];

  it("run khớp quy trình: kết luận ngay, mở phiên trong cùng transaction; checkpoint quy tắc dùng bằng chứng của run", async () => {
    const w = await FakeWorker.connect(await seedMachine(`cr-${tag}`));
    const task = await newTask("Sửa thanh toán", { projectId: crProject });
    const run = await startRun(task.id);
    const offer = await w.next("job_offer", (o) => o.runId === run.id);
    expect(offer.spec.checks).toEqual({ commands: [{ run: "pnpm test", timeoutSec: 300 }] });
    w.send({ type: "job_accept", runId: run.id, attempt: 1 });
    await w.next("lease", (l) => l.runId === run.id);
    const commands = [{ run: "pnpm test", exit: 0, durationMs: 1200, tail: "ok" }];
    w.sendRun({
      type: "run_result",
      runId: run.id,
      attempt: 1,
      exit: 0,
      headSha: sha,
      report: { commitCount: 1, changedFiles: ["src/pay.ts", "src/pay.test.ts"], commands },
      diffStats: { addedLines: 30, deletedLines: 4, changedFiles: ["src/pay.ts", "src/pay.test.ts"] },
    });
    await until(async () => (await runRow(run.id)).state === "succeeded");
    const row = await runRow(run.id);
    expect(row.pr_url).toMatch(/\/pull\/\d+$/);
    expect(await taskStatus(task.id)).toBe("review");

    const review = await reviewOf(run.id);
    expect(review).toMatchObject({
      workflow_id: workflowId,
      workflow_name: "Code dự án CR",
      status: "in_review",
      head_sha: sha,
      pr_url: row.pr_url,
      branch: `ai/${task.key}`,
      base_branch: "main",
      requester_user_id: devUserId,
      changed_files: 2,
      gate_index: 1,
    });
    // Các checkpoint mở trong cùng transaction có started_at bằng nhau, nên xếp theo vị trí trong quy trình.
    const { rows: gates } = await admin.query(
      "select gate_id, status from hive.code_review_gate_runs where review_id = $1 order by gate_index, started_at",
      [review.id],
    );
    expect(gates).toEqual([
      { gate_id: "rules", status: "passed" },
      { gate_id: "lead", status: "waiting" },
    ]);
    const { rows: events } = await admin.query("select data from hive.run_events where run_id = $1 and type = $2", [
      run.id,
      "code_review",
    ]);
    expect(events[0]?.data).toMatchObject({ reviewId: review.id, workflowId, round: 1 });
    const { rows: audit } = await admin.query(
      "select data from hive.audit_log where target_id = $1 and action = 'run.finish'",
      [run.id],
    );
    expect(audit[0]?.data).toMatchObject({ workflowId, codeReviewId: review.id });

    // Bằng chứng mà checkpoint quy tắc đọc lại: số liệu, kết quả lệnh kiểm, loại task của lần thử cuối.
    const evidence = await withTenant(pool, { orgId: org.orgId }, (tx) => engine.runEvidence(tx, run.id));
    expect(evidence).toEqual({
      headSha: sha,
      taskType: null,
      stats: { addedLines: 30, deletedLines: 4, changedFiles: ["src/pay.ts", "src/pay.test.ts"] },
      commands,
      hasAgentReport: false,
    });
    await w.close();
  });

  it("gộp lệnh quy trình và outcome, không chạy trùng và giữ thời hạn chặt nhất", async () => {
    const outcome = [
      { check: "changes", required: true },
      { check: "command", required: true, run: "pnpm test", timeout: "15m" },
      { check: "command", required: true, run: "pnpm lint", timeout: "2m" },
    ];
    await admin.query(
      "update hive.projects set settings = jsonb_set(settings, '{outcome,default}', $2) where id = $1",
      [crProject, JSON.stringify(outcome)],
    );
    let runId = "";
    try {
      const w = await FakeWorker.connect(await seedMachine(`combine-${tag}`));
      const task = await newTask("Gộp lệnh kiểm", { projectId: crProject });
      const run = await startRun(task.id);
      runId = run.id;
      const offer = await w.next("job_offer", (o) => o.runId === run.id);
      expect(offer.spec.checks).toEqual({
        commands: [
          { run: "pnpm test", timeoutSec: 300 },
          { run: "pnpm lint", timeoutSec: 120 },
        ],
      });
      await w.close();
    } finally {
      await admin.query("update hive.runs set state = 'cancelled' where id = $1", [runId]);
      await admin.query(
        "update hive.projects set settings = jsonb_set(settings, '{outcome,default}', $2) where id = $1",
        [crProject, JSON.stringify(defaultProjectSettings().outcome.default)],
      );
    }
  });

  it.each([
    { exit: undefined, status: "waiting" },
    { exit: 1, status: "failed" },
    { exit: null, status: "failed" },
  ])("checkpoint command: kết quả $exit → $status", async ({ exit, status }) => {
    const w = await FakeWorker.connect(await seedMachine(`gatecmd-${randomUUID().slice(0, 6)}`));
    const task = await newTask("Kiểm tra lệnh của checkpoint", { projectId: crProject });
    const run = await startRun(task.id);
    const offer = await w.next("job_offer", (o) => o.runId === run.id);
    expect(offer.spec.checks).toEqual({ commands: [{ run: "pnpm test", timeoutSec: 300 }] });
    w.send({ type: "job_accept", runId: run.id, attempt: 1 });
    await w.next("lease", (l) => l.runId === run.id);
    w.sendRun({
      type: "run_result",
      runId: run.id,
      attempt: 1,
      exit: 0,
      headSha: sha,
      report: {
        commitCount: 1,
        changedFiles: ["src/a.ts"],
        ...(exit === undefined ? {} : { commands: [{ run: "pnpm test", exit, durationMs: 1200, tail: "lỗi" }] }),
      },
      diffStats: { addedLines: 1, deletedLines: 0, changedFiles: ["src/a.ts"] },
    });
    await until(async () => (await runRow(run.id)).state === "succeeded");
    const review = await reviewOf(run.id);
    expect(review.gate_index).toBe(0);
    const { rows } = await admin.query("select status, note from hive.code_review_gate_runs where review_id = $1", [
      review.id,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(status);
    if (exit === undefined) expect(rows[0].note).toContain("Máy chưa hỗ trợ chạy lệnh kiểm");
    await w.close();
  });

  it("quy trình không khớp loại task không gửi lệnh của nó", async () => {
    await admin.query(
      "update hive.review_workflows set code = jsonb_set(code, '{taskTypes}', '[\"docs\"]') where id = $1",
      [workflowId],
    );
    let runId = "";
    try {
      const w = await FakeWorker.connect(await seedMachine(`scope-command-${tag}`));
      const task = await newTask("Task ngoài phạm vi quy trình", { projectId: crProject, type: "code" });
      const run = await startRun(task.id);
      runId = run.id;
      expect((await w.next("job_offer", (o) => o.runId === run.id)).spec.checks).toBeUndefined();
      await w.close();
    } finally {
      if (runId) await admin.query("update hive.runs set state = 'cancelled' where id = $1", [runId]);
      await admin.query("update hive.review_workflows set code = jsonb_set(code, '{taskTypes}', '[]') where id = $1", [
        workflowId,
      ]);
    }
  });

  it("run sửa theo góp ý (queueFixRun): run code mới cùng task, CLI, chủ; không lập kế hoạch; mang góp ý vào prompt", async () => {
    await admin.query(
      "update hive.projects set settings = jsonb_set(settings, '{features,planMode}', 'true') where id = $1",
      [crProject],
    );
    try {
      const w = await FakeWorker.connect(await seedMachine(`fix-${tag}`, ["claude", "codex"]));
      const task = await newTask("Sửa hoá đơn", { projectId: crProject });
      const { rows } = await admin.query(
        `insert into hive.runs (org_id, team_id, task_id, project_id, kind, cli, model, branch, policy_snapshot, created_by, owner_user_id, state, head_sha)
         values ($1, $2, $3, $4, 'code', 'codex', 'gpt-5', $5, '[]', $6, $6, 'succeeded', $7) returning id`,
        [org.orgId, org.teamId, task.id, crProject, `ai/${task.key}`, devUserId, sha],
      );
      const original = rows[0].id as string;
      const fix = await withTenant(pool, { orgId: org.orgId }, (tx) =>
        engine.queueFixRun(tx, {
          reviewId: randomUUID(),
          workflowId,
          runId: original,
          instructions: "Thêm test cho làm tròn âm.",
        }),
      );
      const fixRow = await runRow(fix.runId);
      expect(fixRow).toMatchObject({
        kind: "code",
        task_id: task.id,
        cli: "codex",
        model: "gpt-5",
        branch: `ai/${task.key}`,
        created_by: `workflow:${workflowId}`,
        owner_user_id: devUserId,
        parent_run_id: null,
        state: "queued",
      });
      // Hẹn giờ `dispatch` giao run sau khi transaction của phiên commit.
      const offer = await w.next("job_offer", (o) => o.runId === fix.runId);
      expect(offer.spec).toMatchObject({ kind: "code", cli: "codex", instructions: ["Thêm test cho làm tròn âm."] });
      expect(offer.spec.checks).toEqual({ commands: [{ run: "pnpm test", timeoutSec: 300 }] });
      expect(String(offer.spec.prompt)).toContain("Thêm test cho làm tròn âm.");
      w.send({ type: "job_reject", runId: fix.runId, attempt: 1, reason: "test" });
      await w.close();
    } finally {
      await admin.query(
        "update hive.projects set settings = jsonb_set(settings, '{features,planMode}', 'false') where id = $1",
        [crProject],
      );
      await admin.query(
        "update hive.runs set state = 'cancelled' where project_id = $1 and state not in ('succeeded', 'failed', 'cancelled', 'needs_review', 'no_changes')",
        [crProject],
      );
    }
  });

  it("không có quy trình khớp (quy trình tắt): như cũ, không mở phiên", async () => {
    await admin.query("update hive.review_workflows set enabled = false where id = $1", [workflowId]);
    try {
      const w = await FakeWorker.connect(await seedMachine(`nocr-${tag}`));
      const task = await newTask("Không có quy trình", { projectId: crProject });
      const run = await startRun(task.id);
      const offer = await w.next("job_offer", (o) => o.runId === run.id);
      expect(offer.spec.checks).toBeUndefined();
      w.send({ type: "job_accept", runId: run.id, attempt: 1 });
      await w.next("lease", (l) => l.runId === run.id);
      w.sendRun({
        type: "run_result",
        runId: run.id,
        attempt: 1,
        exit: 0,
        headSha: sha,
        report: { commitCount: 1, changedFiles: ["src/a.ts"] },
      });
      await until(async () => (await runRow(run.id)).state === "succeeded");
      expect(await reviewOf(run.id)).toBeUndefined();
      const { rows } = await admin.query("select 1 from hive.run_events where run_id = $1 and type = 'code_review'", [
        run.id,
      ]);
      expect(rows).toHaveLength(0);
      await w.close();
    } finally {
      await admin.query("update hive.review_workflows set enabled = true where id = $1", [workflowId]);
    }
  });
});
