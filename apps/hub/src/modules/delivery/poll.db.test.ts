import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { createPool, encryptSecret, type Jobs, parseMasterKey, withTenant } from "../platform/index.ts";
import { createMemoryProvider, type MemoryProvider, type ScmEventContext } from "../scm/index.ts";
import { gitlabEventHandlers } from "./ci/gitlab-events.ts";
import {
  CI_POLL_BUSY_MS,
  CI_POLL_IDLE_MS,
  type CiPollDeps,
  GITLAB_RECHECK_MS,
  type JenkinsBuildFinished,
  onJenkinsBuildFinished,
  runCiPollJob,
} from "./ci/poll.ts";
import { runWebhookRefresh } from "./ci/webhook-refresh.ts";
import { createJenkinsConnection, upsertMyJenkinsToken } from "./connections/jenkins.ts";
import { DELIVERY_CI_POLL_QUEUE } from "./queues.ts";
import { type FakeHttp, startFakeHttp } from "./testing/fake-http.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));

const TOKEN = "jenkins-token-watcher-poll-0123456789";
const JENKINS_USER = "an.nguyen";
const PUBLIC_URL = "https://hive.example.test";
const REPO = { owner: "xdev-team", name: "billing" };
const JOB_PATH = "billing/build-main";
/** Đường dẫn URL của job trên Jenkins giả. */
const JOB = "/job/billing/job/build-main";

let org: Awaited<ReturnType<typeof seedOrg>>;
let projectId: string;
let connId: string;
let jenkins: FakeHttp;
let gitlab: MemoryProvider;
/** Đồng hồ cố định để kiểm giờ hẹn chạy lại chính xác tới mili giây. */
const clock = Date.now();

interface Enqueued {
  queue: string;
  data: Record<string, unknown>;
  opts: { singletonKey?: string; startAfter?: Date } | undefined;
}
let enqueued: Enqueued[] = [];
const fakeJobs = {
  enqueue: async (queue: string, data: Record<string, unknown>, opts?: Enqueued["opts"]) => {
    enqueued.push({ queue, data, opts });
    return randomUUID();
  },
  work: async () => {},
  schedule: async () => {},
  start: async () => {},
  stop: async () => {},
} as unknown as Jobs;
const ciPolls = () => enqueued.filter((e) => e.queue === DELIVERY_CI_POLL_QUEUE);
const lastPoll = () => ciPolls().at(-1);

const deps = (): CiPollDeps => ({
  pool: app,
  masterKey,
  providerFactory: () => gitlab,
  publicUrl: PUBLIC_URL,
  fetch: (input, init) => fetch(input, init),
  now: () => clock,
});

// Build Jenkins giả: mảng theo thứ tự cũ → mới, Jenkins trả mới nhất trước.
interface FakeBuild {
  number: number;
  result: "SUCCESS" | "FAILURE" | "UNSTABLE" | null;
  branch?: string;
}
let builds: FakeBuild[] = [];
let jenkinsRejects = false;
const buildJson = (b: FakeBuild) => ({
  number: b.number,
  url: `${jenkins.baseUrl}${JOB}/${b.number}/`,
  result: b.result,
  building: b.result === null,
  timestamp: clock - 3_600_000 + b.number * 60_000,
  duration: b.result === null ? 0 : 30_000,
  actions: [
    { causes: [{ shortDescription: "Started by SCM change" }] },
    {
      lastBuiltRevision: {
        SHA1: `abcdef${String(b.number).padStart(4, "0")}`,
        branch: [{ name: `refs/remotes/origin/${b.branch ?? "main"}` }],
      },
    },
  ],
});
const basicOk = (auth: string | undefined) =>
  auth === `Basic ${Buffer.from(`${JENKINS_USER}:${TOKEN}`).toString("base64")}`;

const count = async (event: string) =>
  Number(
    (
      await admin.query("select count(*)::int as n from hive.notifications where org_id = $1 and event = $2", [
        org.orgId,
        event,
      ])
    ).rows[0].n,
  );
