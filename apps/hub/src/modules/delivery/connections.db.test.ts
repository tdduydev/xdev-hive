import { randomBytes, randomUUID } from "node:crypto";
import {
  ciProjectJob,
  connectionTestResult,
  infraConnection,
  jenkinsConnection,
  jenkinsTokenItem,
} from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { addProjectJob, listProjectJobs, removeProjectJob } from "./ci/project-jobs.ts";
import { jenkinsAuth } from "./connections/credentials.ts";
import {
  createInfraConnection,
  listInfraConnections,
  removeInfraConnection,
  testInfraConnection,
  updateInfraConnection,
} from "./connections/infra.ts";
import {
  createJenkinsConnection,
  listJenkinsConnections,
  listMyJenkinsTokens,
  removeJenkinsConnection,
  removeMyJenkinsToken,
  setJenkinsWatcher,
  testJenkinsConnection,
  testMyJenkinsToken,
  upsertMyJenkinsToken,
} from "./connections/jenkins.ts";
import { type FakeHttp, type FakeRequest, startFakeHttp } from "./testing/fake-http.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));

// Token giả đủ dài để tìm được trong mọi dữ liệu trả về, audit và cột mã hoá.
const TOKENS = {
  tadmin: "jenkins-token-tadmin-0123456789",
  tmember: "jenkins-token-tmember-0123456789",
  argo: "argo-token-0123456789abcdef",
  argoNew: "argo-token-new-0123456789abcdef",
  kube: "kube-token-0123456789abcdef",
};
const JENKINS_USERS: Record<string, string> = { "an.nguyen": TOKENS.tadmin, "binh.tran": TOKENS.tmember };

let org: Awaited<ReturnType<typeof seedOrg>>;
let projectId: string;
let jenkins: FakeHttp;
let argo: FakeHttp;
const deps = () => ({ masterKey, fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, init) });

const as = <T>(name: string, run: (tx: Tx) => Promise<T>) =>
  withTenant(app, { orgId: org.orgId, userId: org.user(name) }, run);
const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return { name: (error as Error).name, code: (error as { code?: string }).code };
  }
  return undefined;
};
const basicUser = (req: FakeRequest): string | null => {
  const raw = req.headers.authorization?.replace(/^Basic /, "");
  if (!raw) return null;
  const [user, token] = Buffer.from(raw, "base64").toString("utf8").split(":");
  return user && JENKINS_USERS[user] === token ? user : null;
};
const leaksToken = (value: unknown) => {
  const text = JSON.stringify(value);
  return Object.values(TOKENS).some((t) => text.includes(t));
};

beforeAll(async () => {
  org = await seedOrg(admin, `delivery-conn-${randomUUID().slice(0, 8)}`);
  const scm = randomUUID();
  await admin.query(
    "insert into hive.scm_connections (id, org_id, kind, name, secret_enc, created_by) values ($1, $2, 'gitlab', 'gl', 'fixture', $3)",
    [scm, org.orgId, org.user("owner")],
  );
  projectId = (
    await admin.query(
      `insert into hive.projects (org_id, team_id, system_id, key, name, scm_connection_id, scm_kind, repo_mode,
         repo_owner, repo_name, settings, idempotency_key, created_by)
       values ($1, $2, $3, 'billing', 'billing', $4, 'gitlab', 'existing', 'xdev-team', 'billing', '{}', $5, $6)
       returning id`,
      [org.orgId, org.teamId, org.systemId, scm, randomUUID(), org.user("owner")],
    )
  ).rows[0].id as string;

  jenkins = await startFakeHttp({
    "GET /me/api/json": (req) => {
      const user = basicUser(req);
      return user ? { json: { id: user, fullName: user, absoluteUrl: `x/user/${user}` } } : { status: 401 };
    },
    "GET /job/billing/job/build-dev/api/json": (req) =>
      basicUser(req)
        ? { json: { name: "build-dev", fullName: "billing/build-dev", url: "x", buildable: true, property: [] } }
        : { status: 401 },
  });
  argo = await startFakeHttp({
    "GET /api/v1/applications": (req) =>
      req.headers.authorization === `Bearer ${TOKENS.argoNew}` || req.headers.authorization === `Bearer ${TOKENS.argo}`
        ? { json: { items: [{ metadata: { name: "billing" } }] } }
        : { status: 401, json: { error: "invalid session", message: "invalid session" } },
    "GET /api/version": { json: { Version: "v2.13.1" } },
  });
});

