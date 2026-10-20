import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pgCode, seedOrg } from "../../../test/org-fixture.ts";
import { bootstrapRoles, createPool, runMigrations, type Tx, withTenant } from "../platform/index.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);
const owner = createPool(db.ownerUrl);
const tableNames = [
  "ci_jenkins_connections",
  "ci_jenkins_user_tokens",
  "deploy_connections",
  "ci_project_jobs",
  "ci_runs_seen",
  "deploy_servers",
  "deploy_environments",
  "deploy_targets",
  "deploys",
  "deploy_log_chunks",
  "deploy_approvals",
] as const;
type Table = (typeof tableNames)[number];
type Row = Record<string, string | number | boolean | Buffer | null>;
type Seed = {
  orgId: string;
  userId: string;
  teamId: string;
  otherTeamId: string;
  systemId: string;
  otherSystemId: string;
  projectId: string;
  rows: Record<Table, Row>;
};
const seeds: Record<"a" | "b", Seed> = {} as never;
const tableSql = (name: Table) => sql`${sql.identifier("hive")}.${sql.identifier(name)}`;
const json = (value: unknown) => JSON.stringify(value);

async function insert(tx: Tx, table: Table, values: Row) {
  return tx.execute(
    sql`insert into ${tableSql(table)} (${sql.join(
      Object.keys(values).map((key) => sql.identifier(key)),
      sql`, `,
    )}) values (${sql.join(
      Object.values(values).map((value) => sql`${value}`),
      sql`, `,
    )})`,
  );
}
const asA = <T>(run: (tx: Tx) => Promise<T>) => withTenant(app, { orgId: seeds.a.orgId, userId: seeds.a.userId }, run);

async function seed(name: string): Promise<Seed> {
  const org = await seedOrg(admin, `delivery-${name}-${randomUUID().slice(0, 8)}`);
  const { orgId, teamId, otherTeamId, systemId, otherSystemId } = org;
  const userId = org.user("owner");
  const scm = randomUUID();
  await admin.query(
    "insert into hive.scm_connections (id, org_id, kind, name, secret_enc, created_by) values ($1, $2, 'gitlab', 'gl', 'fixture', $3)",
    [scm, orgId, userId],
  );
  const projectId = (
    await admin.query(
      `insert into hive.projects (org_id, team_id, system_id, key, name, scm_connection_id, scm_kind, repo_mode,
         repo_owner, repo_name, settings, idempotency_key, created_by)
       values ($1, $2, $3, 'billing', 'billing', $4, 'gitlab', 'existing', 'xdev-team', 'billing', '{}', $5, $6)
       returning id`,
      [orgId, teamId, systemId, scm, randomUUID(), userId],
    )
  ).rows[0].id as string;
  const jenkins = randomUUID(),
    infra = randomUUID(),
    server = randomUUID(),
    env = randomUUID(),
    target = randomUUID(),
    deploy = randomUUID();
  const row = (values: Row): Row => ({ id: randomUUID(), org_id: orgId, ...values });
  const rows: Record<Table, Row> = {
    ci_jenkins_connections: row({
      id: jenkins,
      name: "jenkins",
      url: "https://jenkins.example.invalid",
      watcher_user_id: userId,
      created_by: userId,
    }),
    ci_jenkins_user_tokens: row({
      connection_id: jenkins,
      user_id: userId,
      jenkins_user: "dev",
      token_enc: "fixture",
    }),
    deploy_connections: row({
      id: infra,
      kind: "argocd",
      name: "argo",
      url: "https://argocd.example.invalid",
      token_enc: "fixture",
      created_by: userId,
    }),
    ci_project_jobs: row({
      project_id: projectId,
      connection_id: jenkins,
      job_path: "billing/build",
      created_by: userId,
    }),
    ci_runs_seen: row({
      project_id: projectId,
      source: "gitlab",
      external_id: "101",
      status: "failed",
      branch: "main",
    }),
    deploy_servers: row({
      id: server,
      team_id: teamId,
      name: "app-1",
      host: "192.0.2.10",
      ssh_user: "deploy",
      private_key_enc: "fixture",
      public_key: "ssh-ed25519 AAAA fixture",
      host_keys: json([{ algorithm: "ssh-ed25519", fingerprint: "SHA256:fixture" }]),
      created_by: userId,
    }),
    deploy_environments: row({
      id: env,
      team_id: teamId,
      system_id: systemId,
      name: "staging",
      policy: json({ deployRoles: [], approveRoles: [], approvals: 0, approvalTtlHours: 24 }),
    }),
    deploy_targets: row({
      id: target,
      project_id: projectId,
      environment_id: env,
      method: "ssh-script",
      config: json({ method: "ssh-script", steps: [] }),
      server_id: server,
      updated_by: userId,
    }),
    deploys: row({
      id: deploy,
      target_id: target,
      method: "ssh-script",
      origin: "hive",
      state: "running",
      version: json({ ref: "main", sha: "abc123" }),
      requested_by: userId,
    }),
    deploy_log_chunks: { org_id: orgId, deploy_id: deploy, seq: 0, data: Buffer.from("bước 1\n") },
    deploy_approvals: row({ deploy_id: deploy, user_id: userId, decision: "approve" }),
  };
  await withTenant(app, { orgId, userId }, async (tx) => {
    for (const table of tableNames) await insert(tx, table, rows[table]);
  });
  return { orgId, userId, teamId, otherTeamId, systemId, otherSystemId, projectId, rows };
}

