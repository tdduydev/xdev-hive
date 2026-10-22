import { randomBytes, randomUUID } from "node:crypto";
import type { DeployStep, TargetUpsertInput } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { createPool, type Jobs, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { deployBoard, getDeploy, listDeploys } from "./deploys/board.ts";
import type { DeployMethod, DeployRun } from "./deploys/method.ts";
import {
  cancelDeploy,
  createDeploy,
  type DeployJob,
  type OrchestratorOptions,
  queueDeploy,
  registerOrchestrator,
  startDeploy,
  UNREACHABLE_AFTER_MS,
  watchDeploy,
} from "./deploys/orchestrator.ts";
import { createEnvironment } from "./environments.ts";
import { DELIVERY_DEPLOY_QUEUE, DELIVERY_DEPLOY_WATCH_QUEUE } from "./queues.ts";
import { upsertTarget } from "./targets.ts";

// Bộ điều phối với một cách triển khai giả đăng ký trong test (không chờ T020): "máy chủ" là bộ nhớ của test, vị trí
// đọc log nằm trong `remote` như cách thật, nên tạo lại đối tượng cách triển khai là giống hub khởi động lại.

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));

const SECRET = "mat-khau-rat-bi-mat-0123456789";
const SHA = "a".repeat(40);

interface Enqueued {
  queue: string;
  data: DeployJob;
  singletonKey: string | undefined;
  startAfter: Date | undefined;
}

function fakeJobs() {
  const enqueued: Enqueued[] = [];
  const workers: string[] = [];
  const jobs: Jobs = {
    start: async () => {},
    stop: async () => {},
    enqueue: async (queue, data, opts) => {
      enqueued.push({
        queue,
        data: data as unknown as DeployJob,
        singletonKey: opts?.singletonKey,
        startAfter: opts?.startAfter,
      });
      return randomUUID();
    },
    schedule: async () => {},
    work: async (queue) => {
      workers.push(queue);
    },
  };
  return { jobs, enqueued, workers };
}

// ---- Máy chủ và cách triển khai giả ---------------------------------------------------------------------------------

interface FakeRun {
  state: "running" | "succeeded" | "failed" | "failed_needs_review";
  log: string;
  /** Không đọc được máy chủ. */
  unreachable: boolean;
  /** Hub dừng giữa nhịp đọc: huỷ signal sau khi đã đọc. */
  dieOnPoll: AbortController | null;
  health: Record<string, unknown> | null;
  canceled: boolean;
  cancelFails: boolean;
}

class FakeServer {
  readonly runs = new Map<string, FakeRun>();
  startFails = false;
  starts = 0;
  polls = 0;
  /** Cấu hình cách triển khai nhận được, để kiểm biến bí mật không lộ ra. */
  lastRun: DeployRun | null = null;

  get(id: string): FakeRun {
    const r = this.runs.get(id);
    if (!r) throw new Error(`fake: không có lần ${id}`);
    return r;
  }
}

const step = (key: string, state: DeployStep["state"]): DeployStep => ({
  key,
  state,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  message: null,
});

function fakeMethod(server: FakeServer): DeployMethod {
  return {
    method: "ssh-script",
    async start(_ctx, run) {
      server.starts++;
      server.lastRun = run;
      if (server.startFails) throw new Error(`không kết nối được, mật khẩu ${SECRET}`);
      server.runs.set(run.deployId, {
        state: "running",
        log: "",
        unreachable: false,
        dieOnPoll: null,
        health: null,
        canceled: false,
        cancelFails: false,
      });
      return {
        steps: [step("precheck", "running"), step("deploy", "pending")],
        remote: { offset: 0 },
        external: { label: "fake", url: null },
      };
    },
    async poll(_ctx, run) {
      server.polls++;
      const r = server.get(run.deployId);
      if (r.unreachable) throw new Error("connect ETIMEDOUT");
      const offset = Number(run.remote?.offset ?? 0);
      const log = r.log.slice(offset);
      if (r.dieOnPoll) {
        r.dieOnPoll.abort();
        throw new Error("worker dừng");
      }
      const last = r.state === "running" ? "running" : r.state === "succeeded" ? "succeeded" : "failed";
      return {
        state: r.state as "running",
        steps: [step("precheck", "succeeded"), step("deploy", last)],
        remote: { offset: r.log.length },
        log,
        ...(r.health ? { health: r.health } : {}),
      };
    },
    async cancel(_ctx, run) {
      const r = server.get(run.deployId);
      if (r.cancelFails) throw new Error("ssh: connection reset");
      r.canceled = true;
    },
    async version() {
      return null;
    },
  };
}

// ---- Dữ liệu --------------------------------------------------------------------------------------------------------