afterAll(async () => {
  await Promise.all([jenkins.close(), argo.close(), admin.end(), app.end()]);
});

describe("kết nối Jenkins, token cá nhân, người theo dõi", () => {
  let connId: string;

  it("chỉ quản trị tổ chức tạo được; người tạo là người theo dõi", async () => {
    expect(
      await failure(() =>
        as("tadmin", (tx) => createJenkinsConnection(tx, org.user("tadmin"), { name: "x", url: "y" })),
      ),
    ).toEqual({ name: "ForbiddenError", code: "ORG_ROLE_REQUIRED" });

    const conn = await as("admin", (tx) =>
      createJenkinsConnection(tx, org.user("admin"), { name: "ACME Jenkins", url: jenkins.baseUrl }),
    );
    connId = conn.id;
    expect(jenkinsConnection.parse(conn)).toMatchObject({
      name: "ACME Jenkins",
      watcher: { userId: org.user("admin") },
      watcherHasToken: false,
    });
    expect(
      await failure(() =>
        as("admin", (tx) => createJenkinsConnection(tx, org.user("admin"), { name: "ACME Jenkins", url: "z" })),
      ),
    ).toEqual({ name: "ConflictError", code: "CONNECTION_NAME_TAKEN" });
  });

  it("token sai thì không lưu; token đúng lưu mã hoá và chỉ trả user Jenkins", async () => {
    expect(
      await failure(() =>
        as("tadmin", (tx) =>
          upsertMyJenkinsToken(tx, deps(), org.user("tadmin"), {
            connectionId: connId,
            jenkinsUser: "an.nguyen",
            token: "token-sai-0123456789",
          }),
        ),
      ),
    ).toEqual({ name: "ForbiddenError", code: "JENKINS_UNAUTHORIZED" });

    const item = await as("tadmin", (tx) =>
      upsertMyJenkinsToken(tx, deps(), org.user("tadmin"), {
        connectionId: connId,
        jenkinsUser: "an.nguyen",
        token: TOKENS.tadmin,
      }),
    );
    expect(jenkinsTokenItem.parse(item).token).toMatchObject({ jenkinsUser: "an.nguyen", lastCheckOk: true });
    expect(leaksToken(item)).toBe(false);

    const stored = await admin.query("select token_enc from hive.ci_jenkins_user_tokens where connection_id = $1", [
      connId,
    ]);
    expect(stored.rows).toHaveLength(1);
    expect(leaksToken(stored.rows)).toBe(false);
  });

  it("danh sách chỉ có token của chính mình, kể cả với quản trị", async () => {
    const mine = await as("tadmin", (tx) => listMyJenkinsTokens(tx, org.user("tadmin")));
    expect(mine.find((i) => i.connectionId === connId)?.token?.jenkinsUser).toBe("an.nguyen");
    for (const name of ["admin", "tmember"]) {
      const others = await as(name, (tx) => listMyJenkinsTokens(tx, org.user(name)));
      expect(others.find((i) => i.connectionId === connId)?.token).toBeNull();
    }
  });

  it("token của người A không dùng được cho người B", async () => {
    expect(
      await failure(() =>
        as("tmember", (tx) =>
          jenkinsAuth(tx, masterKey, { connectionId: connId, userId: org.user("tmember"), reason: "ci.retry" }),
        ),
      ),
    ).toEqual({ name: "ForbiddenError", code: "JENKINS_NO_TOKEN" });
    const result = await as("tmember", (tx) => testMyJenkinsToken(tx, deps(), org.user("tmember"), connId));
    expect(result.ok).toBe(false);

    const before = jenkins.callsTo("GET /me/api/json").length;
    const own = await as("tadmin", (tx) => testMyJenkinsToken(tx, deps(), org.user("tadmin"), connId));
    expect(connectionTestResult.parse(own)).toMatchObject({ ok: true, user: "an.nguyen" });
    expect(basicUser(jenkins.callsTo("GET /me/api/json")[before] as FakeRequest)).toBe("an.nguyen");
  });

  it("người theo dõi phải có token; kiểm kết nối dùng token người theo dõi", async () => {
    const noToken = await as("admin", (tx) => testJenkinsConnection(tx, deps(), org.user("admin"), connId));
    expect(noToken.ok).toBe(false);
    expect(
      await failure(() =>
        as("admin", (tx) => setJenkinsWatcher(tx, org.user("admin"), { id: connId, userId: org.user("tmember") })),
      ),
    ).toEqual({ name: "ConflictError", code: "WATCHER_NO_TOKEN" });
    expect(
      await failure(() =>
        as("tadmin", (tx) => setJenkinsWatcher(tx, org.user("tadmin"), { id: connId, userId: org.user("tadmin") })),
      ),
    ).toEqual({ name: "ForbiddenError", code: "ORG_ROLE_REQUIRED" });

    const conn = await as("admin", (tx) =>
      setJenkinsWatcher(tx, org.user("admin"), { id: connId, userId: org.user("tadmin") }),
    );
    expect(conn).toMatchObject({ watcher: { userId: org.user("tadmin") }, watcherHasToken: true });
    const ok = await as("admin", (tx) => testJenkinsConnection(tx, deps(), org.user("admin"), connId));
    expect(ok).toMatchObject({ ok: true, user: "an.nguyen" });

    const listed = await as("tviewer", (tx) => listJenkinsConnections(tx));
    expect(listed.find((c) => c.id === connId)?.watcherHasToken).toBe(true);
    expect(leaksToken(listed)).toBe(false);
  });

  it("gắn job: cần servers.manage của đội, kiểm job trên Jenkins, người ngoài đội không thấy dự án", async () => {
    const input = { projectId, connectionId: connId, jobPath: "billing/build-dev" };
    expect(await failure(() => as("tmember", (tx) => addProjectJob(tx, deps(), org.user("tmember"), input)))).toEqual({
      name: "ForbiddenError",
      code: "TEAM_ROLE_REQUIRED",
    });
    expect(
      await failure(() =>
        as("tadmin", (tx) => addProjectJob(tx, deps(), org.user("tadmin"), { ...input, jobPath: "billing/khong-co" })),
      ),
    ).toEqual({ name: "NotFoundError", code: "JENKINS_NOT_FOUND" });

    // Quản trị tổ chức chưa có token: hub đọc job bằng token người theo dõi.
    const job = await as("admin", (tx) => addProjectJob(tx, deps(), org.user("admin"), input));
    expect(ciProjectJob.parse(job)).toMatchObject({
      jobPath: "billing/build-dev",
      connectionName: "ACME Jenkins",
      url: `${jenkins.baseUrl}/job/billing/job/build-dev/`,
    });
    expect(await failure(() => as("tadmin", (tx) => addProjectJob(tx, deps(), org.user("tadmin"), input)))).toEqual({
      name: "ConflictError",
      code: "CI_JOB_EXISTS",
    });

    expect(await as("tviewer", (tx) => listProjectJobs(tx, org.user("tviewer"), projectId))).toHaveLength(1);
    expect(await failure(() => as("oadmin", (tx) => listProjectJobs(tx, org.user("oadmin"), projectId)))).toEqual({
      name: "NotFoundError",
      code: "NOT_FOUND",
    });
    expect(
      await failure(() => as("oadmin", (tx) => removeProjectJob(tx, org.user("oadmin"), { projectId, jobId: job.id }))),
    ).toEqual({ name: "NotFoundError", code: "NOT_FOUND" });
    expect(await as("tadmin", (tx) => removeProjectJob(tx, org.user("tadmin"), { projectId, jobId: job.id }))).toEqual({
      ok: true,
    });
    await as("tadmin", (tx) => addProjectJob(tx, deps(), org.user("tadmin"), input));
  });

  it("xoá token của mình thì người theo dõi mất token", async () => {
    await as("tmember", (tx) =>
      upsertMyJenkinsToken(tx, deps(), org.user("tmember"), {
        connectionId: connId,
        jenkinsUser: "binh.tran",
        token: TOKENS.tmember,
      }),
    );
    await as("tadmin", (tx) => removeMyJenkinsToken(tx, org.user("tadmin"), connId));
    const listed = await as("admin", (tx) => listJenkinsConnections(tx));
    expect(listed.find((c) => c.id === connId)?.watcherHasToken).toBe(false);
    // Token của người khác vẫn còn.
    const other = await as("tmember", (tx) => listMyJenkinsTokens(tx, org.user("tmember")));
    expect(other.find((i) => i.connectionId === connId)?.token?.jenkinsUser).toBe("binh.tran");
  });

  it("xoá kết nối xoá token của mọi người và job đã gắn", async () => {
    expect(await failure(() => as("tadmin", (tx) => removeJenkinsConnection(tx, org.user("tadmin"), connId)))).toEqual({
      name: "ForbiddenError",
      code: "ORG_ROLE_REQUIRED",
    });
    await as("admin", (tx) => removeJenkinsConnection(tx, org.user("admin"), connId));
    const count = async (table: string) =>
      (await admin.query(`select count(*)::int as n from hive.${table} where connection_id = $1`, [connId])).rows[0].n;
    expect(await count("ci_jenkins_user_tokens")).toBe(0);
    expect(await count("ci_project_jobs")).toBe(0);
  });
});

