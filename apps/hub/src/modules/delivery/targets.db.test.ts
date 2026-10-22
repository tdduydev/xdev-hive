import { randomBytes, randomUUID } from "node:crypto";
import { DELIVERY_ERRORS, deployTarget, environmentPolicy, type TargetUpsertInput } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { createPool, decryptSecret, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { effectivePermissions } from "../tenancy/index.ts";
import { createEnvironment, listEnvironments, reorderEnvironments, updateEnvironment } from "./environments.ts";
import { getTarget, listTargets, removeTarget, targetVariableContext, upsertTarget } from "./targets.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const deps = { masterKey };

const SECRET = "mat-khau-rat-bi-mat-0123456789";
const SECRET2 = "mat-khau-moi-bi-mat-9876543210";

let org: Awaited<ReturnType<typeof seedOrg>>;
let projectId: string;
let otherProjectId: string;
let serverId: string;
let otherServerId: string;
let argoId: string;
let jenkinsId: string;
let devId: string;
let stagingId: string;

const as = <T>(name: string, run: (tx: Tx) => Promise<T>) =>
  withTenant(app, { orgId: org.orgId, userId: org.user(name) }, run);
const uid = (name: string) => org.user(name);
const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    const e = error as { name: string; code?: string; data?: Record<string, unknown> };
    return { name: e.name, code: e.code, data: e.data };
  }
  return undefined;
};
const audits = async (action: string) =>
  (
    await admin.query(
      "select data, target_id from hive.audit_log where org_id = $1 and action = $2 order by created_at",
      [org.orgId, action],
    )
  ).rows as Array<{ data: Record<string, unknown>; target_id: string }>;

const sshConfig = (extra: Record<string, unknown> = {}) =>
  ({
    method: "ssh-script",
    schemaVersion: 1,
    serverId,
    workdir: "/opt/billing",
    composeProject: "billing",
    steps: {
      precheck: { script: "docker compose config -q" },
      backup: null,
      upload: { mode: "none" },
      deploy: { script: "docker compose up -d" },
    },
    variables: [
      { name: "APP_ENV", secret: false, value: "staging" },
      { name: "DB_PASSWORD", secret: true, value: SECRET },
    ],
    ...extra,
  }) as TargetUpsertInput["config"];

const upsert = (name: string, input: Partial<TargetUpsertInput> & { config: TargetUpsertInput["config"] }) =>
  as(name, (tx) =>
    upsertTarget(tx, deps, uid(name), {
      projectId,
      environmentId: devId,
      expectedConfigVersion: null,
      ...input,
    }),
  );