let org: Awaited<ReturnType<typeof seedOrg>>;
let scmId: string;
let serverId: string;
let devId: string;
let stagingId: string;
let prodId: string;
const uid = (name: string) => org.user(name);
const as = <T>(name: string, run: (tx: Tx) => Promise<T>) =>
  withTenant(app, { orgId: org.orgId, userId: uid(name) }, run);

const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    const e = error as { name: string; code?: string; message: string; data?: Record<string, unknown> };
    return { name: e.name, code: e.code, message: e.message, data: e.data };
  }
  return undefined;
};

const sshConfig = (backup: boolean) =>
  ({
    method: "ssh-script",
    schemaVersion: 1,
    serverId,
    workdir: "/opt/billing",
    composeProject: "billing",
    steps: {
      precheck: { script: "docker compose config -q" },
      backup: backup ? { script: "pg_dump > backup.sql" } : null,
      upload: { mode: "none" },
      deploy: { script: "docker compose up -d" },
    },
    variables: [
      { name: "APP_ENV", secret: false, value: "dev" },
      { name: "DB_PASSWORD", secret: true, value: SECRET },
    ],
  }) as TargetUpsertInput["config"];

async function newProject(): Promise<string> {
  const key = `p-${randomUUID().slice(0, 8)}`;
  return (
    await admin.query(
      `insert into hive.projects (org_id, team_id, system_id, key, name, scm_connection_id, scm_kind, repo_mode,
         repo_owner, repo_name, settings, idempotency_key, created_by)
       values ($1, $2, $3, $4, $4, $5, 'gitlab', 'existing', 'xdev-team', $4, '{}', $6, $7)
       returning id`,
      [org.orgId, org.teamId, org.systemId, key, scmId, randomUUID(), uid("owner")],
    )
  ).rows[0].id as string;
}

/** Một đích mới (dự án mới) để mỗi test có khoá đích riêng. */
async function newTarget(environmentId = devId, opts: { backup?: boolean; projectId?: string } = {}) {
  const projectId = opts.projectId ?? (await newProject());
  const t = await as("tadmin", (tx) =>
    upsertTarget(tx, { masterKey }, uid("tadmin"), {
      projectId,
      environmentId,
      config: sshConfig(opts.backup ?? false),
      expectedConfigVersion: null,
    }),
  );
  return { targetId: t.id, projectId, configVersion: t.configVersion };
}

function harness() {
  const server = new FakeServer();
  const queue = fakeJobs();
  let now = new Date("2026-10-22T03:00:00.000Z");
  const deps = { pool: app, masterKey, jobs: queue.jobs };
  const opts = (): OrchestratorOptions => ({ methodFor: () => fakeMethod(server), now: () => now });
  const job = (deployId: string): DeployJob => ({ orgId: org.orgId, deployId });
  return {
    server,
    queue,
    deps,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    at: () => now,
    create: (user: string, targetId: string, extra: { skipBackup?: { reason: string }; sha?: string } = {}) =>
      as(user, (tx) =>
        createDeploy(
          tx,
          deps,
          uid(user),
          { targetId, version: { kind: "commit", sha: extra.sha ?? SHA }, skipBackup: extra.skipBackup },
          opts(),
        ),
      ),
    start: (deployId: string, signal?: AbortSignal) => startDeploy(deps, job(deployId), { ...opts(), signal }),
    watch: (deployId: string, signal?: AbortSignal) => watchDeploy(deps, job(deployId), { ...opts(), signal }),
    /** Hub khởi động lại: đối tượng cách triển khai và hàng đợi mới, chỉ còn máy chủ và database. */
    restarted: () => {
      const fresh = fakeJobs();
      const freshDeps = { pool: app, masterKey, jobs: fresh.jobs };
      return {
        queue: fresh,
        watch: (deployId: string) =>
          watchDeploy(freshDeps, job(deployId), { methodFor: () => fakeMethod(server), now: () => now }),
      };
    },
    watchJobs: (deployId: string) =>
      queue.enqueued.filter((e) => e.queue === DELIVERY_DEPLOY_WATCH_QUEUE && e.data.deployId === deployId),
    startJobs: (deployId: string) =>
      queue.enqueued.filter((e) => e.queue === DELIVERY_DEPLOY_QUEUE && e.data.deployId === deployId),
  };
}

const deployRow = async (id: string) =>
  (
    await admin.query(
      `select state, remote, steps, health, config_version, skip_backup_reason, started_at, finished_at,
         approvals_required, approval_expires_at
       from hive.deploys where id = $1`,
      [id],
    )
  ).rows[0] as {
    state: string;
    remote: Record<string, unknown> | null;
    steps: DeployStep[];
    health: Record<string, unknown> | null;
    config_version: number | null;
    skip_backup_reason: string | null;
    started_at: Date | null;
    finished_at: Date | null;
    approvals_required: number;
    approval_expires_at: Date | null;
  };