describe("kết nối Argo CD và Kubernetes", () => {
  it("tạo, kiểm, thay token; không bao giờ trả token", async () => {
    expect(
      await failure(() =>
        as("tadmin", (tx) =>
          createInfraConnection(tx, { masterKey }, org.user("tadmin"), {
            kind: "argocd",
            name: "argo",
            url: argo.baseUrl,
            token: TOKENS.argo,
          }),
        ),
      ),
    ).toEqual({ name: "ForbiddenError", code: "ORG_ROLE_REQUIRED" });

    const conn = await as("admin", (tx) =>
      createInfraConnection(tx, { masterKey }, org.user("admin"), {
        kind: "argocd",
        name: "argo",
        url: argo.baseUrl,
        token: TOKENS.argo,
      }),
    );
    expect(infraConnection.parse(conn)).toMatchObject({ kind: "argocd", caPem: null });
    expect(leaksToken(conn)).toBe(false);

    const ok = await as("admin", (tx) => testInfraConnection(tx, deps(), org.user("admin"), conn.id));
    expect(ok).toMatchObject({ ok: true, version: "v2.13.1" });
    expect(argo.callsTo("GET /api/v1/applications").at(-1)?.headers.authorization).toBe(`Bearer ${TOKENS.argo}`);

    expect(
      await failure(() =>
        as("admin", (tx) =>
          updateInfraConnection(tx, { masterKey }, org.user("admin"), {
            id: conn.id,
            caPem: "-----BEGIN CERTIFICATE-----",
          }),
        ),
      ),
    ).toEqual({ name: "BadRequestError", code: "CA_NOT_SUPPORTED" });
    await as("admin", (tx) =>
      updateInfraConnection(tx, { masterKey }, org.user("admin"), { id: conn.id, token: TOKENS.argoNew }),
    );
    await as("admin", (tx) => testInfraConnection(tx, deps(), org.user("admin"), conn.id));
    expect(argo.callsTo("GET /api/v1/applications").at(-1)?.headers.authorization).toBe(`Bearer ${TOKENS.argoNew}`);

    const listed = await as("tviewer", (tx) => listInfraConnections(tx));
    expect(listed.map((c) => c.id)).toContain(conn.id);
    expect(leaksToken(listed)).toBe(false);
    const stored = await admin.query("select token_enc from hive.deploy_connections where id = $1", [conn.id]);
    expect(leaksToken(stored.rows)).toBe(false);

    await as("admin", (tx) => removeInfraConnection(tx, org.user("admin"), conn.id));
    expect(await as("admin", (tx) => listInfraConnections(tx))).toEqual([]);
  });

  it("Kubernetes không nối được thì báo tại chỗ, không lộ token", async () => {
    const conn = await as("admin", (tx) =>
      createInfraConnection(tx, { masterKey }, org.user("admin"), {
        kind: "kubernetes",
        name: "k8s",
        url: "https://127.0.0.1:1",
        token: TOKENS.kube,
      }),
    );
    const result = await as("admin", (tx) => testInfraConnection(tx, deps(), org.user("admin"), conn.id));
    expect(result.ok).toBe(false);
    expect(leaksToken(result)).toBe(false);
  });
});

describe("audit", () => {
  it("ghi mọi thao tác và không có giá trị token", async () => {
    const { rows } = await admin.query("select action, data from hive.audit_log where org_id = $1", [org.orgId]);
    const actions = new Set(rows.map((r) => r.action as string));
    for (const a of [
      "delivery.ci_connection.create",
      "delivery.ci_connection.watcher",
      "delivery.ci_connection.remove",
      "delivery.ci_token.create",
      "delivery.ci_token.remove",
      "delivery.ci_job.add",
      "delivery.ci_job.remove",
      "delivery.infra_connection.create",
      "delivery.infra_connection.update",
      "delivery.infra_connection.remove",
      "delivery.secret_used",
    ])
      expect(actions).toContain(a);
    expect(leaksToken(rows)).toBe(false);
  });
});
