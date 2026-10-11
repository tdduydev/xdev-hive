// Luồng trọn của run: hub thật trên cổng ngẫu nhiên, client `ws` đóng vai worker Go, GitProvider giả trong bộ nhớ.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Run, Task } from "@xdev-hive/contracts";
import { type HubToWorker, hubToWorker, PROTOCOL_VERSION } from "@xdev-hive/contracts/worker-protocol";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import WebSocket from "ws";
import { type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import { seedProject } from "../test/project-fixture.ts";
import { createApp } from "./app.ts";
import { attachWorkerGateway, registerRunHandlers } from "./modules/fleet/index.ts";
import { createAuth } from "./modules/identity/index.ts";
import { createPool, parseMasterKey } from "./modules/platform/index.ts";
import {
  createRunsEngine,
  createRunTokenVerifier,
  parseCursor,
  RunNotifier,
  type RunsEngine,
} from "./modules/runs/index.ts";
import { createMemoryProvider, type MemoryProvider, type ProviderFactory } from "./modules/scm/index.ts";

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

beforeAll(async () => {
  org = await seedOrg(admin, `runs-${tag}`);
  const project = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: `hd-${tag}`,
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
  const userId = ((await res.json()) as { user: { id: string } }).user.id;
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
async function seedMachine(name: string, clis: string[] = ["claude"], capacity = 1) {
  const token = `hwm_${randomBytes(32).toString("base64url")}`;
  const { rows } = await admin.query(
    "insert into hive.machines (org_id, team_id, name, os, version, clis, capacity) values ($1, $2, $3, 'linux', '1', $4, $5) returning id",
    [org.orgId, org.teamId, name, clis, capacity],
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

  static async connect(m: { name: string; token: string; clis: string[]; capacity: number }) {
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
      repoUrl: expect.stringContaining("gitlab.com"),
    });
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
      data: { summary: "Đã sửa" },
    });
    await w.next("ack", (a) => a.uptoSeq === s3);
    const s4 = w.sendRun({
      type: "run_result",
      runId: run.id,
      attempt: 1,
      exit: 0,
      headSha: sha,
      report: { commitCount: 1, changedFiles: ["src/hoa-don.ts"] },
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
    await w.close();
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
