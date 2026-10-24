import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { createPool, type Jobs, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { approveDeploy, expireApproval, pendingApprovals, rejectDeploy } from "./approvals.ts";
import { getDeploy } from "./deploys/board.ts";
import { cancelDeploy, createDeploy, type DeployJob, startDeploy } from "./deploys/orchestrator.ts";
import { checkDeliveryJob, RUNNER_WAIT_MS, RUNNER_WAIT_STEP } from "./dispatch.ts";
import { createEnvironment } from "./environments.ts";
import { DELIVERY_APPROVAL_EXPIRE_QUEUE, DELIVERY_DEPLOY_QUEUE, DELIVERY_JOB_CHECK_QUEUE } from "./queues.ts";
import { recordDeliveryCapability } from "./runners.ts";

// Đường chính của specs/032: hub chỉ dựng việc (Jenkins/Argo CD) và chọn máy chạy; máy trong mạng nội bộ gọi ra ngoài.
// Cổng duyệt đứng trước: lần chưa đủ duyệt không được giao.

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const SHA = "b".repeat(40);

interface Enqueued {
  queue: string;
  data: Record<string, string>;
  startAfter: Date | undefined;
}

let org: Awaited<ReturnType<typeof seedOrg>>;
let scmId: string;
let jenkinsId: string;
let devId: string;
let prodId: string;
const uid = (name: string) => org.user(name);
const as = <T>(name: string, run: (tx: Tx) => Promise<T>) =>
  withTenant(app, { orgId: org.orgId, userId: uid(name) }, run);

const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error as { name: string; code?: string };
  }
  return undefined;
};

function harness() {
  const enqueued: Enqueued[] = [];
  const jobs: Jobs = {
    start: async () => {},
    stop: async () => {},
    enqueue: async (queue, data, opts) => {
      enqueued.push({ queue, data: data as Record<string, string>, startAfter: opts?.startAfter });
      return randomUUID();
    },
    schedule: async () => {},
    work: async () => {},
  };
  // Bắt đầu từ giờ thật: approveDeploy so hạn duyệt với đồng hồ thật, mốc cố định sẽ hết hạn theo ngày chạy test.
  let now = new Date();
  const deps = { pool: app, masterKey, jobs };
  return {
    deps,
    enqueued,
    at: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    create: (user: string, targetId: string) =>
      as(user, (tx) =>
        createDeploy(tx, deps, uid(user), { targetId, version: { kind: "commit", sha: SHA } }, { now: () => now }),
      ),
    start: (deployId: string) => startDeploy(deps, { orgId: org.orgId, deployId } as DeployJob, { now: () => now }),
    check: (jobId: string) =>
      withTenant(app, { orgId: org.orgId }, (tx) => checkDeliveryJob(tx, deps, { orgId: org.orgId, jobId }, now)),
  };
}

async function newTarget(environmentId: string, credential = "jenkins-ci") {
  const key = `p-${randomUUID().slice(0, 8)}`;
  const projectId = (
    await admin.query(
      `insert into hive.projects (org_id, team_id, system_id, key, name, scm_connection_id, scm_kind, repo_mode,
         repo_owner, repo_name, settings, idempotency_key, created_by)
       values ($1, $2, $3, $4, $4, $5, 'gitlab', 'existing', 'xdev-team', $4, '{}', $6, $7) returning id`,
      [org.orgId, org.teamId, org.systemId, key, scmId, randomUUID(), uid("owner")],
    )
  ).rows[0].id as string;
  const config = {
    method: "jenkins-job",
    schemaVersion: 1,
    connectionId: jenkinsId,
    jobPath: `${key}/deploy`,
    branch: null,
    params: [{ name: "COMMIT", value: "{{commit}}" }],
    promote: null,
    rollbackJob: null,
    credential,
    health: null,
  };
  return (
    await admin.query(
      `insert into hive.deploy_targets (org_id, project_id, environment_id, method, config, updated_by)
       values ($1, $2, $3, 'jenkins-job', $4, $5) returning id`,
      [org.orgId, projectId, environmentId, JSON.stringify(config), uid("tadmin")],
    )
  ).rows[0].id as string;
}

