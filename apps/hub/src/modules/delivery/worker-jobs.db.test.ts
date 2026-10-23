import { randomBytes, randomUUID } from "node:crypto";
import type { DeliveryEvent } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { createPool, type Jobs, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import {
  cancelDeliveryJobs,
  createDeliveryJob,
  expireLostJobs,
  ingestDeliveryEvent,
  LEASE_TTL_MS,
  renewLease,
} from "./worker-jobs.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const jobs: Jobs = {
  start: async () => {},
  stop: async () => {},
  enqueue: async () => randomUUID(),
  schedule: async () => {},
  work: async () => {},
};
const deps = { pool: app, masterKey, jobs };

const T0 = new Date("2026-10-23T10:00:00.000Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const WORKER = randomUUID();
const OTHER_WORKER = randomUUID();

let org: Awaited<ReturnType<typeof seedOrg>>;
let envId: string;
const as = <T>(run: (tx: Tx) => Promise<T>) => withTenant(app, { orgId: org.orgId, userId: org.user("owner") }, run);

beforeAll(async () => {
  org = await seedOrg(admin, `worker-jobs-${randomUUID().slice(0, 8)}`);
  const owner = org.user("owner");
  const scm = randomUUID();
  await admin.query(
    "insert into hive.scm_connections (id, org_id, kind, name, secret_enc, created_by) values ($1, $2, 'gitlab', 'gl', 'fixture', $3)",
    [scm, org.orgId, owner],
  );
  envId = (
    await admin.query(
      `insert into hive.deploy_environments (org_id, team_id, system_id, name, policy)
       values ($1, $2, $3, 'dev', '{"deployRoles":[],"approveRoles":[],"approvals":0,"approvalTtlHours":24}')
       returning id`,
      [org.orgId, org.teamId, org.systemId],
    )
  ).rows[0].id as string;
});

afterAll(async () => {
  await app.end();
  await admin.end();
});

async function newDeploy(state = "queued"): Promise<string> {
  // Mỗi lần một đích riêng vì mỗi đích chỉ một lần Hive đang đi.
  const scm = (await admin.query("select id from hive.scm_connections where org_id = $1", [org.orgId])).rows[0].id;
  const key = `p-${randomUUID().slice(0, 8)}`;
  const projectId = (
    await admin.query(
      `insert into hive.projects (org_id, team_id, system_id, key, name, scm_connection_id, scm_kind, repo_mode,
         repo_owner, repo_name, settings, idempotency_key, created_by)
       values ($1, $2, $3, $4, $4, $5, 'gitlab', 'existing', 'xdev-team', $4, '{}', $6, $7) returning id`,
      [org.orgId, org.teamId, org.systemId, key, scm, randomUUID(), org.user("owner")],
    )
  ).rows[0].id as string;
  const target = (
    await admin.query(
      `insert into hive.deploy_targets (org_id, project_id, environment_id, method, config)
       values ($1, $2, $3, 'jenkins-job', '{"method":"jenkins-job"}') returning id`,
      [org.orgId, projectId, envId],
    )
  ).rows[0].id as string;
  return (
    await admin.query(
      `insert into hive.deploys (org_id, target_id, method, origin, state, version, requested_by)
       values ($1, $2, 'jenkins-job', 'hive', $3, '{"commit":"abc"}', $4) returning id`,
      [org.orgId, target, state, org.user("owner")],
    )
  ).rows[0].id as string;
}

const deployOf = async (id: string) =>
  (await admin.query("select state, steps, external, ran_on_worker_id from hive.deploys where id = $1", [id])).rows[0];
const jobOf = async (id: string) =>
  (await admin.query("select state, last_seq, error_code, worker_id from hive.delivery_jobs where id = $1", [id]))
    .rows[0];

const ev = (jobId: string, seq: number, rest: Record<string, unknown>) =>
  ({ jobId, seq, at: at(seq).toISOString(), ...rest }) as DeliveryEvent;
const send = (event: DeliveryEvent, workerId = WORKER, now = at(event.seq)) =>
  as((tx) => ingestDeliveryEvent(tx, deps, { workerId, event, now }));

const SPEC = {
  kind: "jenkins-job" as const,
  deployId: null,
  configVersion: 1,
  target: { baseUrl: "https://jenkins.example.test", job: "app/deploy" },
  credential: "jenkins-ci",
  params: {},
  timeoutSeconds: 1800,
};

async function started() {
  const deployId = await newDeploy();
  const job = await as((tx) =>
    createDeliveryJob(tx, {
      orgId: org.orgId,
      deployId,
      kind: "jenkins-job",
      configVersion: 1,
      credentialNames: ["jenkins-ci"],
      workerId: WORKER,
      spec: SPEC,
      now: T0,
    }),
  );
  return { deployId, jobId: job.id };
}

describe("delivery_jobs", () => {
  it("tạo việc có lease cho máy đã chọn, việc không có máy thì chờ", async () => {
    const { jobId } = await started();
    expect(await jobOf(jobId)).toMatchObject({ state: "leased", worker_id: WORKER });
    const waiting = await as((tx) =>
      createDeliveryJob(tx, {
        orgId: org.orgId,
        deployId: null,
        kind: "argocd",
        configVersion: null,
        credentialNames: [],
        workerId: null,
        spec: { ...SPEC, kind: "argocd", deployId: null },
        waitReason: "Chưa có máy trực tuyến.",
        now: T0,
      }),
    );
    expect(waiting.state).toBe("waiting");
    expect(waiting.leaseExpiresAt).toBeNull();
    expect(waiting.waitReason).toBe("Chưa có máy trực tuyến.");
  });

  it("chạy trọn một lần: started, step, finished cập nhật lần triển khai và ghi máy đã chạy", async () => {
    const { deployId, jobId } = await started();
    expect(await send(ev(jobId, 0, { type: "started", workerId: "m1" }))).toBe("applied");
    expect(await send(ev(jobId, 1, { type: "step", name: "build", state: "running" }))).toBe("applied");
    expect((await deployOf(deployId)).state).toBe("running");
    expect(await send(ev(jobId, 2, { type: "step", name: "build", state: "succeeded", exitCode: 0 }))).toBe("applied");
    expect(await send(ev(jobId, 3, { type: "finished", state: "succeeded" }))).toBe("applied");
    const deploy = await deployOf(deployId);
    expect(deploy.state).toBe("succeeded");
    expect(deploy.ran_on_worker_id).toBe(WORKER);
    expect(deploy.steps[0]).toMatchObject({ key: "build", state: "succeeded" });
    expect(await jobOf(jobId)).toMatchObject({ state: "succeeded", last_seq: 3 });
  });

  it("sự kiện gửi lại hay đến sai thứ tự (seq không tăng) bị bỏ, không xử lý hai lần", async () => {
    const { deployId, jobId } = await started();
    await send(ev(jobId, 0, { type: "started", workerId: "m1" }));
    await send(ev(jobId, 1, { type: "step", name: "build", state: "running" }));
    expect(await send(ev(jobId, 1, { type: "step", name: "build", state: "failed" }))).toBe("duplicate");
    expect(await send(ev(jobId, 0, { type: "started", workerId: "m1" }))).toBe("duplicate");
    expect((await deployOf(deployId)).steps[0].state).toBe("running");
  });

  it("máy không giữ lease bị từ chối; việc lạ trả unknown_job", async () => {
    const { deployId, jobId } = await started();
    expect(await send(ev(jobId, 0, { type: "started", workerId: "x" }), OTHER_WORKER)).toBe("rejected");
    expect((await deployOf(deployId)).state).toBe("queued");
    expect(await send(ev(randomUUID(), 0, { type: "started", workerId: "x" }))).toBe("unknown_job");
  });

  it("lỗi: lưu mã và thông điệp ở việc, bước đang chạy thành failed", async () => {
    const { deployId, jobId } = await started();
    await send(ev(jobId, 0, { type: "started", workerId: "m1" }));
    await send(ev(jobId, 1, { type: "step", name: "build", state: "running" }));
    await send(
      ev(jobId, 2, { type: "finished", state: "failed", error: { code: "auth_failed", message: "Sai token." } }),
    );
    expect(await jobOf(jobId)).toMatchObject({ state: "failed", error_code: "auth_failed" });
    const deploy = await deployOf(deployId);
    expect(deploy.state).toBe("failed");
    expect(deploy.steps[0]).toMatchObject({ state: "failed", message: "Sai token." });
  });

  it("heartbeat kéo dài lease; quá hạn không heartbeat thì việc lost và lần triển khai unknown", async () => {
    const { deployId, jobId } = await started();
    await send(ev(jobId, 0, { type: "started", workerId: "m1" }));
    expect(await as((tx) => renewLease(tx, jobId, OTHER_WORKER, at(1)))).toBe(false);
    expect(await as((tx) => renewLease(tx, jobId, WORKER, at(60)))).toBe(true);
    // Chưa quá hạn kể từ lần heartbeat. Việc của test trước (không heartbeat) thì đã quá hạn nên không đếm số trả về.
    await as((tx) => expireLostJobs(tx, deps, at(60 + LEASE_TTL_MS / 1000 - 1)));
    expect((await jobOf(jobId)).state).toBe("running");
    const late = at(60 + LEASE_TTL_MS / 1000 + 1);
    expect(await as((tx) => expireLostJobs(tx, deps, late))).toBeGreaterThanOrEqual(1);
    expect(await jobOf(jobId)).toMatchObject({ state: "lost", error_code: "lease_expired" });
    expect((await deployOf(deployId)).state).toBe("unknown");
    // Máy đã mất lease báo tiếp thì bị từ chối (FR-023).
    expect(await send(ev(jobId, 1, { type: "finished", state: "succeeded" }), WORKER, late)).toBe("rejected");
    expect((await deployOf(deployId)).state).toBe("unknown");
  });

  it("huỷ từ hub: việc chưa xong thành canceled, báo cáo đến sau không đổi gì", async () => {
    const { deployId, jobId } = await started();
    const canceled = await as((tx) => cancelDeliveryJobs(tx, deployId, at(5)));
    expect(canceled.map((j) => j.id)).toEqual([jobId]);
    expect(await send(ev(jobId, 0, { type: "started", workerId: "m1" }))).toBe("duplicate");
    expect((await deployOf(deployId)).state).toBe("queued");
  });

  it("log không được ghi vào deploy_log_chunks", async () => {
    const { deployId, jobId } = await started();
    await send(ev(jobId, 0, { type: "started", workerId: "m1" }));
    await send(ev(jobId, 1, { type: "finished", state: "succeeded" }));
    const rows = (await admin.query("select 1 from hive.deploy_log_chunks where deploy_id = $1", [deployId])).rows;
    expect(rows).toHaveLength(0);
  });
});