const logOf = async (id: string) =>
  (await admin.query("select data from hive.deploy_log_chunks where deploy_id = $1 order by seq", [id])).rows
    .map((r: { data: Buffer }) => r.data.toString("utf8"))
    .join("");

const inbox = async (eventKey: string) =>
  (
    await admin.query("select user_id from hive.inbox_items where org_id = $1 and event_key = $2 order by user_id", [
      org.orgId,
      eventKey,
    ])
  ).rows.map((r: { user_id: string }) => r.user_id);

const audits = async (action: string, targetId: string) =>
  (
    await admin.query(
      "select data, actor_user_id from hive.audit_log where org_id = $1 and action = $2 and target_id = $3",
      [org.orgId, action, targetId],
    )
  ).rows as Array<{ data: Record<string, unknown>; actor_user_id: string }>;

async function insertExternal(targetId: string, state: string, version: Record<string, unknown>, finishedAt: Date) {
  const id = randomUUID();
  await admin.query(
    `insert into hive.deploys (id, org_id, target_id, method, origin, state, version, triggered_by, created_at,
       finished_at)
     values ($1, $2, $3, 'ssh-script', 'external', $4, $5, 'jenkins: ops', $6, $6)`,
    [id, org.orgId, targetId, state, JSON.stringify(version), finishedAt],
  );
  return id;
}

const version = (commit: string) => ({
  commit,
  tag: null,
  jenkinsBuild: null,
  image: null,
  images: [],
  revision: null,
});