beforeAll(async () => {
  seeds.a = await seed("a");
  seeds.b = await seed("b");
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end(), owner.end()]);
});

describe("RLS các bảng CI/CD và triển khai", () => {
  it("bật và ép RLS, policy `<bảng>_rw` cho hive_app, hive_app không có TRUNCATE", async () => {
    const { rows } = await admin.query(
      `select relname, relrowsecurity, relforcerowsecurity, has_table_privilege('hive_app', oid, 'TRUNCATE') as truncate,
              has_table_privilege('hive_app', oid, 'SELECT, INSERT, UPDATE, DELETE') as rw
         from pg_class where oid = any($1::regclass[])`,
      [tableNames.map((name) => `hive.${name}`)],
    );
    expect(rows).toHaveLength(tableNames.length);
    for (const row of rows)
      expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true, truncate: false, rw: true });
    const policies = await admin.query(
      "select tablename, policyname, cmd, roles::text[] as roles, qual, with_check from pg_policies where schemaname = 'hive' and tablename = any($1)",
      [tableNames],
    );
    // deploy_log_chunks có thêm policy cho hive_owner để hàm SECURITY DEFINER purge_deploy_logs đọc và xoá.
    expect(policies.rows).toHaveLength(tableNames.length + 2);
    const ownerPolicies = policies.rows.filter((row) => row.roles.includes("hive_owner"));
    expect(ownerPolicies.map((row) => [row.tablename, row.policyname, row.cmd]).sort()).toEqual([
      ["deploy_log_chunks", "deploy_log_chunks_owner_purge", "DELETE"],
      ["deploy_log_chunks", "deploy_log_chunks_owner_select", "SELECT"],
    ]);
    for (const policy of policies.rows.filter((row) => !row.roles.includes("hive_owner"))) {
      expect(policy.policyname).toBe(`${policy.tablename}_rw`);
      expect(policy.roles).toEqual(["hive_app"]);
      expect(policy.qual).toContain("ctx_org()");
      expect(policy.with_check).toContain("ctx_org()");
    }
  });

  it("không tenant: hive_app không thấy gì; chủ bảng chỉ đọc được log triển khai, không sửa được", async () => {
    for (const pool of [app, owner])
      await withTenant(pool, {}, async (tx) => {
        for (const table of tableNames) {
          if (pool === owner && table === "deploy_log_chunks") continue;
          expect((await tx.execute(sql`select * from ${tableSql(table)}`)).rows, table).toEqual([]);
        }
      });
    await withTenant(owner, {}, async (tx) =>
      expect((await tx.execute(sql`update hive.deploy_log_chunks set seq = seq returning id`)).rows).toEqual([]),
    );
  });

  for (const table of tableNames) {
    it(`${table}: đọc đúng tenant, chặn INSERT/UPDATE chéo và không sửa/xoá dòng tenant khác`, async () => {
      await asA(async (tx) => {
        expect((await tx.execute(sql`select current_user as role`)).rows[0]).toEqual({ role: "hive_app" });
        const rows = (await tx.execute(sql`select * from ${tableSql(table)}`)).rows;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.org_id).toBe(seeds.a.orgId);
        expect(
          (
            await tx.execute(
              sql`update ${tableSql(table)} set org_id = ${seeds.b.orgId} where org_id = ${seeds.b.orgId} returning *`,
            )
          ).rows,
        ).toEqual([]);
        expect(
          (await tx.execute(sql`delete from ${tableSql(table)} where org_id = ${seeds.b.orgId} returning *`)).rows,
        ).toEqual([]);
      });
      expect(
        await pgCode(() => asA((tx) => insert(tx, table, { ...seeds.a.rows[table], org_id: seeds.b.orgId }))),
      ).toBe("42501");
      expect(
        await pgCode(() => asA((tx) => tx.execute(sql`update ${tableSql(table)} set org_id = ${seeds.b.orgId}`))),
      ).toBe("42501");
    });
  }

  it("khóa ngoại kép chặn tham chiếu sang tenant khác", async () => {
    const b = seeds.b.rows;
    const cases: Array<[Table, Row]> = [
      ["ci_jenkins_user_tokens", { connection_id: String(b.ci_jenkins_connections.id), user_id: "khac" }],
      ["ci_project_jobs", { connection_id: String(b.ci_jenkins_connections.id) }],
      ["ci_project_jobs", { project_id: seeds.b.projectId }],
      ["ci_runs_seen", { project_id: seeds.b.projectId, external_id: "202" }],
      ["deploy_servers", { team_id: seeds.b.teamId, name: "khac" }],
      ["deploy_environments", { team_id: seeds.b.teamId, name: "khac" }],
      ["deploy_environments", { system_id: seeds.b.systemId, name: "khac" }],
      // Hệ thống cùng tổ chức nhưng của đội khác: môi trường phải theo đội của hệ thống.
      ["deploy_environments", { system_id: seeds.a.otherSystemId, name: "khac" }],
      ["deploy_targets", { environment_id: String(b.deploy_environments.id) }],
      ["deploy_targets", { project_id: seeds.b.projectId }],
      ["deploys", { target_id: String(b.deploy_targets.id), state: "succeeded" }],
      ["deploys", { rollback_of: String(b.deploys.id), state: "succeeded" }],
      // seq khác để không đụng unique (deploy_id, seq) của B trước khi tới khoá ngoại.
      ["deploy_log_chunks", { deploy_id: String(b.deploys.id), seq: 99 }],
      ["deploy_approvals", { deploy_id: String(b.deploys.id), user_id: "khac" }],
    ];
    for (const [table, changes] of cases) {
      const row = { ...seeds.a.rows[table], ...changes };
      if ("id" in row) row.id = randomUUID();
      expect(await pgCode(() => asA((tx) => insert(tx, table, row))), `${table} ${Object.keys(changes)}`).toBe("23503");
    }
    // Đổi máy chủ/kết nối của đích có sẵn sang của tenant khác.
    const target = seeds.a.rows.deploy_targets.id;
    expect(
      await pgCode(() =>
        asA((tx) =>
          tx.execute(sql`update hive.deploy_targets set server_id = ${b.deploy_servers.id} where id = ${target}`),
        ),
      ),
    ).toBe("23503");
    expect(
      await pgCode(() =>
        asA((tx) =>
          tx.execute(
            sql`update hive.deploy_targets set method = 'argocd', config = '{"method":"argocd"}', server_id = null,
                  connection_id = ${b.deploy_connections.id} where id = ${target}`,
          ),
        ),
      ),
    ).toBe("23503");
  });

  it("mỗi đích chỉ một lần triển khai Hive đang đi; lần ngoài Hive và lần đã xong không tính", async () => {
    const base = { ...seeds.a.rows.deploys };
    const again = (values: Row) => asA((tx) => insert(tx, "deploys", { ...base, id: randomUUID(), ...values }));
    for (const state of ["queued", "pending_approval", "running"])
      expect(await pgCode(() => again({ state })), state).toBe("23505");
    expect(await pgCode(() => again({ state: "running", origin: "external" }))).toBeUndefined();
    expect(await pgCode(() => again({ state: "succeeded" }))).toBeUndefined();
  });

  it("unique: tên kết nối, token mỗi người, job của dự án, lượt CI đã thấy, máy chủ, môi trường, đích, phiếu duyệt", async () => {
    for (const table of [
      "ci_jenkins_connections",
      "ci_jenkins_user_tokens",
      "deploy_connections",
      "ci_project_jobs",
      "ci_runs_seen",
      "deploy_servers",
      "deploy_environments",
      "deploy_targets",
      "deploy_approvals",
    ] as const) {
      expect(
        await pgCode(() => asA((tx) => insert(tx, table, { ...seeds.a.rows[table], id: randomUUID() }))),
        table,
      ).toBe("23505");
    }
    expect(await pgCode(() => asA((tx) => insert(tx, "deploy_log_chunks", seeds.a.rows.deploy_log_chunks)))).toBe(
      "23505",
    );
  });

  it("check chặn dữ liệu sai", async () => {
    const a = seeds.a.rows;
    const cases: Array<[Table, Row]> = [
      ["deploy_connections", { kind: "jenkins", name: "x" }],
      ["ci_runs_seen", { source: "bitbucket", external_id: "x" }],
      ["deploy_servers", { port: 0, name: "x" }],
      ["deploy_servers", { pending_public_key: "ssh-ed25519 BBBB", name: "x" }],
      ["deploy_servers", { host_keys: json({ algorithm: "ssh-ed25519" }), name: "x" }],
      ["deploy_environments", { lock_reason: "bảo trì", name: "x" }],
      ["deploy_environments", { policy: json([]), name: "x" }],
      ["deploy_targets", { method: "ftp", config: json({ method: "ftp" }) }],
      ["deploy_targets", { config: json({ method: "jenkins-job" }) }],
      ["deploy_targets", { config_version: 0 }],
      // ssh-script phải có máy chủ; jenkins-job không được gắn máy chủ; argocd phải có kết nối.
      ["deploy_targets", { server_id: null }],
      ["deploy_targets", { method: "jenkins-job", config: json({ method: "jenkins-job" }) }],
      ["deploy_targets", { method: "argocd", config: json({ method: "argocd" }), server_id: null }],
      ["deploys", { state: "done" }],
      ["deploys", { origin: "manual", state: "succeeded" }],
      ["deploys", { method: "ftp", state: "succeeded" }],
      ["deploys", { approvals_required: 6, state: "succeeded" }],
      ["deploy_approvals", { decision: "maybe", user_id: "khac" }],
    ];
    for (const [table, changes] of cases) {
      const row = { ...a[table], ...changes };
      if ("id" in row) row.id = randomUUID();
      expect(await pgCode(() => asA((tx) => insert(tx, table, row))), `${table} ${json(changes)}`).toBe("23514");
    }
  });

  it("không xoá được máy chủ hay kết nối đang có đích dùng; xoá đích thì xoá lịch sử của nó", async () => {
    expect(
      await pgCode(() =>
        asA((tx) => tx.execute(sql`delete from hive.deploy_servers where id = ${seeds.a.rows.deploy_servers.id}`)),
      ),
    ).toBe("23503");
    const org = await seedOrg(admin, `delivery-del-${randomUUID().slice(0, 8)}`);
    const userId = org.user("owner");
    const connection = randomUUID();
    const server = randomUUID();
    const envId = randomUUID();
    const otherEnv = randomUUID();
    const target = randomUUID();
    const deploy = randomUUID();
    const scm = randomUUID();
    await admin.query(
      "insert into hive.scm_connections (id, org_id, kind, name, secret_enc, created_by) values ($1, $2, 'gitlab', 'gl', 'fixture', $3)",
      [scm, org.orgId, userId],
    );
    const project = (
      await admin.query(
        `insert into hive.projects (org_id, team_id, system_id, key, name, scm_connection_id, scm_kind, repo_mode,
           repo_owner, repo_name, settings, idempotency_key, created_by)
         values ($1, $2, $3, 'k', 'k', $4, 'gitlab', 'existing', 'o', 'k', '{}', $5, $6) returning id`,
        [org.orgId, org.teamId, org.systemId, scm, randomUUID(), userId],
      )
    ).rows[0].id as string;
    const asOrg = <T>(run: (tx: Tx) => Promise<T>) => withTenant(app, { orgId: org.orgId, userId }, run);
    const a = seeds.a.rows;
    await asOrg(async (tx) => {
      const env = (id: string, teamId: string, systemId: string) => ({
        ...a.deploy_environments,
        id,
        org_id: org.orgId,
        team_id: teamId,
        system_id: systemId,
      });
      await insert(tx, "deploy_connections", { ...a.deploy_connections, id: connection, org_id: org.orgId });
      await insert(tx, "deploy_servers", { ...a.deploy_servers, id: server, org_id: org.orgId, team_id: org.teamId });
      await insert(tx, "deploy_environments", env(envId, org.teamId, org.systemId));
      await insert(tx, "deploy_environments", env(otherEnv, org.otherTeamId, org.otherSystemId));
      await insert(tx, "deploy_targets", {
        id: target,
        org_id: org.orgId,
        project_id: project,
        environment_id: envId,
        method: "argocd",
        config: json({ method: "argocd" }),
        connection_id: connection,
        updated_by: userId,
      });
      await insert(tx, "deploys", { ...a.deploys, id: deploy, org_id: org.orgId, target_id: target, method: "argocd" });
      await insert(tx, "deploy_log_chunks", { org_id: org.orgId, deploy_id: deploy, seq: 0, data: Buffer.from("x") });
    });
    expect(
      await pgCode(() => asOrg((tx) => tx.execute(sql`delete from hive.deploy_connections where id = ${connection}`))),
    ).toBe("23503");
    await asOrg((tx) => tx.execute(sql`delete from hive.deploy_targets where id = ${target}`));
    await asOrg(async (tx) => {
      expect((await tx.execute(sql`select id from hive.deploys`)).rows).toEqual([]);
      expect((await tx.execute(sql`select id from hive.deploy_log_chunks`)).rows).toEqual([]);
      await tx.execute(sql`delete from hive.deploy_connections where id = ${connection}`);
      await tx.execute(sql`delete from hive.deploy_servers where id = ${server}`);
    });
    // Xoá hệ thống (không còn dự án) thì môi trường của nó đi theo.
    await admin.query("delete from hive.systems where id = $1", [org.otherSystemId]);
    expect(
      (await admin.query("select id from hive.deploy_environments where id = any($1)", [[envId, otherEnv]])).rows,
    ).toEqual([{ id: envId }]);
  });

  it("purge_deploy_logs xoá log cũ theo số ngày giữ log của từng tổ chức, hive_app gọi được khi không có tenant", async () => {
    const old = async (orgId: string, deployId: string, seq: number, days: number) =>
      (
        await admin.query(
          "insert into hive.deploy_log_chunks (org_id, deploy_id, seq, data, created_at) values ($1, $2, $3, 'x', now() - make_interval(days => $4)) returning id",
          [orgId, deployId, seq, days],
        )
      ).rows[0].id as string;
    const a = String(seeds.a.rows.deploys.id);
    const b = String(seeds.b.rows.deploys.id);
    // A theo mặc định 365 ngày; B giữ 500 ngày.
    await admin.query(
      `insert into hive.agent_policies (org_id, policy) values ($1, $2)
       on conflict (org_id) do update set policy = excluded.policy`,
      [seeds.b.orgId, json({ limits: { runLogRetentionDays: 500 } })],
    );
    const aOld = await old(seeds.a.orgId, a, 100, 400);
    const aNew = await old(seeds.a.orgId, a, 101, 300);
    const bOld = await old(seeds.b.orgId, b, 100, 400);
    const purged = await withTenant(app, {}, async (tx) =>
      Number((await tx.execute<{ n: string }>(sql`select hive.purge_deploy_logs() as n`)).rows[0]?.n),
    );
    expect(purged).toBeGreaterThanOrEqual(1);
    const left = (
      await admin.query("select id from hive.deploy_log_chunks where id = any($1)", [[aOld, aNew, bOld]])
    ).rows
      .map((r) => String(r.id))
      .sort();
    expect(left).toEqual([aNew, bOld].sort());
    const fn = await admin.query(
      "select prosecdef, has_function_privilege('hive_app', p.oid, 'EXECUTE') as app, has_function_privilege('public', p.oid, 'EXECUTE') as pub from pg_proc p where p.oid = 'hive.purge_deploy_logs()'::regprocedure",
    );
    expect(fn.rows[0]).toEqual({ prosecdef: true, app: true, pub: false });
  });

  it("kênh thông báo có system_ids, mặc định null là mọi hệ thống", async () => {
    const { rows } = await admin.query(
      "select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'hive' and table_name = 'notification_channels' and column_name = 'system_ids'",
    );
    expect(rows).toEqual([{ data_type: "ARRAY", is_nullable: "YES", column_default: null }]);
  });
});

