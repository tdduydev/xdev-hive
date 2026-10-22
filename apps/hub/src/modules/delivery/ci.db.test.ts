import { randomBytes, randomUUID } from "node:crypto";
import { ciFeed as ciFeedSchema, ciLogChunk, ciRunDetail } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { createPool, encryptSecret, parseMasterKey, withTenant } from "../platform/index.ts";
import { createMemoryProvider, type MemoryProvider } from "../scm/index.ts";
import { ciBuild, ciCancel, ciInput, ciPlay, ciRetry, ciStop } from "./ci/actions.ts";
import { ciDetail, ciJenkinsParams } from "./ci/detail.ts";
import { type CiDeps, ciFeed, clearCiFeedCache } from "./ci/feed.ts";
import { ciLog } from "./ci/logs.ts";
import { addProjectJob } from "./ci/project-jobs.ts";
import { createJenkinsConnection, upsertMyJenkinsToken } from "./connections/jenkins.ts";
import { type FakeHttp, type FakeRequest, startFakeHttp } from "./testing/fake-http.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));

const TOKENS = {
  watcher: "jenkins-token-watcher-0123456789",
  member: "jenkins-token-member-0123456789",
  gitlab: "glpat-project-connection-0123456789",
  password: "db-password-0123456789",
};
// an.nguyen là người theo dõi (quản trị tổ chức), binh.tran là thành viên đội có token riêng.
const JENKINS_USERS: Record<string, string> = { "an.nguyen": TOKENS.watcher, "binh.tran": TOKENS.member };

const T = Date.parse("2026-10-20T12:00:00Z");
const hoursAgo = (h: number) => new Date(T - h * 3_600_000).toISOString();
const REPO = { owner: "xdev-team", name: "billing" };
const JOB = "/job/billing/job/build-dev";

let org: Awaited<ReturnType<typeof seedOrg>>;
let projectId: string;
let connId: string;
let jobId: string;
let jenkins: FakeHttp;
let gitlab: MemoryProvider;
let clock = T;
const pipelines: Record<string, string> = {};
const jobs: Record<string, string> = {};

const deps = (): CiDeps => ({
  pool: app,
  masterKey,
  providerFactory: () => gitlab,
  fetch: (input, init) => fetch(input, init),
  now: () => clock,
});
const actor = (name: string) => ({ userId: org.user(name), orgId: org.orgId });

const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return { name: (error as Error).name, code: (error as { code?: string }).code, message: (error as Error).message };
  }
  return undefined;
};
const basicUser = (req: FakeRequest | undefined): string | null => {
  const raw = req?.headers.authorization?.replace(/^Basic /, "");
  if (!raw) return null;
  const [user, token] = Buffer.from(raw, "base64").toString("utf8").split(":");
  return user && JENKINS_USERS[user] === token ? user : null;
};
const authed =
  (body: (req: FakeRequest) => { status?: number; json?: unknown; body?: string; headers?: Record<string, string> }) =>
  (req: FakeRequest) =>
    basicUser(req) ? body(req) : { status: 401 };
const leaksToken = (value: unknown) => {
  const text = JSON.stringify(value);
  return Object.values(TOKENS).some((t) => text.includes(t));
};
const audits = async (action: string) =>
  (
    await admin.query(
      "select actor_user_id, data from hive.audit_log where org_id = $1 and action = $2 order by created_at",
      [org.orgId, action],
    )
  ).rows as Array<{ actor_user_id: string; data: Record<string, unknown> }>;

const jenkinsBuild = (n: number, building: boolean, startedAt: string) => ({
  number: n,
  url: `${jenkins.baseUrl}${JOB}/${n}/`,
  result: building ? null : "SUCCESS",
  building,
  timestamp: Date.parse(startedAt),
  duration: building ? 0 : 60_000,
  actions: [
    { causes: [{ shortDescription: "Started by user", userId: "an.nguyen", userName: "An Nguyen" }] },
    { lastBuiltRevision: { SHA1: `sha${n}`, branch: [{ name: "refs/remotes/origin/main" }] } },
    { parameters: [{ name: "BRANCH", value: "main" }] },
  ],
});