const seen = async (source: string) =>
  (
    await admin.query(
      `select external_id, status, branch, finished_at, notified_state, updated_at from hive.ci_runs_seen
       where org_id = $1 and source = $2 order by external_id`,
      [org.orgId, source],
    )
  ).rows as Array<{
    external_id: string;
    status: string;
    branch: string | null;
    finished_at: Date | null;
    notified_state: string | null;
    updated_at: Date;
  }>;
const connection = async (id: string) =>
  (await admin.query("select last_error, last_poll_at from hive.ci_jenkins_connections where id = $1", [id]))
    .rows[0] as { last_error: string | null; last_poll_at: Date | null };

const pollJenkins = (connectionId = connId, failures?: number) =>
  runCiPollJob(deps(), fakeJobs, {
    kind: "jenkins",
    orgId: org.orgId,
    connectionId,
    ...(failures ? { failures } : {}),
  });

beforeAll(async () => {
  org = await seedOrg(admin, `delivery-poll-${randomUUID().slice(0, 8)}`);
  const scm = randomUUID();
  await admin.query(
    "insert into hive.scm_connections (id, org_id, kind, name, secret_enc, created_by) values ($1, $2, 'gitlab', 'GitLab ACME', $3, $4)",
    [
      scm,
      org.orgId,
      encryptSecret(masterKey, JSON.stringify({ token: "glpat-poll-0123456789" }), `scm_connections:${scm}`),
      org.user("owner"),
    ],
  );
  projectId = randomUUID();
  await admin.query(
    `insert into hive.projects (id, org_id, team_id, system_id, key, name, scm_connection_id, scm_kind, repo_mode,
       repo_owner, repo_name, settings, idempotency_key, created_by, state, webhook_secret_enc)
     values ($1, $2, $3, $4, 'billing', 'billing', $5, 'gitlab', 'existing', $6, $7, '{}', $8, $9, 'active', $10)`,
    [
      projectId,
      org.orgId,
      org.teamId,
      org.systemId,
      scm,
      REPO.owner,
      REPO.name,
      randomUUID(),
      org.user("owner"),
      encryptSecret(masterKey, "webhook-secret-0123456789", `projects:${projectId}:webhook`),
    ],
  );
  await admin.query(
    `insert into hive.project_provision_steps (org_id, project_id, position, kind, state, params)
     values ($1, $2, 1, 'add-webhook', 'done', $3)`,
    [org.orgId, projectId, JSON.stringify({ url: `${PUBLIC_URL}/api/v1/webhooks/${projectId}` })],
  );
  // Kênh của tổ chức nhận cả hai sự kiện: mỗi tin đỏ/xanh là một dòng hive.notifications.
  await admin.query(
    `insert into hive.notification_channels (org_id, kind, name, events, target, config_enc, created_by)
     values ($1, 'telegram', 'Nhóm CI', array['ci.failed', 'ci.recovered'], 'chat-1', 'x', $2)`,
    [org.orgId, org.user("owner")],
  );

  gitlab = createMemoryProvider("gitlab", [REPO.owner]);
  gitlab.seedRepo(REPO);

  jenkins = await startFakeHttp({
    "GET /me/api/json": (req) =>
      basicOk(req.headers.authorization)
        ? { json: { id: JENKINS_USER, fullName: "An Nguyen", absoluteUrl: "x" } }
        : { status: 401 },
    [`GET ${JOB}/api/json`]: (req) =>
      !jenkinsRejects && basicOk(req.headers.authorization)
        ? { json: { builds: [...builds].reverse().map(buildJson) } }
        : { status: 401 },
  });

  const owner = (name: string) => ({ userId: org.user(name), orgId: org.orgId });
  connId = (
    await withTenant(app, owner("admin"), (tx) =>
      createJenkinsConnection(tx, org.user("admin"), { name: "Jenkins ACME", url: jenkins.baseUrl }),
    )
  ).id;
  await withTenant(app, owner("admin"), (tx) =>
    upsertMyJenkinsToken(tx, { masterKey, fetch: (i, n) => fetch(i, n) }, org.user("admin"), {
      connectionId: connId,
      jenkinsUser: JENKINS_USER,
      token: TOKEN,
    }),
  );
  await admin.query(
    "insert into hive.ci_project_jobs (org_id, project_id, connection_id, job_path, created_by) values ($1, $2, $3, $4, $5)",
    [org.orgId, projectId, connId, JOB_PATH, org.user("tadmin")],
  );
});