it("nâng từ 0080: kênh cũ nhận mọi hệ thống, bảng mới bật và ép RLS", async () => {
  const name = `delivery_up_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const onDb = (url: string) => {
    const parsed = new URL(url);
    parsed.pathname = `/${name}`;
    return parsed.toString();
  };
  await admin.query(`create database ${name}`);
  const old = new pg.Pool({ connectionString: onDb(db.adminUrl) });
  const migrations = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
  const cache = fileURLToPath(new URL("../../../node_modules/.cache", import.meta.url));
  mkdirSync(cache, { recursive: true });
  const prefix = mkdtempSync(join(cache, "delivery-upgrade-"));
  try {
    const password = (url: string) => decodeURIComponent(new URL(url).password);
    await bootstrapRoles(
      onDb(db.adminUrl),
      { owner: password(db.ownerUrl), app: password(db.appUrl), auth: password(db.authUrl) },
      { pgvector: false },
    );
    cpSync(migrations, prefix, { recursive: true });
    const journal = JSON.parse(readFileSync(join(prefix, "meta/_journal.json"), "utf8"));
    const before = journal.entries.findIndex((entry: { tag: string }) => entry.tag.endsWith("_delivery"));
    expect(before).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, before);
    expect(journal.entries.at(-1).tag).toMatch(/^0080_/);
    writeFileSync(join(prefix, "meta/_journal.json"), JSON.stringify(journal));
    await runMigrations(onDb(db.ownerUrl), prefix);
    const org = await seedOrg(old, `up-${randomUUID().slice(0, 6)}`);
    await old.query(
      `insert into hive.notification_channels (org_id, kind, name, events, target, config_enc, created_by)
       values ($1, 'telegram', 'ops', '{deploy.failed}', 'chat', 'fixture', $2)`,
      [org.orgId, org.user("owner")],
    );
    await runMigrations(onDb(db.ownerUrl));
    expect((await old.query("select system_ids from hive.notification_channels")).rows).toEqual([{ system_ids: null }]);
    const { rows } = await old.query(
      "select count(*)::int as n from pg_class where oid = any($1::regclass[]) and relrowsecurity and relforcerowsecurity",
      [tableNames.map((t) => `hive.${t}`)],
    );
    expect(rows[0].n).toBe(tableNames.length);
  } finally {
    await old.end();
    rmSync(prefix, { recursive: true, force: true });
    await admin.query(`drop database ${name} with (force)`);
  }
}, 240_000);
