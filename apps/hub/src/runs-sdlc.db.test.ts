// Run `sdlc` và run code của task hạng mục qua hub thật (specs/011 T021): nhãn máy (SC-010), capability, cổng chặn
// (SC-001), kết luận run soạn. Client `ws` đóng vai worker Go, GitProvider giả trong bộ nhớ.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { defaultProjectSettings, projectSdlcSettings, type Task } from "@xdev-hive/contracts";
import { type HubToWorker, hubToWorker, PROTOCOL_VERSION } from "@xdev-hive/contracts/worker-protocol";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import WebSocket from "ws";
import { type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import { seedProject } from "../test/project-fixture.ts";
import { createApp } from "./app.ts";
import { loadProject } from "./modules/catalog/index.ts";
import { attachWorkerGateway, registerRunHandlers } from "./modules/fleet/index.ts";
import { createAuth } from "./modules/identity/index.ts";
import { editorState } from "./modules/knowledge/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "./modules/platform/index.ts";
import { createRunsEngine, type RunsEngine } from "./modules/runs/index.ts";
import { createMemoryProvider, type MemoryProvider, type ProviderFactory } from "./modules/scm/index.ts";
import { createItem } from "./modules/sdlc/index.ts";
import { loadTask } from "./modules/tasks/index.ts";

const { adminUrl, appUrl, authUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const authPool = createPool(authUrl);
const secret = "test-secret-0123456789abcdef-0123456789";
const publicUrl = "http://hub.test";
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

let org: OrgFixture & { user: (n: string) => string };
let projectId = "";
let projectKey = "";
let provider: MemoryProvider;
let engine: RunsEngine;
let server: Server;
let gateway: { close: () => Promise<void> };
let unregister: () => void;
let base = "";
let cookie = "";

beforeAll(async () => {
  org = await seedOrg(admin, `rsdlc-${tag}`);
  projectKey = `sd-${tag}`;
  const project = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: projectKey,
    settings: {
      ...defaultProjectSettings(),
      sdlc: projectSdlcSettings.parse({ enabled: true, defaultMode: "speckit", labels: ["sdlc"] }),
    },
  });
  projectId = project.projectId;
  provider = createMemoryProvider("gitlab", ["xdev-team"]);
  provider.seedRepo({ owner: project.owner, name: project.repo }, { files: { "README.md": "# Repo\n" } });
  const providerFactory: ProviderFactory = () => provider;
  const auth = createAuth({ pool: authPool, baseURL: publicUrl, secret, allowEmailSignUp: true });
  engine = createRunsEngine({ pool, publicUrl, authSecret: secret, masterKey, providerFactory, logger: quiet });
  unregister = registerRunHandlers(engine.handlers);
  const app = createApp({ config: { port: 0, version: "test", publicUrl }, auth, pool, runs: engine, providerFactory });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve()) as Server;
  });
  gateway = attachWorkerGateway(server, { pool, heartbeatSec: 5, logger: quiet });
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;

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
  await gateway.close();
  await new Promise((resolve) => server.close(resolve));
  await Promise.all([admin.end(), pool.end(), authPool.end()]);
});

// ---- Công cụ ------------------------------------------------------------------------------------------------

const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(pool, { userId: org.user(who), orgId: org.orgId }, fn);

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`http://${base}/api${path}`, {
    method,
    headers: { "content-type": "application/json", cookie, "x-hive-org": org.orgId },
    body: body === undefined ? null : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as T };
}