afterAll(async () => {
  await jenkins?.close();
  await app.end();
  await admin.end();
});

describe("hỏi Jenkins theo lịch", () => {
  const finished: JenkinsBuildFinished[] = [];
  let off: () => void = () => {};
  beforeAll(() => {
    off = onJenkinsBuildFinished(async (event) => {
      finished.push(event);
    });
  });
  afterAll(() => off());

  it("lần đầu chỉ ghi nhận, không báo; rảnh thì hẹn lại sau 5 phút theo kết nối", async () => {
    builds = [{ number: 1, result: "FAILURE" }];
    enqueued = [];
    await pollJenkins();
    expect(await count("ci.failed")).toBe(0);
    expect(await seen("jenkins")).toMatchObject([{ status: "failed", branch: "main", notified_state: "failed" }]);
    expect(finished).toEqual([]);
    expect(lastPoll()).toMatchObject({
      data: { kind: "jenkins", orgId: org.orgId, connectionId: connId },
      opts: { singletonKey: connId, startAfter: new Date(clock + CI_POLL_IDLE_MS) },
    });
    const conn = await connection(connId);
    expect(conn.last_error).toBeNull();
    expect(conn.last_poll_at).not.toBeNull();
  });

  it("đỏ hai lần liên tiếp chỉ một tin; xanh lại một tin", async () => {
    builds.push({ number: 2, result: "SUCCESS" });
    await pollJenkins();
    // Lần đầu (build 1) chỉ ghi nhận, nên đỏ đó không tính là đã báo... nhưng đã ghi là đỏ: xanh này báo xanh lại.
    expect(await count("ci.recovered")).toBe(1);

    builds.push({ number: 3, result: "FAILURE" });
    await pollJenkins();
    expect(await count("ci.failed")).toBe(1);

    builds.push({ number: 4, result: "FAILURE" });
    await pollJenkins();
    expect(await count("ci.failed")).toBe(1);

    builds.push({ number: 5, result: "SUCCESS" });
    await pollJenkins();
    expect(await count("ci.recovered")).toBe(2);

    // Hỏi lại khi Jenkins không có gì mới: không đổi gì.
    await pollJenkins();
    expect(await count("ci.failed")).toBe(1);
    expect(await count("ci.recovered")).toBe(2);

    const [failed] = (
      await admin.query("select title, body, link from hive.notifications where org_id = $1 and event = 'ci.failed'", [
        org.orgId,
      ])
    ).rows as Array<{ title: string; body: string; link: string }>;
    expect(failed?.title).toContain("billing");
    expect(failed?.title).toContain("main");
    expect(failed?.body).toContain("#3");
    expect(failed?.link).toBe(`${PUBLIC_URL}/projects/billing/cicd`);
    expect(JSON.stringify(await seen("jenkins"))).not.toContain(TOKEN);
  });

  it("build xong được báo cho onJenkinsBuildFinished đúng một lần, trừ lần ghi nhận đầu", () => {
    expect(finished.map((f) => [f.build.number, f.run.status])).toEqual([
      [2, "success"],
      [3, "failed"],
      [4, "failed"],
      [5, "success"],
    ]);
    expect(finished[0]).toMatchObject({ orgId: org.orgId, connectionId: connId, projectId, jobPath: JOB_PATH });
  });

  it("đỏ ở nhánh khác không báo", async () => {
    builds.push({ number: 6, result: "FAILURE", branch: "feature/x" });
    await pollJenkins();
    expect(await count("ci.failed")).toBe(1);
    expect((await seen("jenkins")).find((r) => r.external_id.endsWith(":6"))).toMatchObject({
      branch: "feature/x",
      notified_state: null,
    });
  });

  it("có build đang chạy thì hẹn lại sau 15 giây; xong thì về chu kỳ rảnh", async () => {
    builds.push({ number: 7, result: null });
    await pollJenkins();
    expect(lastPoll()?.opts).toEqual({ singletonKey: connId, startAfter: new Date(clock + CI_POLL_BUSY_MS) });
    expect((await seen("jenkins")).find((r) => r.external_id.endsWith(":7"))?.status).toBe("running");

    (builds.at(-1) as FakeBuild).result = "FAILURE";
    await pollJenkins();
    expect(await count("ci.failed")).toBe(2);
    expect(lastPoll()?.opts).toEqual({ singletonKey: connId, startAfter: new Date(clock + CI_POLL_IDLE_MS) });
  });

  it("Jenkins không nhận token người theo dõi: ghi last_error, lùi lại; hết lỗi thì xoá", async () => {
    jenkinsRejects = true;
    await pollJenkins();
    const conn = await connection(connId);
    expect(conn.last_error).toMatch(/người theo dõi/);
    expect(conn.last_error).not.toContain(TOKEN);
    expect(lastPoll()).toMatchObject({
      data: { failures: 1 },
      opts: { singletonKey: connId, startAfter: new Date(clock + 5 * 60_000) },
    });

    await pollJenkins(connId, 1);
    expect(lastPoll()).toMatchObject({ data: { failures: 2 }, opts: { startAfter: new Date(clock + 10 * 60_000) } });

    jenkinsRejects = false;
    await pollJenkins(connId, 2);
    expect((await connection(connId)).last_error).toBeNull();
    expect(lastPoll()?.data.failures).toBeUndefined();
  });

  it("người theo dõi chưa có token: ghi last_error cho kết nối, không gọi Jenkins", async () => {
    const other = randomUUID();
    await admin.query(
      `insert into hive.ci_jenkins_connections (id, org_id, name, url, watcher_user_id, created_by)
       values ($1, $2, 'Jenkins phụ', $3, $4, $4)`,
      [other, org.orgId, jenkins.baseUrl, org.user("tmember")],
    );
    await admin.query(
      "insert into hive.ci_project_jobs (org_id, project_id, connection_id, job_path, created_by) values ($1, $2, $3, $4, $5)",
      [org.orgId, projectId, other, JOB_PATH, org.user("tadmin")],
    );
    const calls = jenkins.requests.length;
    await pollJenkins(other);
    expect((await connection(other)).last_error).toMatch(/chưa có token Jenkins/);
    expect(jenkins.requests.length).toBe(calls);
    expect(lastPoll()).toMatchObject({ data: { connectionId: other, failures: 1 }, opts: { singletonKey: other } });
  });

  it("kết nối không còn người theo dõi thì thôi hỏi", async () => {
    const lonely = randomUUID();
    await admin.query(
      `insert into hive.ci_jenkins_connections (id, org_id, name, url, watcher_user_id, created_by)
       values ($1, $2, 'Jenkins không người theo dõi', $3, null, $4)`,
      [lonely, org.orgId, jenkins.baseUrl, org.user("admin")],
    );
    const before = ciPolls().length;
    await pollJenkins(lonely);
    expect(ciPolls().length).toBe(before);
  });
});