beforeAll(async () => {
  org = await seedOrg(admin, `delivery-dep-${randomUUID().slice(0, 8)}`);
  scmId = randomUUID();
  await admin.query(
    "insert into hive.scm_connections (id, org_id, kind, name, secret_enc, created_by) values ($1, $2, 'gitlab', 'GitLab', 'x', $3)",
    [scmId, org.orgId, uid("owner")],
  );
  serverId = randomUUID();
  await admin.query(
    `insert into hive.deploy_servers (id, org_id, team_id, name, host, ssh_user, private_key_enc, public_key, created_by)
     values ($1, $2, $3, 'web-1', 'host.example.invalid', 'deploy', 'enc', 'ssh-ed25519 AAAA', $4)`,
    [serverId, org.orgId, org.teamId, uid("owner")],
  );
  const env = (name: string, policy: Parameters<typeof createEnvironment>[2]["policy"]) =>
    as("tadmin", (tx) => createEnvironment(tx, uid("tadmin"), { systemId: org.systemId, name, policy }));
  devId = (await env("dev", { deployRoles: [], approveRoles: [], approvals: 0, approvalTtlHours: 24 })).id;
  stagingId = (await env("staging", { deployRoles: [], approveRoles: [], approvals: 0, approvalTtlHours: 24 })).id;
  prodId = (await env("prod", { deployRoles: ["admin"], approveRoles: ["admin"], approvals: 1, approvalTtlHours: 12 }))
    .id;
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

// ---- Tạo ------------------------------------------------------------------------------------------------------------

describe("tạo lần triển khai", () => {
  it("bấm hai lần cùng đích: lần sau bị chặn kèm người và giờ", async () => {
    const h = harness();
    const { targetId, configVersion } = await newTarget();
    const first = await h.create("tmember", targetId);
    expect(first).toMatchObject({
      state: "queued",
      origin: "hive",
      targetId,
      configVersion,
      version: { commit: SHA },
      requestedBy: { userId: uid("tmember") },
    });
    expect(h.startJobs(first.id)).toEqual([
      expect.objectContaining({ singletonKey: first.id, data: { orgId: org.orgId, deployId: first.id } }),
    ]);

    const err = await failure(() => h.create("tadmin", targetId));
    expect(err).toMatchObject({
      name: "ConflictError",
      code: "DEPLOY_IN_PROGRESS",
      data: { deployId: first.id, by: { userId: uid("tmember") }, since: first.createdAt },
    });
    expect(err?.message).toContain(`Đang triển khai bởi ${uid("tmember")} từ`);

    // Hai lần bấm cùng lúc: khoá dòng đích làm chúng đi lần lượt, chỉ một lần được tạo.
    const other = await newTarget();
    const both = await Promise.allSettled([h.create("tmember", other.targetId), h.create("tadmin", other.targetId)]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = both.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "DEPLOY_IN_PROGRESS" });
  });

  it('lần "ngoài Hive" đang chạy không giữ khoá đích', async () => {
    const h = harness();
    const { targetId } = await newTarget();
    await insertExternal(targetId, "running", version("b".repeat(40)), new Date());
    await expect(h.create("tmember", targetId)).resolves.toMatchObject({ state: "queued" });
  });

  // Thành viên tổ chức ngoài đội có ci.view (FR-030) nên thấy đích nhưng không chạy được.
  it("cần deploy.run và vai trò trong deployRoles", async () => {
    const h = harness();
    const { targetId } = await newTarget();
    expect(await failure(() => h.create("tviewer", targetId))).toMatchObject({
      name: "ForbiddenError",
      code: "DEPLOY_RUN_REQUIRED",
    });
    for (const name of ["loner", "oadmin"])
      expect(await failure(() => h.create(name, targetId))).toMatchObject({
        name: "ForbiddenError",
        code: "DEPLOY_RUN_REQUIRED",
      });

    const prod = await newTarget(prodId);
    expect(await failure(() => h.create("tmember", prod.targetId))).toMatchObject({
      name: "ForbiddenError",
      code: "DEPLOY_ROLE_REQUIRED",
    });
  });

  it("môi trường khoá thì ENV_LOCKED kèm lý do", async () => {
    const h = harness();
    const { projectId } = await newTarget(devId);
    const locked = await as("tadmin", (tx) =>
      createEnvironment(tx, uid("tadmin"), {
        systemId: org.systemId,
        name: `locked-${randomUUID().slice(0, 6)}`,
        policy: { deployRoles: [], approveRoles: [], approvals: 0, approvalTtlHours: 24 },
      }),
    );
    const { targetId } = await newTarget(locked.id, { projectId });
    await admin.query(
      "update hive.deploy_environments set locked_at = now(), locked_by = $2, lock_reason = 'Đóng băng cuối năm' where id = $1",
      [locked.id, uid("tadmin")],
    );
    expect(await failure(() => h.create("tmember", targetId))).toMatchObject({
      name: "ConflictError",
      code: "ENV_LOCKED",
      data: { reason: "Đóng băng cuối năm" },
    });
  });

  it("môi trường cần duyệt: pending_approval, báo người duyệt được trừ người yêu cầu", async () => {
    const h = harness();
    const { targetId } = await newTarget(prodId);
    const d = await h.create("admin", targetId);
    expect(d).toMatchObject({ state: "pending_approval", approval: { required: 1, decisions: [] } });
    expect(new Date(d.approval?.expiresAt ?? 0).getTime() - h.at().getTime()).toBe(12 * 3_600_000);
    expect(h.startJobs(d.id)).toEqual([]);
    const notified = await inbox(`deploy:${d.id}:approval_requested`);
    expect(notified).toContain(uid("tadmin"));
    expect(notified).toContain(uid("owner"));
    expect(notified).not.toContain(uid("admin"));
    expect(notified).not.toContain(uid("tmember"));

    // Duyệt xong (T027) thì chuyển queued; môi trường bị khoá trong lúc chờ thì không chuyển.
    await admin.query(
      "update hive.deploy_environments set locked_at = now(), locked_by = $2, lock_reason = 'Sự cố' where id = $1",
      [prodId, uid("tadmin")],
    );
    expect(await failure(() => as("tadmin", (tx) => queueDeploy(tx, h.deps, d.id)))).toMatchObject({
      code: "ENV_LOCKED",
    });
    await admin.query(
      "update hive.deploy_environments set locked_at = null, locked_by = null, lock_reason = null where id = $1",
      [prodId],
    );
    await as("tadmin", (tx) => queueDeploy(tx, h.deps, d.id));
    expect((await deployRow(d.id)).state).toBe("queued");
    expect(h.startJobs(d.id)).toHaveLength(1);
    expect(await failure(() => as("tadmin", (tx) => queueDeploy(tx, h.deps, d.id)))).toMatchObject({
      code: "DEPLOY_NOT_PENDING",
    });
  });

  it('"Bỏ qua sao lưu lần này" ghi audit; đích không sao lưu thì báo lỗi', async () => {
    const h = harness();
    const withBackup = await newTarget(devId, { backup: true });
    const d = await h.create("tmember", withBackup.targetId, { skipBackup: { reason: "Sửa gấp lỗi thanh toán" } });
    expect(d.skipBackup).toEqual({ reason: "Sửa gấp lỗi thanh toán" });
    expect(await audits("delivery.deploy.skip_backup", d.id)).toEqual([
      expect.objectContaining({
        actor_user_id: uid("tmember"),
        data: expect.objectContaining({ targetId: withBackup.targetId, reason: "Sửa gấp lỗi thanh toán" }),
      }),
    ]);

    const noBackup = await newTarget();
    expect(
      await failure(() => h.create("tmember", noBackup.targetId, { skipBackup: { reason: "Không cần" } })),
    ).toMatchObject({ code: "SKIP_BACKUP_NOT_APPLICABLE" });
  });

  it("đẩy từ môi trường lấy bản thành công gần nhất ở nguồn, kể cả ngoài Hive", async () => {
    const h = harness();
    const dev = await newTarget(devId);
    const staging = await newTarget(stagingId, { projectId: dev.projectId });
    const promote = () =>
      as("tmember", (tx) =>
        createDeploy(tx, h.deps, uid("tmember"), {
          targetId: staging.targetId,
          version: { kind: "fromEnv", environmentId: devId },
        }),
      );
    expect(await failure(promote)).toMatchObject({ code: "NOTHING_TO_PROMOTE" });
    expect(
      await failure(() =>
        as("tmember", (tx) =>
          createDeploy(tx, h.deps, uid("tmember"), {
            targetId: staging.targetId,
            version: { kind: "fromEnv", environmentId: stagingId },
          }),
        ),
      ),
    ).toMatchObject({ code: "PROMOTE_SOURCE_INVALID" });

    await insertExternal(dev.targetId, "succeeded", version("c".repeat(40)), new Date());
    await expect(promote()).resolves.toMatchObject({ version: { commit: "c".repeat(40) } });
  });
});

// ---- Chạy và theo dõi -----------------------------------------------------------------------------------------------

describe("chạy và theo dõi", () => {
  it("queued → running → succeeded, xếp lại 2 giây khi đang chạy, báo started/succeeded", async () => {
    const h = harness();
    const { targetId } = await newTarget();
    const d = await h.create("tmember", targetId);
    await h.start(d.id);
    let row = await deployRow(d.id);
    expect(row).toMatchObject({ state: "running", remote: { offset: 0 } });
    expect(row.started_at?.toISOString()).toBe(h.at().toISOString());
    expect(row.steps.map((s) => [s.key, s.state])).toEqual([
      ["precheck", "running"],
      ["deploy", "pending"],
    ]);
    // Cách triển khai không thấy giá trị biến bí mật.
    expect(JSON.stringify(h.server.lastRun?.config)).not.toContain(SECRET);
    expect(h.watchJobs(d.id)).toEqual([
      expect.objectContaining({ singletonKey: d.id, startAfter: new Date(h.at().getTime() + 2000) }),
    ]);
    expect(await inbox(`deploy:${d.id}:deploy.started`)).toEqual([uid("tmember")]);

    // Job chạy lại (pg-boss giao hai lần) không bắt đầu lần nữa.
    await h.start(d.id);
    expect(h.server.starts).toBe(1);

    h.server.get(d.id).log = "pulling image\nstarting web\n";
    h.advance(2000);
    await h.watch(d.id);
    row = await deployRow(d.id);
    expect(row.state).toBe("running");
    expect(await logOf(d.id)).toBe("pulling image\nstarting web\n");
    expect(h.watchJobs(d.id)).toHaveLength(2);

    h.server.get(d.id).log += "done\n";
    h.server.get(d.id).state = "succeeded";
    h.advance(2000);
    await h.watch(d.id);
    row = await deployRow(d.id);
    expect(row.state).toBe("succeeded");
    expect(row.finished_at?.toISOString()).toBe(h.at().toISOString());
    expect(row.steps.map((s) => s.state)).toEqual(["succeeded", "succeeded"]);
    expect(await logOf(d.id)).toBe("pulling image\nstarting web\ndone\n");
    expect(h.watchJobs(d.id)).toHaveLength(2);
    expect(await inbox(`deploy:${d.id}:deploy.succeeded`)).toEqual([uid("tmember")]);

    // Xong thì đích rảnh.
    await expect(h.create("tmember", targetId, { sha: "d".repeat(40) })).resolves.toMatchObject({ state: "queued" });
  });

  it("khởi động lại worker giữa chừng: watch chạy tiếp, log không mất không lặp", async () => {
    const h = harness();
    const { targetId } = await newTarget();
    const d = await h.create("tmember", targetId);
    await h.start(d.id);
    const fake = h.server.get(d.id);
    fake.log = "step 1\nstep 2 đang ";
    await h.watch(d.id);
    // Dòng chưa trọn được giữ lại (mã hoá trong remote), chưa ghi.
    expect(await logOf(d.id)).toBe("step 1\n");
    const remote = (await deployRow(d.id)).remote as { offset: number; _hive?: { logTail?: string } };
    expect(remote.offset).toBe(fake.log.length);
    expect(remote._hive?.logTail).toBeTypeOf("string");
    expect(JSON.stringify(remote)).not.toContain("step 2");

    // Hub dừng giữa nhịp: đã đọc từ máy chủ nhưng giao dịch không commit.
    fake.log += "chạy\nstep 3\n";
    const dying = new AbortController();
    fake.dieOnPoll = dying;
    await expect(h.watch(d.id, dying.signal)).rejects.toThrow();
    expect((await deployRow(d.id)).remote).toEqual(remote);
    expect(await logOf(d.id)).toBe("step 1\n");

    // Tiến trình mới, đối tượng mới: đọc lại từ vị trí đã lưu.
    fake.dieOnPoll = null;
    const next = h.restarted();
    await next.watch(d.id);
    expect(await logOf(d.id)).toBe("step 1\nstep 2 đang chạy\nstep 3\n");
    expect(next.queue.enqueued.filter((e) => e.queue === DELIVERY_DEPLOY_WATCH_QUEUE)).toHaveLength(1);

    fake.state = "succeeded";
    fake.log += "xong";
    await next.watch(d.id);
    expect((await deployRow(d.id)).state).toBe("succeeded");
    // Lần cuối ghi nốt cả dòng chưa xuống dòng.
    expect(await logOf(d.id)).toBe("step 1\nstep 2 đang chạy\nstep 3\nxong");
    expect((await deployRow(d.id)).remote).toEqual({ offset: fake.log.length });
  });

  it("che bí mật kể cả khi bị cắt giữa hai lần đọc và khối khoá riêng", async () => {
    const h = harness();
    const { targetId } = await newTarget();
    const d = await h.create("tmember", targetId);
    await h.start(d.id);
    const fake = h.server.get(d.id);
    const half = SECRET.length / 2;
    fake.log = `DB_PASSWORD=${SECRET.slice(0, half)}`;
    await h.watch(d.id);
    fake.log += `${SECRET.slice(half)}\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n`;
    await h.watch(d.id);
    fake.log += "QyNTUxOQAAACD\n-----END OPENSSH PRIVATE KEY-----\nok\n";
    await h.watch(d.id);
    const log = await logOf(d.id);
    expect(log).not.toContain(SECRET.slice(0, half));
    expect(log).not.toContain(SECRET.slice(half));
    expect(log).not.toContain("b3BlbnNzaC1rZXktdjEAAAA");
    expect(log).not.toContain("QyNTUxOQAAACD");
    expect(log).toContain("DB_PASSWORD=***");
    expect(log.endsWith("ok\n")).toBe(true);
  });

  it("15 phút không đọc được máy chủ thì unknown, không tự chạy lại", async () => {
    const h = harness();
    const { targetId } = await newTarget();
    const d = await h.create("tmember", targetId);
    await h.start(d.id);
    const fake = h.server.get(d.id);
    fake.log = "deploying\n";
    await h.watch(d.id);

    fake.unreachable = true;
    h.advance(2000);
    const since = h.at();
    await h.watch(d.id);
    expect((await deployRow(d.id)).state).toBe("running");
    h.advance(UNREACHABLE_AFTER_MS / 2);
    await h.watch(d.id);
    expect((await deployRow(d.id)).state).toBe("running");
    // Chỉ một dòng báo lỗi cho cả chuỗi lỗi, không phải mỗi nhịp.
    expect((await logOf(d.id)).match(/Không đọc được tiến độ/g)).toHaveLength(1);

    // Đọc lại được thì đếm lại từ đầu.
    fake.unreachable = false;
    h.advance(2000);
    await h.watch(d.id);
    expect((await deployRow(d.id)).remote).toEqual({ offset: fake.log.length });
    fake.unreachable = true;
    h.advance(2000);
    await h.watch(d.id);
    h.advance(UNREACHABLE_AFTER_MS - 1000);
    await h.watch(d.id);
    expect((await deployRow(d.id)).state).toBe("running");
    expect(h.at().getTime() - since.getTime()).toBeGreaterThan(UNREACHABLE_AFTER_MS);

    const watchesBefore = h.watchJobs(d.id).length;
    h.advance(1000);
    await h.watch(d.id);
    const row = await deployRow(d.id);
    expect(row.state).toBe("unknown");
    expect(row.finished_at?.toISOString()).toBe(h.at().toISOString());
    expect(h.watchJobs(d.id)).toHaveLength(watchesBefore);
    expect(h.startJobs(d.id)).toHaveLength(1);
    expect(h.server.starts).toBe(1);
    expect(await logOf(d.id)).toContain("quá 15 phút");
    expect(await inbox(`deploy:${d.id}:deploy.failed`)).toEqual([uid("tmember")]);
    // `unknown` không giữ khoá đích.
    await expect(h.create("tmember", targetId, { sha: "e".repeat(40) })).resolves.toMatchObject({ state: "queued" });
  });

  it("kiểm sức khoẻ không đạt thì failed_needs_review, lưu health", async () => {
    const h = harness();
    const { targetId } = await newTarget();
    const d = await h.create("tmember", targetId);
    await h.start(d.id);
    const fake = h.server.get(d.id);
    fake.state = "failed_needs_review";
    fake.health = { ok: false, at: h.at().toISOString(), status: 502, message: "Bad Gateway" };
    await h.watch(d.id);
    const view = await as("tmember", (tx) => getDeploy(tx, uid("tmember"), d.id));
    expect(view).toMatchObject({ state: "failed_needs_review", health: { ok: false, status: 502 } });
    expect(await inbox(`deploy:${d.id}:deploy.failed`)).toEqual([uid("tmember")]);
  });

  it("không bắt đầu được thì failed, log đã che bí mật", async () => {
    const h = harness();
    h.server.startFails = true;
    const { targetId } = await newTarget();
    const d = await h.create("tmember", targetId);
    await h.start(d.id);
    expect((await deployRow(d.id)).state).toBe("failed");
    const log = await logOf(d.id);
    expect(log).toContain("Không bắt đầu được");
    expect(log).not.toContain(SECRET);
    expect(h.watchJobs(d.id)).toEqual([]);
  });

  it("môi trường bị khoá sau khi xếp hàng thì không chạy", async () => {
    const h = harness();
    const locked = await as("tadmin", (tx) =>
      createEnvironment(tx, uid("tadmin"), {
        systemId: org.systemId,
        name: `freeze-${randomUUID().slice(0, 6)}`,
        policy: { deployRoles: [], approveRoles: [], approvals: 0, approvalTtlHours: 24 },
      }),
    );
    const { targetId } = await newTarget(locked.id);
    const d = await h.create("tmember", targetId);
    await admin.query(
      "update hive.deploy_environments set locked_at = now(), locked_by = $2, lock_reason = 'Sự cố DB' where id = $1",
      [locked.id, uid("tadmin")],
    );
    await h.start(d.id);
    expect((await deployRow(d.id)).state).toBe("canceled");
    expect(h.server.starts).toBe(0);
    expect(await logOf(d.id)).toContain("Sự cố DB");
  });
});

// ---- Huỷ ------------------------------------------------------------------------------------------------------------

describe("huỷ", () => {
  it("huỷ lần đang chạy gọi method.cancel, ghi audit; huỷ lần đã xong thì báo lỗi", async () => {
    const h = harness();
    const { targetId } = await newTarget();
    const d = await h.create("tmember", targetId);
    await h.start(d.id);
    const fake = h.server.get(d.id);
    fake.log = "half a line";
    await h.watch(d.id);

    expect(await failure(() => as("tviewer", (tx) => cancelDeploy(tx, h.deps, uid("tviewer"), d.id)))).toMatchObject({
      code: "DEPLOY_RUN_REQUIRED",
    });

    fake.cancelFails = true;
    expect(
      await failure(() =>
        as("tadmin", (tx) => cancelDeploy(tx, h.deps, uid("tadmin"), d.id, { methodFor: () => fakeMethod(h.server) })),
      ),
    ).toMatchObject({ code: "DEPLOY_CANCEL_FAILED" });
    expect((await deployRow(d.id)).state).toBe("running");

    fake.cancelFails = false;
    const canceled = await as("tadmin", (tx) =>
      cancelDeploy(tx, h.deps, uid("tadmin"), d.id, { methodFor: () => fakeMethod(h.server) }),
    );
    expect(canceled.state).toBe("canceled");
    expect(canceled.steps.map((s) => s.state)).toEqual(["succeeded", "canceled"]);
    expect(fake.canceled).toBe(true);
    expect(await audits("delivery.deploy.cancel", d.id)).toHaveLength(1);
    const log = await logOf(d.id);
    expect(log).toBe(`half a line\n[Hive] Đã huỷ bởi ${uid("tadmin")}.\n`);

    // Nhịp watch còn trong hàng đợi thấy đã huỷ thì thôi.
    const polls = h.server.polls;
    await h.watch(d.id);
    expect(h.server.polls).toBe(polls);

    expect(await failure(() => as("tadmin", (tx) => cancelDeploy(tx, h.deps, uid("tadmin"), d.id)))).toMatchObject({
      code: "DEPLOY_NOT_ACTIVE",
    });
  });

  it("huỷ lần đang chờ không gọi máy chủ", async () => {
    const h = harness();
    const { targetId } = await newTarget();
    const d = await h.create("tmember", targetId);
    const canceled = await as("tmember", (tx) =>
      cancelDeploy(tx, h.deps, uid("tmember"), d.id, { methodFor: () => fakeMethod(h.server) }),
    );
    expect(canceled.state).toBe("canceled");
    await h.start(d.id);
    expect(h.server.starts).toBe(0);
  });
});

// ---- Đọc ------------------------------------------------------------------------------------------------------------

describe("bảng đang chạy và lịch sử", () => {
  it('bảng lấy bản thành công gần nhất mỗi dự án × môi trường, kể cả "ngoài Hive"', async () => {
    const h = harness();
    const dev = await newTarget(devId);
    const staging = await newTarget(stagingId, { projectId: dev.projectId });
    const d = await h.create("tmember", dev.targetId);
    await h.start(d.id);
    h.server.get(d.id).state = "succeeded";
    h.server.get(d.id).health = { ok: true, at: new Date().toISOString(), status: 200, message: "" };
    await h.watch(d.id);
    const ext = await insertExternal(staging.targetId, "succeeded", version("f".repeat(40)), new Date());
    const running = await h.create("tmember", dev.targetId, { sha: "9".repeat(40) });

    const board = await as("tviewer", (tx) => deployBoard(tx, uid("tviewer"), org.systemId));
    const row = board.rows.find((r) => r.projectId === dev.projectId);
    const cell = (envId: string) => row?.cells.find((c) => c.environmentId === envId);
    expect(cell(devId)).toMatchObject({
      targetId: dev.targetId,
      method: "ssh-script",
      current: { id: d.id, state: "succeeded", health: { ok: true, status: 200 } },
      active: { id: running.id, state: "queued" },
    });
    expect(cell(stagingId)).toMatchObject({
      current: { id: ext, origin: "external", version: { commit: "f".repeat(40) } },
      active: null,
    });
    expect(cell(prodId)).toMatchObject({ targetId: null, current: null, active: null });

    // Thành viên tổ chức ngoài đội chỉ xem (ci.view), vẫn thấy cùng bảng.
    const seen = await as("loner", (tx) => deployBoard(tx, uid("loner"), org.systemId));
    expect(seen.rows.find((r) => r.projectId === dev.projectId)?.cells).toEqual(row?.cells);
  });

  it("lịch sử lọc theo đích, nguồn, trạng thái và phân trang", async () => {
    const h = harness();
    const { targetId } = await newTarget();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const d = await h.create("tmember", targetId, { sha: String(i).repeat(40) });
      await as("tmember", (tx) => cancelDeploy(tx, h.deps, uid("tmember"), d.id));
      ids.unshift(d.id);
    }
    const ext = await insertExternal(targetId, "succeeded", version("1".repeat(40)), new Date(Date.now() + 60_000));

    const first = await as("tmember", (tx) => listDeploys(tx, uid("tmember"), { targetId, origin: "hive", limit: 2 }));
    expect(first.items.map((d) => d.id)).toEqual(ids.slice(0, 2));
    expect(first.nextCursor).toBe(ids[1]);
    const second = await as("tmember", (tx) =>
      listDeploys(tx, uid("tmember"), { targetId, origin: "hive", limit: 2, cursor: first.nextCursor ?? undefined }),
    );
    expect(second.items.map((d) => d.id)).toEqual(ids.slice(2));
    expect(second.nextCursor).toBeNull();

    const external = await as("tmember", (tx) =>
      listDeploys(tx, uid("tmember"), { targetId, origin: "external", limit: 10 }),
    );
    expect(external.items.map((d) => d.id)).toEqual([ext]);
    const canceled = await as("tmember", (tx) =>
      listDeploys(tx, uid("tmember"), { targetId, state: "canceled", limit: 10 }),
    );
    expect(canceled.items).toHaveLength(3);

    expect((await as("loner", (tx) => listDeploys(tx, uid("loner"), { targetId, limit: 10 }))).items).toHaveLength(4);
    expect((await as("loner", (tx) => getDeploy(tx, uid("loner"), ids[0] as string))).id).toBe(ids[0]);
    expect(await failure(() => as("tmember", (tx) => getDeploy(tx, uid("tmember"), randomUUID())))).toMatchObject({
      name: "NotFoundError",
    });
    expect(
      await failure(() => as("tmember", (tx) => listDeploys(tx, uid("tmember"), { limit: 10, cursor: "abc" }))),
    ).toMatchObject({ code: "INVALID_CURSOR" });
  });
});

describe("đăng ký worker", () => {
  it("không có database thì không đăng ký; có thì nghe cả hai hàng đợi", async () => {
    const none = fakeJobs();
    await registerOrchestrator(none.jobs, {});
    expect(none.workers).toEqual([]);
    const some = fakeJobs();
    await registerOrchestrator(some.jobs, { pool: app, masterKey });
    expect(some.workers).toEqual([DELIVERY_DEPLOY_QUEUE, DELIVERY_DEPLOY_WATCH_QUEUE]);
  });
});