async function until(check: () => Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Hết thời gian chờ");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const runRow = async (id: string) => (await admin.query("select * from hive.runs where id = $1", [id])).rows[0];

async function seedMachine(name: string, opts: { labels?: string[]; labelsOnly?: boolean } = {}) {
  const token = `hwm_${randomBytes(32).toString("base64url")}`;
  const { rows } = await admin.query(
    `insert into hive.machines (org_id, team_id, name, os, version, clis, capacity, shared, labels, labels_only)
     values ($1, $2, $3, 'linux', '1', '{claude}', 1, true, $4, $5) returning id`,
    [org.orgId, org.teamId, name, opts.labels ?? [], opts.labelsOnly ?? false],
  );
  await admin.query(
    "insert into hive.machine_tokens (org_id, team_id, machine_id, token_hash) values ($1, $2, $3, $4)",
    [org.orgId, org.teamId, rows[0].id, createHash("sha256").update(token).digest("hex")],
  );
  return { id: rows[0].id as string, name, token };
}

type Msg<T extends HubToWorker["type"]> = Extract<HubToWorker, { type: T }>;
const openWorkers = new Set<FakeWorker>();
afterEach(async () => {
  await Promise.all([...openWorkers].map((w) => w.close()));
});

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

  static async connect(m: { name: string; token: string }, capabilities: string[] = []) {
    const w = new FakeWorker(m.token);
    openWorkers.add(w);
    await new Promise<void>((resolve, reject) => {
      w.ws.once("open", () => resolve());
      w.ws.once("error", reject);
    });
    w.send({
      type: "hello",
      machineId: m.name,
      version: "0.4.0",
      protoRange: [1, 1],
      os: "linux",
      clis: ["claude"],
      capacity: 1,
      capabilities,
    });
    await w.next("welcome");
    return w;
  }

  send(msg: Record<string, unknown>) {
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), ...msg }));
  }

  sendRun(msg: Record<string, unknown>) {
    this.send({ ...msg, seq: this.seq++ });
  }

  next<T extends HubToWorker["type"]>(type: T, where: (m: Msg<T>) => boolean = () => true, ms = 8000): Promise<Msg<T>> {
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

async function waitingMessages(runId: string): Promise<string[]> {
  const { rows } = await admin.query(
    "select data->>'message' as message from hive.run_events where run_id = $1 and type = 'waiting_machine'",
    [runId],
  );
  return rows.map((r) => r.message as string);
}

/** Hạng mục Spec Kit tạo qua `sdlc.createItem` với engine thật: giai đoạn Specify tự chạy bước soạn. */
async function newItem(title: string) {
  const detail = await as("tmember", (tx) =>
    createItem(
      tx,
      org.user("tmember"),
      {
        projectId,
        title,
        idea: "Khách hàng cần hoàn tiền một phần cho đơn đã giao, có lý do và lịch sử.",
        modeRef: "speckit",
        size: "M",
      },
      engine.sdlcDeps,
    ),
  );
  const { rows } = await admin.query(
    "select id, run_id, status from hive.sdlc_steps where item_id = $1 order by created_at",
    [detail.id],
  );
  return { detail, steps: rows as { id: string; run_id: string | null; status: string }[] };
}

// ---- Kịch bản -----------------------------------------------------------------------------------------------

describe("run sdlc của bước agent", () => {
  it("chỉ máy có capability sdlc và đủ nhãn nhận; file trả về thành bản nháp, bước xong", async () => {
    const { detail, steps } = await newItem("Hoàn tiền một phần");
    expect(steps).toHaveLength(1);
    const runId = steps[0]?.run_id as string;
    expect(steps[0]?.status).toBe("running");
    const run = await runRow(runId);
    expect(run).toMatchObject({ kind: "sdlc", task_id: null, owner_user_id: null, state: "queued" });
    expect(run.required_labels).toEqual(["sdlc"]);

    // Worker cũ không khai sdlc sẽ chạy run như run code: không được giao, lý do chờ nói rõ cần worker mới.
    const old = await FakeWorker.connect(await seedMachine(`old-${tag}`));
    await until(async () => (await waitingMessages(runId)).some((m) => m.includes("Cần worker mới")));
    // Máy mới nhưng thiếu nhãn sdlc: vẫn chờ, lý do nêu nhãn thiếu (SC-010).
    const unlabeled = await FakeWorker.connect(await seedMachine(`nolabel-${tag}`), ["sdlc"]);
    await until(async () => (await waitingMessages(runId)).some((m) => m.includes("nhãn sdlc")));
    expect(old.has("job_offer") || unlabeled.has("job_offer")).toBe(false);

    const w = await FakeWorker.connect(await seedMachine(`sdlc-${tag}`, { labels: ["sdlc"] }), ["sdlc"]);
    const offer = await w.next("job_offer", (o) => o.runId === runId);
    expect(offer.spec).toMatchObject({
      kind: "sdlc",
      taskId: null,
      runPermissions: "workspace",
      branch: `sdlc/${steps[0]?.id}`,
    });
    const job = offer.spec.sdlc as {
      step: string;
      seed: { path: string }[];
      collect: { artifactId: string; path: string }[];
    };
    expect(job.step).toBe("draft-spec");
    const ref = String(detail.number).padStart(3, "0");
    const specPath = `specs/${ref}-${detail.slug}/spec.md`;
    expect(job.collect).toEqual([{ artifactId: expect.any(String), path: specPath }]);
    // Khuôn spec của chế độ đã là bản nháp: agent sửa tiếp thay vì viết từ đầu.
    expect(job.seed.map((s) => s.path)).toContain(specPath);
    expect(String(offer.spec.prompt)).toContain("hoàn tiền một phần");
    expect(String(offer.spec.prompt)).toContain(specPath);

    w.send({ type: "job_accept", runId, attempt: 1 });
    await w.next("lease", (l) => l.runId === runId);
    const content = "# Spec: Hoàn tiền một phần\n\n## Requirements\n\n- FR-001: Hoàn tiền một phần.\n";
    w.sendRun({
      type: "run_result",
      runId,
      attempt: 1,
      exit: 0,
      headSha: null,
      report: {
        status: "succeeded",
        commitCount: 0,
        changedFiles: [],
        artifacts: [
          {
            artifactId: job.collect[0]?.artifactId,
            path: specPath,
            content,
            sha256: createHash("sha256").update(content).digest("hex"),
          },
        ],
      },
    });
    await until(async () => (await runRow(runId)).state === "succeeded");
    const step = (await admin.query("select status, result from hive.sdlc_steps where id = $1", [steps[0]?.id]))
      .rows[0];
    expect(step.status).toBe("succeeded");
    expect(step.result.artifacts).toHaveLength(1);
    const key = detail.artifacts.find((a) => a.artifactId === "spec")?.docKey as string;
    const state = await as("tmember", (tx) => editorState(tx, { kind: "user", userId: org.user("tmember") }, { key }));
    expect(state.draft.content).toBe(content);
    const phase = (
      await admin.query("select status from hive.sdlc_item_phases where item_id = $1 and phase_id = 'specify'", [
        detail.id,
      ])
    ).rows[0];
    expect(phase.status).toBe("drafting");
  });

  it("run sdlc lỗi (worker vượt giới hạn file) thì bước failed kèm lý do của worker", async () => {
    const { steps } = await newItem("Xuất hoá đơn điện tử");
    const runId = steps[0]?.run_id as string;
    const w = await FakeWorker.connect(await seedMachine(`sdlc2-${tag}`, { labels: ["sdlc"] }), ["sdlc"]);
    await w.next("job_offer", (o) => o.runId === runId);
    w.send({ type: "job_accept", runId, attempt: 1 });
    await w.next("lease", (l) => l.runId === runId);
    w.sendRun({
      type: "run_result",
      runId,
      attempt: 1,
      exit: 0,
      headSha: null,
      report: { status: "failed", error: "Tài liệu vượt giới hạn 200 000 ký tự." },
    });
    await until(async () => (await runRow(runId)).state === "failed");
    const step = (await admin.query("select status, error from hive.sdlc_steps where id = $1", [steps[0]?.id])).rows[0];
    expect(step).toMatchObject({ status: "failed", error: "Tài liệu vượt giới hạn 200 000 ký tự." });
  });
});

describe("hạng mục nhiều dự án: checkout repo tham gia (T086)", () => {
  it("máy không khai sdlc-multirepo chỉ nhận tóm tắt repo; máy có thì nhận repos và prompt chỉ chỗ checkout", async () => {
    await admin.query("update hive.runs set state = 'cancelled' where org_id = $1 and state = 'queued'", [org.orgId]);
    const otherKey = `sb-${tag}`;
    const other = await seedProject(admin, pool, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: otherKey,
      settings: { ...defaultProjectSettings(), sdlc: projectSdlcSettings.parse({ enabled: true }) },
    });
    provider.seedRepo({ owner: other.owner, name: other.repo }, { files: { "README.md": "# Billing\n" } });
    const newMultiItem = async (title: string) => {
      const detail = await as("tmember", (tx) =>
        createItem(
          tx,
          org.user("tmember"),
          {
            projectId,
            participants: [other.projectId],
            title,
            idea: "Hoàn tiền cần cả dịch vụ thanh toán và dịch vụ hoá đơn.",
            modeRef: "speckit",
            size: "M",
          },
          engine.sdlcDeps,
        ),
      );
      const { rows } = await admin.query("select run_id from hive.sdlc_steps where item_id = $1", [detail.id]);
      return rows[0]?.run_id as string;
    };
    const digestPath = `.hive/sdlc/projects/${otherKey}.md`;
    type Job = { seed: { path: string }[]; repos?: { projectKey: string; cloneUrl: string; dir: string }[] };

    const runA = await newMultiItem("Hoàn tiền nhiều dịch vụ");
    const plain = await FakeWorker.connect(await seedMachine(`mr-old-${tag}`, { labels: ["sdlc"] }), ["sdlc"]);
    const offerA = await plain.next("job_offer", (o) => o.runId === runA);
    const jobA = offerA.spec.sdlc as Job;
    expect(jobA.repos).toBeUndefined();
    expect(jobA.seed.map((s) => s.path)).toContain(digestPath);
    expect(String(offerA.spec.prompt)).not.toContain(".hive/repos/");
    await plain.close();
    await admin.query("update hive.runs set state = 'cancelled' where org_id = $1 and state = 'queued'", [org.orgId]);

    const runB = await newMultiItem("Hoàn tiền nhiều dịch vụ, lượt hai");
    const multi = await FakeWorker.connect(await seedMachine(`mr-new-${tag}`, { labels: ["sdlc"] }), [
      "sdlc",
      "sdlc-multirepo",
    ]);
    const offerB = await multi.next("job_offer", (o) => o.runId === runB);
    const jobB = offerB.spec.sdlc as Job;
    expect(jobB.repos).toEqual([
      {
        projectKey: otherKey,
        cloneUrl: `https://gitlab.com/${other.owner}/${other.repo}.git`,
        branch: "main",
        dir: `.hive/repos/${otherKey}`,
      },
    ]);
    // Tóm tắt vẫn seed: repo nào máy không clone được thì agent đọc tóm tắt.
    expect(jobB.seed.map((s) => s.path)).toContain(digestPath);
    expect(String(offerB.spec.prompt)).toContain(".hive/repos/STATUS.md");
  });
});