describe("sự kiện pipeline GitLab", () => {
  const handlers = () => gitlabEventHandlers(deps(), fakeJobs);
  const ctx = (tx: ScmEventContext["tx"]): ScmEventContext => ({
    tx,
    orgId: org.orgId,
    projectId,
    deliveryRowId: randomUUID(),
    intake: {} as ScmEventContext["intake"],
    afterCommit: () => {},
  });
  const deliver = (event: ReturnType<MemoryProvider["pipelineEvent"]>) =>
    withTenant(app, { orgId: org.orgId }, (tx) => handlers().pipeline(event, ctx(tx)));
  const deliverJob = (event: ReturnType<MemoryProvider["jobEvent"]>) =>
    withTenant(app, { orgId: org.orgId }, (tx) => handlers().job(event, ctx(tx)));
  const row = async (pipelineId: string) =>
    (await seen("gitlab")).find((r) => r.external_id === `${projectId}:${pipelineId}`);
  const done = (status: "success" | "failed") => ({ status, finishedAt: new Date().toISOString() });

  it("webhook gửi lại không đổi kết quả: đỏ một tin, xanh lại một tin", async () => {
    const failedBefore = await count("ci.failed");
    const recoveredBefore = await count("ci.recovered");
    enqueued = [];

    const p1 = gitlab.seedPipeline(REPO, { status: "running" }).pipeline;
    await deliver(gitlab.pipelineEvent(REPO, p1.id));
    expect(await row(p1.id)).toMatchObject({ status: "running", branch: "main", finished_at: null });
    expect(lastPoll()).toMatchObject({
      data: { kind: "gitlab", orgId: org.orgId, projectId },
      opts: { singletonKey: `gitlab:${projectId}`, startAfter: new Date(clock + GITLAB_RECHECK_MS) },
    });

    gitlab.setPipeline(REPO, p1.id, done("failed"));
    await deliver(gitlab.pipelineEvent(REPO, p1.id));
    const first = await row(p1.id);
    await deliver(gitlab.pipelineEvent(REPO, p1.id));
    expect(await count("ci.failed")).toBe(failedBefore + 1);
    expect(await row(p1.id)).toEqual(first);
    expect(first).toMatchObject({ status: "failed", notified_state: "failed" });

    // Pipeline đỏ tiếp trên main: đã báo đỏ thì không báo lại.
    const p2 = gitlab.seedPipeline(REPO, { status: "failed" }).pipeline;
    gitlab.setPipeline(REPO, p2.id, done("failed"));
    await deliver(gitlab.pipelineEvent(REPO, p2.id));
    expect(await count("ci.failed")).toBe(failedBefore + 1);

    const p3 = gitlab.seedPipeline(REPO, { status: "success" }).pipeline;
    gitlab.setPipeline(REPO, p3.id, done("success"));
    await deliver(gitlab.pipelineEvent(REPO, p3.id));
    await deliver(gitlab.pipelineEvent(REPO, p3.id));
    expect(await count("ci.recovered")).toBe(recoveredBefore + 1);

    // Nhánh khác đỏ: ghi nhận, không báo.
    const p4 = gitlab.seedPipeline(REPO, { ref: "feature/y", status: "failed" }).pipeline;
    gitlab.setPipeline(REPO, p4.id, done("failed"));
    await deliver(gitlab.pipelineEvent(REPO, p4.id));
    expect(await count("ci.failed")).toBe(failedBefore + 1);
    expect(await row(p4.id)).toMatchObject({ status: "failed", notified_state: null });
  });

  it("job chạy lại đưa pipeline về đang chạy; hỏi lại 5 phút sau thấy đỏ thì báo", async () => {
    const failedBefore = await count("ci.failed");
    const { pipeline: p, jobs } = gitlab.seedPipeline(REPO, {
      status: "success",
      jobs: [{ name: "test", status: "success" }],
    });
    gitlab.setPipeline(REPO, p.id, done("success"));
    await deliver(gitlab.pipelineEvent(REPO, p.id));
    expect(await row(p.id)).toMatchObject({ status: "success", notified_state: "success" });

    enqueued = [];
    const jobId = jobs[0]?.id as string;
    gitlab.setJob(REPO, jobId, { status: "running" });
    await deliverJob(gitlab.jobEvent(REPO, jobId));
    expect(await row(p.id)).toMatchObject({ status: "running", notified_state: "success" });
    expect(lastPoll()?.opts?.singletonKey).toBe(`gitlab:${projectId}`);

    // Webhook pipeline bị lỡ: lần hỏi lại đọc GitLab và báo đỏ.
    gitlab.setPipeline(REPO, p.id, done("failed"));
    enqueued = [];
    await runCiPollJob(deps(), fakeJobs, { kind: "gitlab", orgId: org.orgId, projectId });
    expect(await row(p.id)).toMatchObject({ status: "failed", notified_state: "failed" });
    expect(await count("ci.failed")).toBe(failedBefore + 1);
    // Không còn pipeline chưa xong thì thôi hỏi lại.
    expect(ciPolls()).toEqual([]);
  });

  it("còn pipeline chưa xong thì hỏi lại sau 5 phút", async () => {
    const p = gitlab.seedPipeline(REPO, { status: "pending" }).pipeline;
    await deliver(gitlab.pipelineEvent(REPO, p.id));
    enqueued = [];
    await runCiPollJob(deps(), fakeJobs, { kind: "gitlab", orgId: org.orgId, projectId });
    expect(lastPoll()).toMatchObject({
      opts: { singletonKey: `gitlab:${projectId}`, startAfter: new Date(clock + GITLAB_RECHECK_MS) },
    });
    gitlab.setPipeline(REPO, p.id, done("success"));
    await runCiPollJob(deps(), fakeJobs, { kind: "gitlab", orgId: org.orgId, projectId });
    expect(await row(p.id)).toMatchObject({ status: "success" });
  });
});