async function newMachine(name: string): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `insert into hive.machines (id, org_id, team_id, name, os, version, status, last_seen_at)
     values ($1, $2, $3, $4, 'linux', 'test', 'online', now())`,
    [id, org.orgId, org.teamId, name],
  );
  return id;
}

const jobsOf = async (deployId: string) =>
  (
    await admin.query(
      "select id, state, worker_id, wait_reason, error_code, spec from hive.delivery_jobs where deploy_id = $1 order by created_at",
      [deployId],
    )
  ).rows as Array<{
    id: string;
    state: string;
    worker_id: string | null;
    wait_reason: string | null;
    error_code: string | null;
    spec: Record<string, unknown>;
  }>;
const deployRow = async (id: string) =>
  (await admin.query("select state, steps, ran_legacy from hive.deploys where id = $1", [id])).rows[0] as {
    state: string;
    steps: Array<{ key: string; state: string; message: string | null }>;
    ran_legacy: boolean;
  };
const audits = async (action: string, targetId: string) =>
  (
    await admin.query(
      "select data, actor_user_id from hive.audit_log where org_id = $1 and action = $2 and target_id = $3",
      [org.orgId, action, targetId],
    )
  ).rows as Array<{ data: Record<string, unknown>; actor_user_id: string }>;

beforeAll(async () => {
  org = await seedOrg(admin, `delivery-dispatch-${randomUUID().slice(0, 8)}`);
  scmId = randomUUID();
  await admin.query(
    "insert into hive.scm_connections (id, org_id, kind, name, secret_enc, created_by) values ($1, $2, 'gitlab', 'GitLab', 'x', $3)",
    [scmId, org.orgId, uid("owner")],
  );
  jenkinsId = randomUUID();
  await admin.query(
    `insert into hive.ci_jenkins_connections (id, org_id, name, url, watcher_user_id, created_by)
     values ($1, $2, 'jenkins', 'https://jenkins.example.invalid', $3, $3)`,
    [jenkinsId, org.orgId, uid("owner")],
  );
  const env = (name: string, policy: Parameters<typeof createEnvironment>[2]["policy"]) =>
    as("tadmin", (tx) => createEnvironment(tx, uid("tadmin"), { systemId: org.systemId, name, policy }));
  devId = (await env("dev", { deployRoles: [], approveRoles: [], approvals: 0, approvalTtlHours: 24 })).id;
  prodId = (await env("prod", { deployRoles: [], approveRoles: ["admin"], approvals: 1, approvalTtlHours: 12 })).id;
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("giao lần triển khai cho máy chạy", () => {
  it("chưa có máy thì chờ kèm lý do; máy có đủ credential bật lên thì nhịp sau giao, hub không tự chạy", async () => {
    const h = harness();
    const deploy = await h.create("tmember", await newTarget(devId));
    expect(deploy.state).toBe("queued");
    await h.start(deploy.id);

    const [waiting] = await jobsOf(deploy.id);
    expect(waiting).toMatchObject({ state: "waiting", worker_id: null });
    expect(waiting?.wait_reason).toContain("trực tuyến");
    // Spec chỉ mang tên credential; tham số đã thay bằng commit của lần này.
    expect(waiting?.spec).toMatchObject({
      kind: "jenkins-job",
      deployId: deploy.id,
      target: { baseUrl: "https://jenkins.example.invalid" },
      credential: "jenkins-ci",
      params: { parameters: { COMMIT: SHA } },
    });
    expect(await deployRow(deploy.id)).toMatchObject({ state: "queued", ran_legacy: false });
    const view = await as("tmember", (tx) => getDeploy(tx, uid("tmember"), deploy.id));
    expect(view.runner).toEqual({ mode: "worker", machine: null, waiting: waiting?.wait_reason });
    expect(h.enqueued.filter((e) => e.queue === DELIVERY_JOB_CHECK_QUEUE)).toHaveLength(1);

    // Máy trực tuyến nhưng thiếu credential: vẫn chờ, lý do đổi để người bấm biết thêm credential ở đâu.
    const machine = await newMachine("deploy-1");
    await withTenant(app, { orgId: org.orgId }, (tx) =>
      recordDeliveryCapability(tx, machine, { methods: ["jenkins-job"], credentials: ["khac"], kinds: [] }, h.at()),
    );
    h.advance(30_000);
    await h.check(String(waiting?.id));
    expect((await jobsOf(deploy.id))[0]?.wait_reason).toContain("credential");

    await withTenant(app, { orgId: org.orgId }, (tx) =>
      recordDeliveryCapability(
        tx,
        machine,
        { methods: ["jenkins-job"], credentials: ["jenkins-ci"], kinds: [] },
        h.at(),
      ),
    );
    h.advance(30_000);
    await h.check(String(waiting?.id));
    expect(await jobsOf(deploy.id)).toEqual([
      expect.objectContaining({ id: waiting?.id, state: "leased", worker_id: machine, wait_reason: null }),
    ]);
    const leased = await as("tmember", (tx) => getDeploy(tx, uid("tmember"), deploy.id));
    expect(leased.runner).toEqual({ mode: "worker", machine: { id: machine, name: "deploy-1" }, waiting: null });

    // Job bắt đầu chạy lại (pg-boss thử lại) không tạo việc thứ hai.
    await h.start(deploy.id);
    expect(await jobsOf(deploy.id)).toHaveLength(1);
  });

  it("máy đã chọn đang tắt: quá 15 phút không ai nhận thì lần triển khai thất bại, có bước Chờ máy chạy", async () => {
    const h = harness();
    const env = await as("tadmin", (tx) =>
      createEnvironment(tx, uid("tadmin"), {
        systemId: org.systemId,
        name: `uat-${randomUUID().slice(0, 4)}`,
        policy: { deployRoles: [], approveRoles: [], approvals: 0, approvalTtlHours: 24 },
      }),
    );
    await admin.query("update hive.deploy_environments set runner_machines = $2 where id = $1", [
      env.id,
      [randomUUID()],
    ]);
    const deploy = await h.create("tmember", await newTarget(env.id));
    await h.start(deploy.id);
    const [job] = await jobsOf(deploy.id);
    expect(job?.state).toBe("waiting");

    h.advance(RUNNER_WAIT_MS - 1000);
    await h.check(String(job?.id));
    expect((await deployRow(deploy.id)).state).toBe("queued");
    h.advance(1000);
    await h.check(String(job?.id));
    expect(await jobsOf(deploy.id)).toEqual([expect.objectContaining({ state: "failed", error_code: "no_runner" })]);
    const row = await deployRow(deploy.id);
    expect(row.state).toBe("failed");
    expect(row.steps.at(-1)).toMatchObject({ key: RUNNER_WAIT_STEP, state: "failed" });
    expect(row.steps.at(-1)?.message).toContain("15 phút");
  });

  it("huỷ lần đã giao: việc trên máy thành canceled, ghi audit kèm mã việc", async () => {
    const h = harness();
    const deploy = await h.create("tmember", await newTarget(devId));
    await h.start(deploy.id);
    const [job] = await jobsOf(deploy.id);
    expect(job?.state).toBe("leased");
    const canceled = await as("tmember", (tx) => cancelDeploy(tx, h.deps, uid("tmember"), deploy.id, { now: h.at }));
    expect(canceled.state).toBe("canceled");
    expect((await jobsOf(deploy.id))[0]?.state).toBe("canceled");
    expect((await audits("delivery.deploy.cancel", deploy.id))[0]?.data).toMatchObject({ jobs: [job?.id] });
  });
});

describe("cổng duyệt", () => {
  it("chưa đủ duyệt thì không giao; người yêu cầu không tự duyệt; đủ duyệt thì xếp hàng", async () => {
    const h = harness();
    const deploy = await h.create("tmember", await newTarget(prodId));
    expect(deploy.state).toBe("pending_approval");
    expect(h.enqueued.filter((e) => e.queue === DELIVERY_APPROVAL_EXPIRE_QUEUE)).toHaveLength(1);
    // Job bắt đầu chạy nhầm khi chưa duyệt: không giao việc.
    await h.start(deploy.id);
    expect(await jobsOf(deploy.id)).toEqual([]);

    const forAdmin = await as("tadmin", (tx) => pendingApprovals(tx, uid("tadmin")));
    expect(forAdmin.map((d) => d.id)).toContain(deploy.id);
    expect((await as("tmember", (tx) => pendingApprovals(tx, uid("tmember")))).map((d) => d.id)).not.toContain(
      deploy.id,
    );
    expect(
      await failure(() => as("tmember", (tx) => approveDeploy(tx, h.deps, uid("tmember"), { id: deploy.id }))),
    ).toMatchObject({ name: "ForbiddenError" });
    // Người xem đội không có deploy.approve.
    expect(
      await failure(() => as("tviewer", (tx) => approveDeploy(tx, h.deps, uid("tviewer"), { id: deploy.id }))),
    ).toMatchObject({ name: "ForbiddenError" });

    const approved = await as("tadmin", (tx) =>
      approveDeploy(tx, h.deps, uid("tadmin"), { id: deploy.id, comment: "Đã xem thay đổi" }),
    );
    expect(approved.state).toBe("queued");
    expect(approved.approval?.decisions).toEqual([
      expect.objectContaining({ decision: "approve", by: expect.objectContaining({ userId: uid("tadmin") }) }),
    ]);
    expect(h.enqueued.filter((e) => e.queue === DELIVERY_DEPLOY_QUEUE && e.data.deployId === deploy.id)).toHaveLength(
      1,
    );
    expect(await audits("delivery.deploy.approve", deploy.id)).toHaveLength(1);
    expect(
      await failure(() => as("tadmin", (tx) => approveDeploy(tx, h.deps, uid("tadmin"), { id: deploy.id }))),
    ).toMatchObject({ code: "DEPLOY_NOT_PENDING" });
    expect((await as("tadmin", (tx) => pendingApprovals(tx, uid("tadmin")))).map((d) => d.id)).not.toContain(deploy.id);
  });

  it("từ chối kèm lý do thì dừng hẳn, nhả đích cho lần sau", async () => {
    const h = harness();
    const targetId = await newTarget(prodId);
    const deploy = await h.create("tmember", targetId);
    const rejected = await as("tadmin", (tx) =>
      rejectDeploy(tx, h.deps, uid("tadmin"), { id: deploy.id, reason: "Chưa qua kiểm thử" }),
    );
    expect(rejected.state).toBe("rejected");
    expect((await audits("delivery.deploy.reject", deploy.id))[0]?.data).toMatchObject({ reason: "Chưa qua kiểm thử" });
    await h.start(deploy.id);
    expect(await jobsOf(deploy.id)).toEqual([]);
    expect((await h.create("tmember", targetId)).state).toBe("pending_approval");
  });

  it("hết hạn chờ duyệt thì expired; job chạy sớm thì hẹn lại", async () => {
    const h = harness();
    const deploy = await h.create("tmember", await newTarget(prodId));
    const expiresAt = new Date(String(deploy.approval?.expiresAt));
    const early = new Date(expiresAt.getTime() - 60_000);
    await withTenant(app, { orgId: org.orgId }, (tx) => expireApproval(tx, h.deps, deploy.id, early));
    expect((await deployRow(deploy.id)).state).toBe("pending_approval");
    expect(h.enqueued.filter((e) => e.queue === DELIVERY_APPROVAL_EXPIRE_QUEUE).at(-1)?.startAfter).toEqual(expiresAt);

    await withTenant(app, { orgId: org.orgId }, (tx) => expireApproval(tx, h.deps, deploy.id, expiresAt));
    expect((await deployRow(deploy.id)).state).toBe("expired");
    expect(
      await failure(() => as("tadmin", (tx) => approveDeploy(tx, h.deps, uid("tadmin"), { id: deploy.id }))),
    ).toMatchObject({ code: "DEPLOY_NOT_PENDING" });
  });
});