beforeAll(async () => {
  org = await seedOrg(admin, `delivery-tgt-${randomUUID().slice(0, 8)}`);
  const scm = randomUUID();
  await admin.query(
    "insert into hive.scm_connections (id, org_id, kind, name, secret_enc, created_by) values ($1, $2, 'gitlab', 'GitLab', 'x', $3)",
    [scm, org.orgId, uid("owner")],
  );
  // Dự án có khoá ngoại tới kết nối Git nên tạo kết nối trước.
  const projectWithScm = async (key: string, systemId: string, teamId: string) =>
    (
      await admin.query(
        `insert into hive.projects (org_id, team_id, system_id, key, name, scm_connection_id, scm_kind, repo_mode,
           repo_owner, repo_name, settings, idempotency_key, created_by)
         values ($1, $2, $3, $4, $4, $5, 'gitlab', 'existing', 'xdev-team', $4, '{}', $6, $7)
         returning id`,
        [org.orgId, teamId, systemId, key, scm, randomUUID(), uid("owner")],
      )
    ).rows[0].id as string;
  projectId = await projectWithScm("billing", org.systemId, org.teamId);
  otherProjectId = await projectWithScm("crm", org.otherSystemId, org.otherTeamId);

  const server = async (teamId: string, name: string) => {
    const id = randomUUID();
    await admin.query(
      `insert into hive.deploy_servers (id, org_id, team_id, name, host, ssh_user, private_key_enc, public_key, created_by)
       values ($1, $2, $3, $4, 'host.example.invalid', 'deploy', 'enc', 'ssh-ed25519 AAAA', $5)`,
      [id, org.orgId, teamId, name, uid("owner")],
    );
    return id;
  };
  serverId = await server(org.teamId, "web-1");
  otherServerId = await server(org.otherTeamId, "crm-1");
  argoId = randomUUID();
  await admin.query(
    `insert into hive.deploy_connections (id, org_id, kind, name, url, token_enc, created_by)
     values ($1, $2, 'argocd', 'argo', 'https://argocd.example.invalid', 'enc', $3)`,
    [argoId, org.orgId, uid("owner")],
  );
  jenkinsId = randomUUID();
  await admin.query(
    `insert into hive.ci_jenkins_connections (id, org_id, name, url, created_by)
     values ($1, $2, 'ci', 'https://jenkins.example.invalid', $3)`,
    [jenkinsId, org.orgId, uid("owner")],
  );
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

const actor = uid;

describe("môi trường", () => {
  it("thành viên đội chỉ có deploy.run không tạo được môi trường", async () => {
    const perms = await as("tmember", (tx) => effectivePermissions(tx, uid("tmember"), org.teamId));
    expect(perms.has("deploy.run")).toBe(true);
    expect(perms.has("servers.manage")).toBe(false);
    const err = await failure(() =>
      as("tmember", (tx) =>
        createEnvironment(tx, actor("tmember"), {
          systemId: org.systemId,
          name: "dev",
          policy: environmentPolicy.parse({}),
        }),
      ),
    );
    expect(err).toMatchObject({ name: "ForbiddenError", code: "SERVERS_MANAGE_REQUIRED" });
  });

  it("quản trị đội tạo môi trường, xếp cuối, hạn chờ mặc định 24 giờ", async () => {
    const dev = await as("tadmin", (tx) =>
      createEnvironment(tx, actor("tadmin"), {
        systemId: org.systemId,
        name: "dev",
        policy: { deployRoles: [], approveRoles: [], approvals: 0, approvalTtlHours: 24 },
      }),
    );
    const staging = await as("tadmin", (tx) =>
      createEnvironment(tx, actor("tadmin"), {
        systemId: org.systemId,
        name: "staging",
        policy: { deployRoles: [], approveRoles: [], approvals: 0, approvalTtlHours: 24 },
      }),
    );
    const prod = await as("tadmin", (tx) =>
      createEnvironment(tx, actor("tadmin"), {
        systemId: org.systemId,
        name: "prod",
        policy: { deployRoles: ["admin"], approveRoles: ["admin"], approvals: 1, approvalTtlHours: 24 },
      }),
    );
    devId = dev.id;
    stagingId = staging.id;
    expect([dev.position, staging.position, prod.position]).toEqual([0, 1, 2]);
    expect(dev.policy.approvalTtlHours).toBe(24);
    expect(dev.lock).toBeNull();
    expect((await audits("delivery.environment.create")).length).toBe(3);
  });

  it("trùng tên trong hệ thống thì báo ENV_NAME_TAKEN", async () => {
    const err = await failure(() =>
      as("tadmin", (tx) =>
        createEnvironment(tx, actor("tadmin"), {
          systemId: org.systemId,
          name: "dev",
          policy: environmentPolicy.parse({}),
        }),
      ),
    );
    expect(err).toMatchObject({ name: "ConflictError", code: "ENV_NAME_TAKEN" });
  });

  it("thành viên tổ chức ở đội khác chỉ xem được, không sửa được", async () => {
    const list = await as("oadmin", (tx) => listEnvironments(tx, uid("oadmin"), org.systemId));
    expect(list.map((e) => e.name)).toEqual(["dev", "staging", "prod"]);
    const err = await failure(() =>
      as("oadmin", (tx) => updateEnvironment(tx, actor("oadmin"), { id: list[0]?.id as string, name: "dev2" })),
    );
    expect(err).toMatchObject({ name: "ForbiddenError", code: "SERVERS_MANAGE_REQUIRED" });
    const viewer = await as("tviewer", (tx) => listEnvironments(tx, uid("tviewer"), org.systemId));
    expect(viewer.map((e) => e.name)).toEqual(["dev", "staging", "prod"]);
  });

  it("sửa tên và chính sách, ghi audit khác biệt", async () => {
    const updated = await as("tadmin", (tx) =>
      updateEnvironment(tx, actor("tadmin"), {
        id: stagingId,
        policy: { deployRoles: [], approveRoles: ["admin"], approvals: 1, approvalTtlHours: 48 },
      }),
    );
    expect(updated.policy).toMatchObject({ approvals: 1, approvalTtlHours: 48, approveRoles: ["admin"] });
    const [entry] = (await audits("delivery.environment.update")).slice(-1);
    expect(entry?.data).toMatchObject({ policy: { to: { approvalTtlHours: 48 } } });
    const denied = await failure(() =>
      as("tmember", (tx) => updateEnvironment(tx, actor("tmember"), { id: stagingId, name: "stg" })),
    );
    expect(denied).toMatchObject({ name: "ForbiddenError", code: "SERVERS_MANAGE_REQUIRED" });
  });

  it("sắp lại thứ tự cần đủ mọi môi trường", async () => {
    const all = await as("tadmin", (tx) => listEnvironments(tx, uid("tadmin"), org.systemId));
    const ids = all.map((e) => e.id);
    const bad = await failure(() =>
      as("tadmin", (tx) => reorderEnvironments(tx, actor("tadmin"), { systemId: org.systemId, ids: ids.slice(1) })),
    );
    expect(bad).toMatchObject({ name: "BadRequestError", code: "ENV_ORDER_MISMATCH" });
    const reversed = await as("tadmin", (tx) =>
      reorderEnvironments(tx, actor("tadmin"), { systemId: org.systemId, ids: [...ids].reverse() }),
    );
    expect(reversed.map((e) => e.name)).toEqual(["prod", "staging", "dev"]);
    await as("tadmin", (tx) => reorderEnvironments(tx, actor("tadmin"), { systemId: org.systemId, ids }));
  });
});

describe("đích triển khai", () => {
  let targetId: string;

  it("người chỉ có deploy.run không tạo hay sửa được lệnh", async () => {
    const err = await failure(() => upsert("tmember", { config: sshConfig() }));
    expect(err).toMatchObject({ name: "ForbiddenError", code: "SERVERS_MANAGE_REQUIRED" });
    expect(await as("admin", (tx) => listTargets(tx, uid("admin"), { projectId }))).toEqual([]);
  });

  it("quản trị đội khác xem được nhưng không sửa được đích", async () => {
    const err = await failure(() => upsert("oadmin", { config: sshConfig() }));
    expect(err).toMatchObject({ name: "ForbiddenError", code: "SERVERS_MANAGE_REQUIRED" });
  });

  it("tạo đích ssh-script: biến bí mật mã hoá từng giá trị và không trả ra", async () => {
    const created = await upsert("tadmin", { config: sshConfig() });
    targetId = created.id;
    expect(() => deployTarget.parse(created)).not.toThrow();
    expect(created.configVersion).toBe(1);
    expect(created.updatedBy?.userId).toBe(uid("tadmin"));
    expect(created.config).toMatchObject({
      method: "ssh-script",
      variables: [
        { name: "APP_ENV", secret: false, value: "staging" },
        { name: "DB_PASSWORD", secret: true, set: true },
      ],
    });
    expect(JSON.stringify(created)).not.toContain(SECRET);

    const row = (
      await admin.query("select config, server_id, connection_id from hive.deploy_targets where id = $1", [targetId])
    ).rows[0];
    expect(row.server_id).toBe(serverId);
    expect(row.connection_id).toBeNull();
    const stored = (row.config.variables as Array<{ name: string; valueEnc?: string }>).find(
      (v) => v.name === "DB_PASSWORD",
    );
    expect(JSON.stringify(row.config)).not.toContain(SECRET);
    expect(decryptSecret(masterKey, stored?.valueEnc as string, targetVariableContext(targetId, "DB_PASSWORD"))).toBe(
      SECRET,
    );

    const [entry] = await audits("delivery.target.create");
    expect(entry?.target_id).toBe(targetId);
    expect(JSON.stringify(entry?.data)).not.toContain(SECRET);
  });

  it("thành viên tổ chức xem được, không lộ bí mật", async () => {
    const got = await as("tmember", (tx) => getTarget(tx, uid("tmember"), targetId));
    expect(got.id).toBe(targetId);
    expect(JSON.stringify(got)).not.toContain(SECRET);
    expect((await as("oadmin", (tx) => getTarget(tx, uid("oadmin"), targetId))).id).toBe(targetId);
    expect(await as("oadmin", (tx) => listTargets(tx, uid("oadmin"), { systemId: org.systemId }))).toHaveLength(1);
    expect(await as("tmember", (tx) => listTargets(tx, uid("tmember"), { environmentId: devId }))).toHaveLength(1);
  });

  it("sửa: tăng config_version, giữ bí mật khi bỏ trống, audit khác biệt đã che", async () => {
    const updated = await upsert("tadmin", {
      expectedConfigVersion: 1,
      config: sshConfig({
        workdir: "/srv/billing",
        variables: [
          { name: "APP_ENV", secret: false, value: "prod" },
          { name: "DB_PASSWORD", secret: true },
        ],
      }),
    });
    expect(updated.configVersion).toBe(2);
    expect(updated.id).toBe(targetId);
    const row = (await admin.query("select config from hive.deploy_targets where id = $1", [targetId])).rows[0];
    const stored = (row.config.variables as Array<{ name: string; valueEnc?: string }>).find(
      (v) => v.name === "DB_PASSWORD",
    );
    expect(decryptSecret(masterKey, stored?.valueEnc as string, targetVariableContext(targetId, "DB_PASSWORD"))).toBe(
      SECRET,
    );
    const [entry] = (await audits("delivery.target.update")).slice(-1);
    expect(entry?.data).toMatchObject({
      configVersion: { from: 1, to: 2 },
      changes: { workdir: { from: "/opt/billing", to: "/srv/billing" } },
      secretsReplaced: [],
    });
    expect(JSON.stringify(entry?.data)).not.toContain(SECRET);
  });

  it("thay giá trị bí mật thì mã hoá lại và audit chỉ ghi tên biến", async () => {
    await upsert("tadmin", {
      expectedConfigVersion: 2,
      config: sshConfig({
        workdir: "/srv/billing",
        variables: [{ name: "DB_PASSWORD", secret: true, value: SECRET2 }],
      }),
    });
    const row = (await admin.query("select config from hive.deploy_targets where id = $1", [targetId])).rows[0];
    const stored = (row.config.variables as Array<{ name: string; valueEnc?: string }>)[0];
    expect(decryptSecret(masterKey, stored?.valueEnc as string, targetVariableContext(targetId, "DB_PASSWORD"))).toBe(
      SECRET2,
    );
    const [entry] = (await audits("delivery.target.update")).slice(-1);
    expect(entry?.data).toMatchObject({ secretsReplaced: ["DB_PASSWORD"] });
    const everything = JSON.stringify((await audits("delivery.target.update")).map((a) => a.data));
    expect(everything).not.toContain(SECRET2);
    expect(everything).not.toContain(SECRET);
  });

  it("biến bí mật mới mà không có giá trị thì bị từ chối", async () => {
    const err = await failure(() =>
      upsert("tadmin", {
        expectedConfigVersion: 3,
        config: sshConfig({ variables: [{ name: "TOKEN_MOI", secret: true }] }),
      }),
    );
    expect(err).toMatchObject({ name: "BadRequestError", code: "SECRET_VALUE_REQUIRED" });
  });

  it("hai người sửa cùng đích: người sau bị từ chối với TARGET_VERSION_CONFLICT", async () => {
    const first = await upsert("tadmin", {
      expectedConfigVersion: 3,
      config: sshConfig({ composeProject: "billing-a", variables: [{ name: "DB_PASSWORD", secret: true }] }),
    });
    expect(first.configVersion).toBe(4);
    const second = await failure(() =>
      upsert("admin", {
        expectedConfigVersion: 3,
        config: sshConfig({ composeProject: "billing-b", variables: [{ name: "DB_PASSWORD", secret: true }] }),
      }),
    );
    expect(second).toMatchObject({
      name: "ConflictError",
      code: "TARGET_VERSION_CONFLICT",
      data: { configVersion: 4 },
    });
    expect(DELIVERY_ERRORS.TARGET_VERSION_CONFLICT.status).toBe("CONFLICT");
    const after = await as("tadmin", (tx) => getTarget(tx, uid("tadmin"), targetId));
    expect(after.config).toMatchObject({ composeProject: "billing-a" });
  });

  it("hai giao dịch cùng lúc với cùng phiên bản: đúng một bên thắng", async () => {
    const cfg = (name: string) =>
      sshConfig({ composeProject: name, variables: [{ name: "DB_PASSWORD", secret: true }] });
    const results = await Promise.allSettled([
      upsert("tadmin", { expectedConfigVersion: 4, config: cfg("race-a") }),
      upsert("admin", { expectedConfigVersion: 4, config: cfg("race-b") }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((lost.reason as { code?: string }).code).toBe("TARGET_VERSION_CONFLICT");
    const now = await as("tadmin", (tx) => getTarget(tx, uid("tadmin"), targetId));
    expect(now.configVersion).toBe(5);
  });

  it("tạo lại đích đã có hoặc sửa đích không còn", async () => {
    const exists = await failure(() => upsert("tadmin", { expectedConfigVersion: null, config: sshConfig() }));
    expect(exists).toMatchObject({ code: "TARGET_VERSION_CONFLICT", data: { configVersion: 5 } });
    const missing = await failure(() =>
      upsert("tadmin", { environmentId: stagingId, expectedConfigVersion: 1, config: sshConfig() }),
    );
    expect(missing).toMatchObject({ name: "NotFoundError" });
  });

  it("kiểm cấu hình theo zod của cách triển khai", async () => {
    const err = await failure(() =>
      upsert("tadmin", { environmentId: stagingId, config: sshConfig({ workdir: "billing" }) }),
    );
    expect(err).toMatchObject({ name: "BadRequestError", code: "INVALID_TARGET_CONFIG" });
  });

  it("máy chủ phải cùng đội với hệ thống", async () => {
    const err = await failure(() =>
      upsert("tadmin", { environmentId: stagingId, config: sshConfig({ serverId: otherServerId, variables: [] }) }),
    );
    expect(err).toMatchObject({ code: "SERVER_NOT_IN_TEAM" });
    const unknown = await failure(() =>
      upsert("tadmin", { environmentId: stagingId, config: sshConfig({ serverId: randomUUID(), variables: [] }) }),
    );
    expect(unknown).toMatchObject({ code: "SERVER_NOT_IN_TEAM" });
  });

  it("môi trường và dự án phải cùng hệ thống", async () => {
    const err = await failure(() =>
      upsert("admin", { projectId: otherProjectId, environmentId: stagingId, config: sshConfig({ variables: [] }) }),
    );
    expect(err).toMatchObject({ code: "TARGET_SYSTEM_MISMATCH" });
  });

  it("argocd và kubectl cần kết nối đúng loại, jenkins-job cần kết nối Jenkins của tổ chức", async () => {
    const argo = (extra: Record<string, unknown> = {}) =>
      ({
        method: "argocd",
        schemaVersion: 1,
        connectionId: argoId,
        application: "billing-staging",
        ...extra,
      }) as TargetUpsertInput["config"];
    const kube = {
      method: "kubectl",
      schemaVersion: 1,
      connectionId: argoId,
      namespace: "billing",
      kind: "Deployment",
      name: "billing",
      container: "app",
      imageTemplate: "registry.example.invalid/billing:{{tag}}",
    } as TargetUpsertInput["config"];
    const wrongKind = await failure(() => upsert("tadmin", { environmentId: stagingId, config: kube }));
    expect(wrongKind).toMatchObject({ code: "CONNECTION_KIND_MISMATCH" });
    const missing = await failure(() =>
      upsert("tadmin", { environmentId: stagingId, config: argo({ connectionId: randomUUID() }) }),
    );
    expect(missing).toMatchObject({ code: "CONNECTION_NOT_FOUND" });
    const ok = await upsert("tadmin", { environmentId: stagingId, config: argo() });
    expect(ok.method).toBe("argocd");
    const row = (await admin.query("select server_id, connection_id from hive.deploy_targets where id = $1", [ok.id]))
      .rows[0];
    expect(row).toEqual({ server_id: null, connection_id: argoId });

    const jenkins = (connectionId: string) =>
      ({
        method: "jenkins-job",
        schemaVersion: 1,
        connectionId,
        jobPath: "billing/deploy",
        promote: { fromEnvironmentId: devId, buildParam: "BUILD" },
      }) as TargetUpsertInput["config"];
    const noJenkins = await failure(() =>
      upsert("tadmin", {
        environmentId: stagingId,
        expectedConfigVersion: ok.configVersion,
        config: jenkins(randomUUID()),
      }),
    );
    expect(noJenkins).toMatchObject({ code: "CONNECTION_NOT_FOUND" });
    const switched = await upsert("tadmin", {
      environmentId: stagingId,
      expectedConfigVersion: ok.configVersion,
      config: jenkins(jenkinsId),
    });
    expect(switched).toMatchObject({ method: "jenkins-job", configVersion: 2 });
    const cleared = (
      await admin.query("select server_id, connection_id from hive.deploy_targets where id = $1", [ok.id])
    ).rows[0];
    expect(cleared).toEqual({ server_id: null, connection_id: null });
  });

  it("nguồn promote phải là môi trường của cùng hệ thống", async () => {
    const err = await failure(() =>
      upsert("tadmin", {
        environmentId: stagingId,
        expectedConfigVersion: 2,
        config: {
          method: "jenkins-job",
          schemaVersion: 1,
          connectionId: jenkinsId,
          jobPath: "billing/deploy",
          promote: { fromEnvironmentId: randomUUID(), buildParam: "BUILD" },
        } as TargetUpsertInput["config"],
      }),
    );
    expect(err).toMatchObject({ code: "PROMOTE_SOURCE_INVALID" });
  });

  it("xoá đích cần servers.manage và bị chặn khi còn lần triển khai đang đi", async () => {
    expect(await failure(() => as("tmember", (tx) => removeTarget(tx, uid("tmember"), targetId)))).toMatchObject({
      code: "SERVERS_MANAGE_REQUIRED",
    });
    await admin.query(
      `insert into hive.deploys (org_id, target_id, method, origin, state, version)
       values ($1, $2, 'ssh-script', 'hive', 'running', '{}')`,
      [org.orgId, targetId],
    );
    expect(await failure(() => as("tadmin", (tx) => removeTarget(tx, uid("tadmin"), targetId)))).toMatchObject({
      code: "DEPLOY_IN_PROGRESS",
    });
    await admin.query("update hive.deploys set state = 'succeeded' where target_id = $1", [targetId]);
    expect(await as("tadmin", (tx) => removeTarget(tx, uid("tadmin"), targetId))).toEqual({ id: targetId });
    expect(await failure(() => as("tadmin", (tx) => getTarget(tx, uid("tadmin"), targetId)))).toMatchObject({
      name: "NotFoundError",
    });
    expect((await audits("delivery.target.remove")).length).toBe(1);
  });
});