describe("quét định kỳ", () => {
  it("hẹn hỏi Jenkins có người theo dõi và hỏi lại pipeline GitLab chưa xong, không đụng kết nối thiếu người theo dõi", async () => {
    const pending = gitlab.seedPipeline(REPO, { status: "running" }).pipeline;
    await admin.query(
      `insert into hive.ci_runs_seen (org_id, project_id, source, external_id, status, branch)
       values ($1, $2, 'gitlab', $3, 'running', 'main')`,
      [org.orgId, projectId, `${projectId}:${pending.id}`],
    );
    enqueued = [];
    await runCiPollJob(deps(), fakeJobs, { kind: "scan" });
    // Cùng container có tổ chức của file test khác; chỉ xét việc của tổ chức này.
    const keys = ciPolls()
      .filter((e) => e.data.orgId === org.orgId)
      .map((e) => e.opts?.singletonKey);
    expect(keys).toEqual(expect.arrayContaining([connId, `gitlab:${projectId}`]));
    // Kết nối của test trước: có người theo dõi (dù chưa có token) thì vẫn hỏi để ghi last_error; không ai theo dõi thì bỏ.
    const lonely = await admin.query<{ id: string }>(
      "select id from hive.ci_jenkins_connections where org_id = $1 and watcher_user_id is null",
      [org.orgId],
    );
    expect(lonely.rows).not.toHaveLength(0);
    for (const { id } of lonely.rows) expect(keys).not.toContain(id);
  });
});

describe("đăng ký lại webhook GitLab", () => {
  it("mỗi tổ chức một lần: lần sau không gọi GitLab nữa", async () => {
    const refreshDeps = { pool: app, masterKey, providerFactory: () => gitlab, publicUrl: PUBLIC_URL };
    const hooks = () => gitlab.calls.filter((c) => c.method === "addWebhook").length;
    const before = hooks();
    await runWebhookRefresh(refreshDeps, { version: "test", orgIds: [org.orgId] });
    expect(hooks()).toBe(before + 1);
    await runWebhookRefresh(refreshDeps, { version: "test", orgIds: [org.orgId] });
    expect(hooks()).toBe(before + 1);
  });
});