describe("nhãn máy cho run code (SC-010)", () => {
  it("máy chỉ nhận run có nhãn không lấy run code thường", async () => {
    await admin.query("update hive.runs set state = 'cancelled' where org_id = $1 and state = 'queued'", [org.orgId]);
    const { status, data: task } = await api<Task>("POST", "/v1/tasks", { projectId, title: "Sửa chữ nút", body: "x" });
    expect(status).toBe(200);
    const only = await FakeWorker.connect(await seedMachine(`only-${tag}`, { labels: ["sdlc"], labelsOnly: true }));
    const started = await api<{ id: string }>("POST", "/v1/runs", { taskId: task.id });
    expect(started.status).toBe(200);
    expect((await runRow(started.data.id)).required_labels).toEqual([]);
    await new Promise((r) => setTimeout(r, 600));
    expect(only.has("job_offer")).toBe(false);
    const plain = await FakeWorker.connect(await seedMachine(`plain-${tag}`));
    await plain.next("job_offer", (o) => o.runId === started.data.id);
  });
});

describe("cổng chặn run code của task hạng mục (SC-001)", () => {
  it("qua web và qua hệ thống đều bị chặn khi thiếu baseline; ngoại lệ cho qua và run mang nhãn của dự án", async () => {
    const { detail } = await newItem("Đổi địa chỉ giao hàng");
    await admin.query("update hive.runs set state = 'cancelled' where org_id = $1 and state = 'queued'", [org.orgId]);
    const { data: task } = await api<Task>("POST", "/v1/tasks", { projectId, title: "Làm API đổi địa chỉ", body: "x" });
    await admin.query(
      `insert into hive.sdlc_item_tasks (org_id, item_id, task_id, project_id, slice_key, wave, breakdown_version)
       values ($1, $2, $3, $4, 'phase-1', 1, 1)`,
      [org.orgId, detail.id, task.id, projectId],
    );

    const blocked = await api<{ code: string; data: { code: string; itemId: string; missing: { kind: string }[] } }>(
      "POST",
      "/v1/runs",
      { taskId: task.id },
    );
    expect(blocked.status).toBe(409);
    expect(blocked.data.data).toMatchObject({ code: "SDLC_GATE_BLOCKED", itemId: detail.id });
    expect(blocked.data.data.missing.map((m) => m.kind)).toContain("artifact");

    // Đường hệ thống (Leader run.dispatch, @bot, issue, run sửa) cũng đi qua queueRun.
    await expect(
      withTenant(pool, { orgId: org.orgId }, async (tx) => {
        const row = await loadTask(tx, task.id);
        if (!row) throw new Error("mất task");
        return engine.queueRun(tx, row, await loadProject(tx, projectId), { cli: null, createdBy: "issue" });
      }),
    ).rejects.toMatchObject({ code: "SDLC_GATE_BLOCKED" });

    const { rows } = await admin.query(
      `insert into hive.sdlc_overrides (org_id, item_id, task_id, reason, decided_by)
       values ($1, $2, $3, 'Chạy gấp để demo khách hàng', $4) returning id`,
      [org.orgId, detail.id, task.id, org.user("tadmin")],
    );
    const ok = await api<{ id: string }>("POST", "/v1/runs", { taskId: task.id });
    expect(ok.status).toBe(200);
    expect((await runRow(ok.data.id)).required_labels).toEqual(["sdlc"]);
    const used = await admin.query(
      "select data from hive.run_events where run_id = $1 and type = 'sdlc.override_used'",
      [ok.data.id],
    );
    expect(used.rows[0]?.data).toMatchObject({ overrideId: rows[0].id, itemId: detail.id });
  });
});