/** Job hoặc danh sách build, tuỳ `tree`, như Jenkins. */
const jobApi = authed((req) =>
  req.query.get("tree")?.startsWith("builds")
    ? { json: { builds: [jenkinsBuild(2, true, hoursAgo(1)), jenkinsBuild(1, false, hoursAgo(3))] } }
    : {
        json: {
          name: "build-dev",
          fullName: "billing/build-dev",
          url: `${jenkins.baseUrl}${JOB}/`,
          buildable: true,
          property: [
            {
              parameterDefinitions: [
                {
                  name: "BRANCH",
                  type: "StringParameterDefinition",
                  description: "Nhánh",
                  defaultParameterValue: { value: "main" },
                },
                {
                  name: "DB_PASS",
                  type: "PasswordParameterDefinition",
                  description: "",
                  defaultParameterValue: { value: "" },
                },
              ],
            },
          ],
        },
      },
);

beforeAll(async () => {
  org = await seedOrg(admin, `delivery-ci-${randomUUID().slice(0, 8)}`);
  const scm = randomUUID();
  await admin.query(
    "insert into hive.scm_connections (id, org_id, kind, name, secret_enc, created_by) values ($1, $2, 'gitlab', 'GitLab ACME', $3, $4)",
    [
      scm,
      org.orgId,
      encryptSecret(masterKey, JSON.stringify({ token: TOKENS.gitlab }), `scm_connections:${scm}`),
      org.user("owner"),
    ],
  );
  projectId = (
    await admin.query(
      `insert into hive.projects (org_id, team_id, system_id, key, name, scm_connection_id, scm_kind, repo_mode,
         repo_owner, repo_name, settings, idempotency_key, created_by)
       values ($1, $2, $3, 'billing', 'billing', $4, 'gitlab', 'existing', $5, $6, '{}', $7, $8)
       returning id`,
      [org.orgId, org.teamId, org.systemId, scm, REPO.owner, REPO.name, randomUUID(), org.user("owner")],
    )
  ).rows[0].id as string;

  // GitLab: ba pipeline, Jenkins: hai build xen giữa (Independent Test của US1).
  gitlab = createMemoryProvider("gitlab", [REPO.owner]);
  gitlab.seedRepo(REPO);
  const p1 = gitlab.seedPipeline(REPO, { status: "success", jobs: [{ name: "build", status: "success" }] });
  const p2 = gitlab.seedPipeline(REPO, {
    ref: "feature/x",
    status: "failed",
    jobs: [{ name: "test", status: "failed", log: "FAIL\n" }],
  });
  const p3 = gitlab.seedPipeline(REPO, {
    status: "manual",
    jobs: [
      { name: "build", stage: "build", status: "success", log: "compile ok\n" },
      { name: "deploy", stage: "deploy", status: "manual" },
    ],
  });
  for (const [p, h] of [
    [p1, 4],
    [p2, 2],
    [p3, 0.5],
  ] as const)
    gitlab.setPipeline(REPO, p.pipeline.id, { startedAt: hoursAgo(h), user: "an" });
  Object.assign(pipelines, { p1: p1.pipeline.id, p2: p2.pipeline.id, p3: p3.pipeline.id });
  Object.assign(jobs, { failed: p2.jobs[0]?.id, build: p3.jobs[0]?.id, deploy: p3.jobs[1]?.id });

  jenkins = await startFakeHttp({
    "GET /me/api/json": authed((req) => {
      const user = basicUser(req);
      return { json: { id: user, fullName: user, absoluteUrl: `x/user/${user}` } };
    }),
    [`GET ${JOB}/api/json`]: jobApi,
    [`GET ${JOB}/2/api/json`]: authed(() => ({ json: jenkinsBuild(2, true, hoursAgo(1)) })),
    [`GET ${JOB}/1/api/json`]: authed(() => ({ json: jenkinsBuild(1, false, hoursAgo(3)) })),
    [`GET ${JOB}/2/wfapi/describe`]: authed(() => ({
      json: {
        status: "PAUSED_PENDING_INPUT",
        stages: [
          { id: "6", name: "Build", status: "SUCCESS", startTimeMillis: T - 3_600_000, durationMillis: 30_000 },
          { id: "12", name: "Deploy", status: "PAUSED_PENDING_INPUT", startTimeMillis: T, durationMillis: 0 },
        ],
      },
    })),
    [`GET ${JOB}/2/wfapi/pendingInputActions`]: authed(() => ({
      json: [{ id: "Approve", message: "Lên production?", proceedText: "Proceed", inputs: [] }],
    })),
    [`GET ${JOB}/2/logText/progressiveText`]: authed((req) =>
      req.query.get("start") === "0"
        ? { body: "Started\n", headers: { "x-text-size": "8", "x-more-data": "true" } }
        : { body: "", headers: { "x-text-size": "8", "x-more-data": "true" } },
    ),
    [`POST ${JOB}/buildWithParameters`]: authed(() => ({
      status: 201,
      headers: { location: `${jenkins.baseUrl}/queue/item/9/` },
    })),
    "GET /queue/item/9/api/json": authed(() => ({
      json: { id: 9, cancelled: false, executable: { number: 3, url: `${jenkins.baseUrl}${JOB}/3/` } },
    })),
    [`POST ${JOB}/2/stop`]: authed(() => ({ status: 403, body: "binh.tran is missing the Job/Cancel permission" })),
    [`POST ${JOB}/2/input/Approve/proceed`]: authed(() => ({ status: 200 })),
  });

  const conn = await withTenant(app, actor("admin"), (tx) =>
    createJenkinsConnection(tx, org.user("admin"), { name: "ACME Jenkins", url: jenkins.baseUrl }),
  );
  connId = conn.id;
  for (const [name, jenkinsUser] of [
    ["admin", "an.nguyen"],
    ["tmember", "binh.tran"],
  ] as const) {
    await withTenant(app, actor(name), (tx) =>
      upsertMyJenkinsToken(tx, deps(), org.user(name), {
        connectionId: connId,
        jenkinsUser,
        token: JENKINS_USERS[jenkinsUser] as string,
      }),
    );
  }
  jobId = (
    await withTenant(app, actor("tadmin"), (tx) =>
      addProjectJob(tx, deps(), org.user("tadmin"), { projectId, connectionId: connId, jobPath: "billing/build-dev" }),
    )
  ).id;
});

beforeEach(() => {
  clearCiFeedCache();
  clock = T;
});

afterAll(async () => {
  await Promise.all([jenkins.close(), admin.end(), app.end()]);
});

const feed = (name: string, extra: Record<string, unknown> = {}) =>
  ciFeed(deps(), actor(name), { projectId, limit: 30, ...extra });

describe("danh sách gộp", () => {
  it("3 pipeline GitLab và 2 build Jenkins, mới nhất trước", async () => {
    const res = ciFeedSchema.parse(await feed("tmember"));
    expect(res.items.map((r) => r.id)).toEqual([
      `gitlab:${pipelines.p3}`,
      `jenkins:${jobId}:2`,
      `gitlab:${pipelines.p2}`,
      `jenkins:${jobId}:1`,
      `gitlab:${pipelines.p1}`,
    ]);
    expect(res.items[0]).toMatchObject({ status: "waiting", source: "gitlab", triggeredBy: "an" });
    expect(res.items[1]).toMatchObject({ status: "running", branch: "main", title: "billing/build-dev #2", jobId });
    expect(res.sources).toEqual([
      expect.objectContaining({ source: "gitlab", state: "ok", hasMyToken: null, label: "GitLab xdev-team/billing" }),
      expect.objectContaining({ source: "jenkins", jobId, state: "ok", hasMyToken: true }),
    ]);
    expect(res.nextCursor).toBeNull();
    expect(leaksToken(res)).toBe(false);
  });

  it("người có token đọc bằng token của mình; người chưa có thì bằng token người theo dõi", async () => {
    const calls = () => jenkins.callsTo(`GET ${JOB}/api/json`);
    const before = calls().length;
    await feed("tmember");
    expect(basicUser(calls()[before])).toBe("binh.tran");

    const viewer = await feed("tviewer");
    expect(basicUser(calls()[before + 1])).toBe("an.nguyen");
    expect(viewer.sources.find((s) => s.jobId === jobId)).toMatchObject({ state: "ok", hasMyToken: false });
  });

  it("lọc nguồn, nhánh, trạng thái; phân trang", async () => {
    expect((await feed("tmember", { source: "jenkins" })).items.map((r) => r.source)).toEqual(["jenkins", "jenkins"]);
    expect((await feed("tmember", { branch: "feature/x" })).items.map((r) => r.id)).toEqual([`gitlab:${pipelines.p2}`]);
    expect((await feed("tmember", { status: "success" })).items.map((r) => r.id)).toEqual([
      `jenkins:${jobId}:1`,
      `gitlab:${pipelines.p1}`,
    ]);

    const first = await feed("tmember", { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe("2");
    const second = await feed("tmember", { limit: 2, cursor: first.nextCursor });
    const third = await feed("tmember", { limit: 2, cursor: second.nextCursor });
    expect([...first.items, ...second.items, ...third.items].map((r) => r.id)).toEqual(
      (await feed("tmember")).items.map((r) => r.id),
    );
    expect(third.nextCursor).toBeNull();
  });

  it("đệm 10 giây; nguồn lỗi thì trả dữ liệu lần cuối kèm stale, không chặn nguồn khác", async () => {
    const calls = () => jenkins.callsTo(`GET ${JOB}/api/json`).length;
    await feed("tmember");
    const before = calls();
    clock = T + 5_000;
    await feed("tmember");
    expect(calls()).toBe(before);

    jenkins.route(`GET ${JOB}/api/json`, { status: 503 });
    clock = T + 11_000;
    const res = await feed("tmember");
    expect(calls()).toBe(before + 1);
    expect(res.sources.find((s) => s.source === "gitlab")).toMatchObject({ state: "ok", stale: false });
    expect(res.sources.find((s) => s.jobId === jobId)).toMatchObject({
      state: "stale",
      stale: true,
      fetchedAt: new Date(T).toISOString(),
    });
    expect(res.items).toHaveLength(5);

    // Chưa có lần đọc nào thành công thì báo lỗi ở nguồn đó, nguồn khác vẫn có.
    clearCiFeedCache();
    const fresh = await feed("tmember");
    expect(fresh.sources.find((s) => s.jobId === jobId)).toMatchObject({ state: "error", stale: false });
    expect(fresh.items.map((r) => r.source)).toEqual(["gitlab", "gitlab", "gitlab"]);
    jenkins.route(`GET ${JOB}/api/json`, jobApi);
  });

  it("job không ai có token thì báo chưa có token", async () => {
    const other = await withTenant(app, actor("admin"), (tx) =>
      createJenkinsConnection(tx, org.user("admin"), { name: "Jenkins cũ", url: jenkins.baseUrl }),
    );
    const orphan = (
      await admin.query(
        "insert into hive.ci_project_jobs (org_id, project_id, connection_id, job_path, created_by) values ($1, $2, $3, 'legacy', $4) returning id",
        [org.orgId, projectId, other.id, org.user("tadmin")],
      )
    ).rows[0].id as string;
    try {
      const res = await feed("tmember");
      expect(res.sources.find((s) => s.jobId === orphan)).toMatchObject({
        state: "no_token",
        hasMyToken: false,
        message: expect.stringContaining("Chưa có token để đọc Jenkins"),
      });
      expect(res.items).toHaveLength(5);
    } finally {
      await admin.query("delete from hive.ci_jenkins_connections where id = $1", [other.id]);
    }
  });

  it("thành viên tổ chức ngoài đội có ci.view nên xem được (FR-030); dự án lạ thì không thấy", async () => {
    expect((await feed("loner")).items).toHaveLength(5);
    expect(await failure(() => ciFeed(deps(), actor("tmember"), { projectId: randomUUID(), limit: 30 }))).toMatchObject(
      { name: "NotFoundError" },
    );
  });
});

describe("chi tiết và log", () => {
  it("pipeline GitLab: job, job chờ tay chạy được", async () => {
    const detail = ciRunDetail.parse(
      await ciDetail(deps(), actor("tviewer"), { projectId, runId: `gitlab:${pipelines.p3}` }),
    );
    expect(detail.run).toMatchObject({ id: `gitlab:${pipelines.p3}`, status: "waiting" });
    expect(detail.steps.map((s) => [s.name, s.group, s.status, s.playable])).toEqual([
      ["build", "build", "success", false],
      ["deploy", "deploy", "waiting", true],
    ]);
  });

  it("build Jenkins: giai đoạn, bước input đang chờ", async () => {
    const detail = ciRunDetail.parse(
      await ciDetail(deps(), actor("tviewer"), { projectId, runId: `jenkins:${jobId}:2` }),
    );
    expect(detail.run.status).toBe("waiting");
    expect(detail.steps.map((s) => [s.name, s.kind, s.status])).toEqual([
      ["Build", "stage", "success"],
      ["Deploy", "stage", "waiting"],
    ]);
    expect(detail.pendingInputs).toEqual([{ id: "Approve", message: "Lên production?" }]);
  });

  it("tham số Jenkins không lộ mật khẩu", async () => {
    const { parameters } = await ciJenkinsParams(deps(), actor("tviewer"), { projectId, jobId });
    expect(parameters).toEqual([
      { type: "string", name: "BRANCH", description: "Nhánh", default: "main" },
      { type: "password", name: "DB_PASS", description: null },
    ]);
  });

  it("log theo đoạn từ nguồn", async () => {
    expect(
      ciLogChunk.parse(
        await ciLog(deps(), actor("tviewer"), {
          projectId,
          runId: `gitlab:${pipelines.p3}`,
          stepId: jobs.build,
          from: 0,
        }),
      ),
    ).toEqual({ text: "compile ok\n", next: 11, more: false });
    expect(await ciLog(deps(), actor("tviewer"), { projectId, runId: `jenkins:${jobId}:2`, from: 0 })).toEqual({
      text: "Started\n",
      next: 8,
      more: true,
    });
    expect(
      await failure(() => ciLog(deps(), actor("tviewer"), { projectId, runId: `gitlab:${pipelines.p3}`, from: 0 })),
    ).toMatchObject({ code: "CI_STEP_REQUIRED" });
  });

  it("không đọc được lượt CI của nguồn khác hay job của dự án khác", async () => {
    expect(
      await failure(() => ciDetail(deps(), actor("tviewer"), { projectId, runId: `github:${pipelines.p3}` })),
    ).toMatchObject({ code: "CI_NOT_FOUND" });
    expect(
      await failure(() => ciDetail(deps(), actor("tviewer"), { projectId, runId: `jenkins:${randomUUID()}:2` })),
    ).toMatchObject({ name: "NotFoundError" });
  });
});

describe("thao tác", () => {
  it("cần ci.operate: người xem của đội và thành viên ngoài đội bị từ chối", async () => {
    for (const name of ["tviewer", "loner"])
      expect(
        await failure(() => ciRetry(deps(), actor(name), { projectId, runId: `gitlab:${pipelines.p2}` })),
      ).toMatchObject({ name: "ForbiddenError", code: "CI_OPERATE_REQUIRED" });
    expect(gitlab.calls.filter((c) => c.method === "retryPipeline")).toHaveLength(0);
  });

  it("GitLab: chạy lại job, huỷ pipeline, chạy job chờ tay bằng token kết nối của dự án", async () => {
    const retried = await ciRetry(deps(), actor("tmember"), {
      projectId,
      runId: `gitlab:${pipelines.p2}`,
      stepId: jobs.failed,
    });
    expect(retried).toMatchObject({ ok: true, runId: `gitlab:${pipelines.p2}` });
    expect(retried.stepId).not.toBe(jobs.failed);

    const played = await ciPlay(deps(), actor("tmember"), {
      projectId,
      runId: `gitlab:${pipelines.p3}`,
      stepId: jobs.deploy as string,
    });
    expect(played).toMatchObject({ ok: true, stepId: jobs.deploy });

    expect(await ciCancel(deps(), actor("tmember"), { projectId, runId: `gitlab:${pipelines.p3}` })).toMatchObject({
      ok: true,
    });
    expect(gitlab.calls.map((c) => c.method)).toEqual(
      expect.arrayContaining(["retryJob", "playJob", "cancelPipeline"]),
    );

    // Nguồn từ chối (job đã dừng) thì báo lỗi và vẫn ghi audit.
    expect(
      await failure(() =>
        ciCancel(deps(), actor("tmember"), { projectId, runId: `gitlab:${pipelines.p1}`, stepId: jobs.failed }),
      ),
    ).toMatchObject({ name: "ConflictError", code: "CI_WRONG_STATE" });
    const rows = await audits("delivery.ci.cancel");
    expect(rows.map((r) => r.data.ok)).toEqual([true, false]);
    expect(rows.every((r) => r.actor_user_id === org.user("tmember"))).toBe(true);
  });

  it("Jenkins: build có tham số bằng token người bấm; mật khẩu không vào audit", async () => {
    const before = jenkins.callsTo(`POST ${JOB}/buildWithParameters`).length;
    const res = await ciBuild(deps(), actor("tmember"), {
      projectId,
      jobId,
      params: { BRANCH: "release", DB_PASS: TOKENS.password },
    });
    expect(res).toEqual({ ok: true, runId: `jenkins:${jobId}:3`, stepId: null });
    const call = jenkins.callsTo(`POST ${JOB}/buildWithParameters`)[before];
    expect(basicUser(call)).toBe("binh.tran");
    expect(new URLSearchParams(call?.body).get("BRANCH")).toBe("release");

    const [row] = await audits("delivery.ci.build");
    expect(row).toMatchObject({
      actor_user_id: org.user("tmember"),
      data: {
        ok: true,
        source: "jenkins",
        jobPath: "billing/build-dev",
        jenkinsUser: "binh.tran",
        params: { BRANCH: "release", DB_PASS: "***" },
        resultRunId: `jenkins:${jobId}:3`,
      },
    });

    expect(
      await failure(() => ciBuild(deps(), actor("tmember"), { projectId, jobId, params: { NOPE: "x" } })),
    ).toMatchObject({ code: "CI_PARAM_UNKNOWN" });
  });

  it("Jenkins: chưa có token của chính mình thì không mượn token người theo dõi", async () => {
    const before = jenkins.requests.length;
    expect(await failure(() => ciBuild(deps(), actor("tadmin"), { projectId, jobId, params: {} }))).toMatchObject({
      name: "ForbiddenError",
      code: "JENKINS_NO_TOKEN",
    });
    expect(jenkins.requests.length).toBe(before);
  });

  it("Jenkins: thiếu quyền ở nguồn thì nói rõ tài khoản, quyền, job", async () => {
    const err = await failure(() => ciStop(deps(), actor("tmember"), { projectId, runId: `jenkins:${jobId}:2` }));
    expect(err).toMatchObject({ name: "ForbiddenError", code: "JENKINS_FORBIDDEN" });
    expect(err?.message).toContain("binh.tran");
    expect(err?.message).toContain("Job/Cancel");
    expect(err?.message).toContain("billing/build-dev");
    expect((await audits("delivery.ci.stop")).map((r) => r.data)).toEqual([
      expect.objectContaining({ ok: false, error: "JENKINS_FORBIDDEN" }),
    ]);
  });

  it("Jenkins: Proceed bước input, chạy lại build cũ với tham số cũ", async () => {
    expect(
      await ciInput(deps(), actor("tmember"), {
        projectId,
        runId: `jenkins:${jobId}:2`,
        inputId: "Approve",
        action: "proceed",
      }),
    ).toMatchObject({ ok: true });
    expect(basicUser(jenkins.callsTo(`POST ${JOB}/2/input/Approve/proceed`)[0])).toBe("binh.tran");

    const before = jenkins.callsTo(`POST ${JOB}/buildWithParameters`).length;
    expect(await ciRetry(deps(), actor("tmember"), { projectId, runId: `jenkins:${jobId}:1` })).toMatchObject({
      runId: `jenkins:${jobId}:3`,
    });
    expect(new URLSearchParams(jenkins.callsTo(`POST ${JOB}/buildWithParameters`)[before]?.body).get("BRANCH")).toBe(
      "main",
    );
    expect(
      await failure(() => ciCancel(deps(), actor("tmember"), { projectId, runId: `jenkins:${jobId}:1` })),
    ).toMatchObject({ code: "CI_UNSUPPORTED" });
  });

  it("audit và dữ liệu trả về không có token", async () => {
    const { rows } = await admin.query("select action, data from hive.audit_log where org_id = $1", [org.orgId]);
    const actions = new Set(rows.map((r) => r.action as string));
    for (const a of ["retry", "cancel", "play", "build", "stop", "input"])
      expect(actions).toContain(`delivery.ci.${a}`);
    expect(leaksToken(rows)).toBe(false);
  });
});
