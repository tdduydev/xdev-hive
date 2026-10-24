import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pgCode, seedOrg } from "../../../test/org-fixture.ts";
import { createPool, type Tx, withTenant } from "../platform/index.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);
const owner = createPool(db.ownerUrl);
// Thứ tự chèn theo khoá ngoại: qa_case_status trỏ tới lần chạy và kết quả tay nên đứng cuối.
const tableNames = [
  "qa_settings",
  "qa_project_settings",
  "qa_areas",
  "qa_cases",
  "qa_case_versions",
  "qa_ci_sources",
  "qa_ci_runs",
  "qa_ci_run_cases",
  "qa_rounds",
  "qa_round_cases",
  "qa_round_assignees",
  "qa_result_history",
  "qa_case_status",
] as const;
type Table = (typeof tableNames)[number];
type Row = Record<string, string | number | boolean | null>;
type Seed = {
  orgId: string;
  userId: string;
  memberId: string;
  projectId: string;
  /** Dự án chưa có dòng qa nào, để thử khoá ngoại mà không vướng unique. */
  spareProjectId: string;
  docId: string;
  /** Tài liệu chưa gắn khu nào. */
  spareDocId: string;
  rows: Record<Table, Row>;
};
const seeds: Record<"a" | "b", Seed> = {} as never;
const tableSql = (name: Table) => sql`${sql.identifier("hive")}.${sql.identifier(name)}`;
const json = (value: unknown) => JSON.stringify(value);
const arr = (items: string[]) => `{${items.map((s) => JSON.stringify(s)).join(",")}}`;
const SHA = "a".repeat(40);

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
  const org = await seedOrg(admin, `qa-${name}-${randomUUID().slice(0, 8)}`);
  const { orgId, teamId, systemId } = org;
  const userId = org.user("owner");
  const scm = randomUUID();
  await admin.query(
    "insert into hive.scm_connections (id, org_id, kind, name, secret_enc, created_by) values ($1, $2, 'gitlab', 'gl', 'fixture', $3)",
    [scm, orgId, userId],
  );
  const project = async (key: string) =>
    (
      await admin.query(
        `insert into hive.projects (org_id, team_id, system_id, key, name, scm_connection_id, scm_kind, repo_mode,
           repo_owner, repo_name, settings, idempotency_key, created_by)
         values ($1, $2, $3, $4, $4, $5, 'gitlab', 'existing', 'xdev-team', $4, '{}', $6, $7)
         returning id`,
        [orgId, teamId, systemId, key, scm, randomUUID(), userId],
      )
    ).rows[0].id as string;
  const projectId = await project("billing");
  const spareProjectId = await project("spare");
  const docId = randomUUID();
  await admin.query(
    "insert into hive.docs (id, org_id, key, title, current_version, updated_by_user_id) values ($1, $2, 'test-cases/dangnhap.md', 'Đăng nhập', 1, $3)",
    [docId, orgId, userId],
  );
  const spareDocId = randomUUID();
  await admin.query(
    "insert into hive.docs (id, org_id, key, title, current_version, updated_by_user_id) values ($1, $2, 'test-cases/khac.md', 'Khác', 1, $3)",
    [spareDocId, orgId, userId],
  );
  const area = randomUUID(),
    tc = randomUUID(),
    source = randomUUID(),
    run = randomUUID(),
    round = randomUUID(),
    roundCase = randomUUID();
  const row = (values: Row): Row => ({ id: randomUUID(), org_id: orgId, ...values });
  const rows: Record<Table, Row> = {
    qa_settings: { org_id: orgId, retention_days: 365, updated_by: userId },
    qa_project_settings: { project_id: projectId, org_id: orgId, enabled: true, include_result: "added" },
    qa_areas: row({
      id: area,
      project_id: projectId,
      code: "DANGNHAP",
      name: "Đăng nhập",
      doc_id: docId,
      doc_key: "test-cases/dangnhap.md",
      parsed_version: 1,
    }),
    qa_cases: row({
      id: tc,
      project_id: projectId,
      area_id: area,
      code: "TC-DANGNHAP-001",
      name: "Đăng nhập đúng mật khẩu",
      priority: "P1",
      kind: "automated",
      requirements: arr(["FR-001", "036/AC-012.2", "OPD02"]),
      labels: arr(["smoke"]),
      steps: json([{ n: 1, action: "Mở trang đăng nhập", expected: "Thấy form" }]),
      script: "e2e/login.spec.ts",
      line: 3,
      content_hash: "h1",
    }),
    qa_case_versions: {
      case_id: tc,
      version: 1,
      org_id: orgId,
      content: json({ name: "Đăng nhập đúng mật khẩu" }),
      doc_version: 1,
    },
    qa_ci_sources: row({
      id: source,
      project_id: projectId,
      label: "e2e",
      repo_path: "xdev-team/billing",
      repo_web_url: "https://gitlab.example.invalid/xdev-team/billing",
      mode: "junit-artifact",
      artifact_path: "reports/junit.xml",
      reference_branch: "main",
      credential: "gitlab-ci",
      created_by: userId,
    }),
    qa_ci_runs: row({
      id: run,
      source_id: source,
      pipeline_id: 101,
      read_state: "done",
      pipeline_status: "success",
      ref: "main",
      sha: SHA,
      kind: "branch",
      is_reference: true,
      finished_at: "2026-10-20T08:00:00Z",
      job_ids: "{7001}",
      passed: 1,
    }),
    qa_ci_run_cases: { run_id: run, case_id: tc, org_id: orgId, area_id: area, status: "passed", duration_ms: 1200 },
    qa_rounds: row({
      id: round,
      project_id: projectId,
      name: "Đợt 1",
      environment: "staging",
      build: "1.2.0",
      start_date: "2026-10-20",
      planned_end_date: "2026-10-24",
      created_by: userId,
    }),
    qa_round_cases: row({
      id: roundCase,
      round_id: round,
      case_id: tc,
      case_version_at_add: 1,
      status: "failed",
      failed_step: 1,
      note: "Nút đăng nhập không phản hồi",
      links: arr(["https://tracker.example.invalid/ISSUE-1"]),
      recorded_by: userId,
      recorded_at: "2026-10-21T08:00:00Z",
      recorded_case_version: 1,
      revision: 1,
    }),
    qa_round_assignees: { round_case_id: roundCase, user_id: org.user("tmember"), org_id: orgId, assigned_by: userId },
    qa_result_history: {
      round_case_id: roundCase,
      revision: 0,
      org_id: orgId,
      status: "untested",
      changed_by: userId,
    },
    qa_case_status: {
      case_id: tc,
      org_id: orgId,
      project_id: projectId,
      area_id: area,
      ci_status: "passed",
      ci_at: "2026-10-20T08:00:00Z",
      ci_run_id: run,
      manual_status: "failed",
      manual_at: "2026-10-21T08:00:00Z",
      manual_round_case_id: roundCase,
    },
  };
  await withTenant(app, { orgId, userId }, async (tx) => {
    for (const table of tableNames) await insert(tx, table, rows[table]);
  });
  return { orgId, userId, memberId: org.user("tmember"), projectId, spareProjectId, docId, spareDocId, rows };
}

beforeAll(async () => {
  seeds.a = await seed("a");
  seeds.b = await seed("b");
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end(), owner.end()]);
});

describe("RLS các bảng kiểm thử (specs/036 FR-071)", () => {
  it("bật và ép RLS, policy cho hive_app, hive_app không có TRUNCATE", async () => {
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
    // qa_settings theo mẫu audit_settings: ba policy cho hive_app thay cho `_rw`, thêm một policy đọc cho hive_owner.
    expect(policies.rows).toHaveLength(tableNames.length + 3);
    const settings = policies.rows.filter((row) => row.tablename === "qa_settings");
    expect(settings.map((row) => [row.policyname, row.cmd, row.roles]).sort()).toEqual([
      ["qa_settings_insert", "INSERT", ["hive_app"]],
      ["qa_settings_owner_select", "SELECT", ["hive_owner"]],
      ["qa_settings_select", "SELECT", ["hive_app"]],
      ["qa_settings_update", "UPDATE", ["hive_app"]],
    ]);
    for (const policy of policies.rows.filter((row) => row.tablename !== "qa_settings")) {
      expect(policy.policyname).toBe(`${policy.tablename}_rw`);
      expect(policy.roles).toEqual(["hive_app"]);
      expect(policy.qual).toContain("ctx_org()");
      expect(policy.with_check).toContain("ctx_org()");
    }
  });

  it("không tenant: hive_app không thấy gì; chủ bảng chỉ đọc được qa_settings, không sửa được", async () => {
    for (const pool of [app, owner])
      await withTenant(pool, {}, async (tx) => {
        for (const table of tableNames) {
          // hive_owner đọc qa_settings của mọi tổ chức, kể cả của file test khác chạy song song.
          if (pool === owner && table === "qa_settings") continue;
          expect((await tx.execute(sql`select * from ${tableSql(table)}`)).rows, table).toEqual([]);
        }
      });
    await withTenant(owner, {}, async (tx) => {
      expect((await tx.execute(sql`update hive.qa_settings set retention_days = 90 returning org_id`)).rows).toEqual(
        [],
      );
      expect((await tx.execute(sql`delete from hive.qa_settings returning org_id`)).rows).toEqual([]);
    });
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
    const a = seeds.a.rows;
    const b = seeds.b.rows;
    const spare = seeds.b.spareProjectId;
    const cases: Array<[Table, Row]> = [
      ["qa_project_settings", { project_id: spare }],
      ["qa_areas", { project_id: spare, doc_id: null }],
      ["qa_areas", { project_id: seeds.a.spareProjectId, doc_id: seeds.b.spareDocId }],
      ["qa_cases", { project_id: spare }],
      ["qa_cases", { area_id: String(b.qa_areas.id), code: "TC-DANGNHAP-002" }],
      ["qa_case_versions", { case_id: String(b.qa_cases.id), version: 2 }],
      ["qa_ci_sources", { project_id: spare }],
      ["qa_ci_runs", { source_id: String(b.qa_ci_sources.id), pipeline_id: 202 }],
      ["qa_ci_run_cases", { run_id: String(b.qa_ci_runs.id) }],
      ["qa_ci_run_cases", { case_id: String(b.qa_cases.id) }],
      ["qa_rounds", { project_id: spare }],
      ["qa_rounds", { previous_round_id: String(b.qa_rounds.id) }],
      ["qa_round_cases", { round_id: String(b.qa_rounds.id) }],
      ["qa_round_cases", { case_id: String(b.qa_cases.id) }],
      ["qa_round_assignees", { round_case_id: String(b.qa_round_cases.id) }],
      // Người của tổ chức khác không giao được.
      ["qa_round_assignees", { user_id: seeds.b.userId }],
      ["qa_result_history", { round_case_id: String(b.qa_round_cases.id), revision: 5 }],
    ];
    for (const [table, changes] of cases) {
      const row = { ...a[table], ...changes };
      if ("id" in row) row.id = randomUUID();
      expect(await pgCode(() => asA((tx) => insert(tx, table, row))), `${table} ${Object.keys(changes)}`).toBe("23503");
    }
    // case_id là khoá chính của qa_case_status, nên thử khoá ngoại bằng cách đổi cột trỏ tới lần chạy và kết quả tay.
    const tc = String(a.qa_cases.id);
    for (const change of [
      sql`ci_run_id = ${b.qa_ci_runs.id}`,
      sql`manual_round_case_id = ${b.qa_round_cases.id}`,
      sql`project_id = ${spare}`,
    ])
      expect(
        await pgCode(() =>
          asA((tx) => tx.execute(sql`update hive.qa_case_status set ${change} where case_id = ${tc}`)),
        ),
      ).toBe("23503");
  });

  it("unique: mã khu và mã TC trong dự án, tài liệu của khu, tên nguồn, pipeline, TC trong đợt, khoá chính ghép", async () => {
    // qa_rounds không có unique ngoài id: tên đợt được trùng.
    for (const table of tableNames.filter((t) => t !== "qa_rounds")) {
      expect(
        await pgCode(() =>
          asA((tx) =>
            insert(tx, table, { ...seeds.a.rows[table], ...("id" in seeds.a.rows[table] ? { id: randomUUID() } : {}) }),
          ),
        ),
        table,
      ).toBe("23505");
    }
    // Khu thứ hai của dự án dùng chung tài liệu: chặn bằng unique `doc_id`.
    expect(
      await pgCode(() =>
        asA((tx) => insert(tx, "qa_areas", { ...seeds.a.rows.qa_areas, id: randomUUID(), code: "KHAC" })),
      ),
    ).toBe("23505");
    // Khu không còn tài liệu thì nhiều khu cùng null được.
    expect(
      await pgCode(() =>
        asA(async (tx) => {
          for (const code of ["CU1", "CU2"])
            await insert(tx, "qa_areas", { ...seeds.a.rows.qa_areas, id: randomUUID(), code, doc_id: null });
          throw Object.assign(new Error("rollback"), { code: "rollback" });
        }),
      ),
    ).toBe("rollback");
  });

  it("check chặn dữ liệu sai", async () => {
    const a = seeds.a.rows;
    const cases: Array<[Table, Row]> = [
      ["qa_settings", { retention_days: 89 }],
      ["qa_settings", { retention_days: 3651 }],
      ["qa_project_settings", { tc_dir: "test-cases" }],
      ["qa_project_settings", { tc_dir: "/test-cases/" }],
      ["qa_project_settings", { tc_dir: "docs/../test-cases/" }],
      ["qa_project_settings", { tc_dir: "../" }],
      ["qa_project_settings", { tc_dir: `${"a".repeat(200)}/` }],
      ["qa_project_settings", { include_result: "maybe" }],
      ["qa_areas", { code: "dangnhap" }],
      ["qa_areas", { code: "D" }],
      ["qa_areas", { code: `D${"A".repeat(16)}` }],
      ["qa_areas", { parse_errors: json({ line: 1 }) }],
      ["qa_areas", { parse_errors: json(Array.from({ length: 101 }, (_, i) => ({ line: i, message: "x" }))) }],
      ["qa_cases", { code: "TC-DANGNHAP-1" }],
      ["qa_cases", { name: "x".repeat(301) }],
      ["qa_cases", { name: "" }],
      ["qa_cases", { priority: "P4" }],
      ["qa_cases", { kind: "exploratory" }],
      ["qa_cases", { requirements: "{}" }],
      ["qa_cases", { requirements: arr(["FR001"]) }],
      ["qa_cases", { requirements: arr(["NFR"]) }],
      ["qa_cases", { requirements: arr(["opd02"]) }],
      ["qa_cases", { requirements: arr(["FR-001", "FR-01"]) }],
      ["qa_cases", { requirements: arr(["FR-001", ""]) }],
      ["qa_cases", { labels: arr(["a b"]) }],
      ["qa_cases", { labels: arr(Array.from({ length: 21 }, (_, i) => `l${i}`)) }],
      ["qa_cases", { steps: "[]" }],
      ["qa_cases", { steps: json({ n: 1 }) }],
      ["qa_cases", { script: null }],
      ["qa_cases", { version: 0 }],
      ["qa_cases", { state: "deleted" }],
      ["qa_ci_sources", { label: "x".repeat(81) }],
      ["qa_ci_sources", { repo_web_url: "http://gitlab.example.invalid/x" }],
      ["qa_ci_sources", { mode: "allure" }],
      ["qa_ci_sources", { artifact_path: null }],
      ["qa_ci_sources", { artifact_path: "../junit.xml" }],
      ["qa_ci_sources", { artifact_path: "/reports/junit.xml" }],
      ["qa_ci_sources", { backfill_state: "running" }],
      ["qa_ci_runs", { read_state: "queued" }],
      ["qa_ci_runs", { read_attempts: -1 }],
      ["qa_ci_runs", { pipeline_status: "running" }],
      ["qa_ci_runs", { sha: "abc123" }],
      ["qa_ci_runs", { sha: "A".repeat(40) }],
      ["qa_ci_runs", { kind: "tag" }],
      ["qa_ci_runs", { unknown_codes: arr(Array.from({ length: 201 }, (_, i) => `TC-X-${i}`)) }],
      ["qa_ci_runs", { failed: -1 }],
      ["qa_ci_run_cases", { status: "broken" }],
      ["qa_ci_run_cases", { retries: -1 }],
      ["qa_rounds", { name: "" }],
      ["qa_rounds", { name: "x".repeat(121) }],
      ["qa_rounds", { environment: "x".repeat(81) }],
      ["qa_rounds", { build: "x".repeat(81) }],
      ["qa_rounds", { planned_end_date: "2026-10-19" }],
      ["qa_rounds", { state: "archived" }],
      ["qa_rounds", { reopen_reason: "ngắn" }],
      ["qa_rounds", { reopen_reason: "x".repeat(501) }],
      ["qa_round_cases", { status: "blocked" }],
      ["qa_round_cases", { failed_step: 0 }],
      ["qa_round_cases", { note: "x".repeat(501) }],
      ["qa_round_cases", { note: null, links: "{}" }],
      ["qa_round_cases", { status: "other", note: "", links: "{}" }],
      ["qa_round_cases", { links: arr(Array.from({ length: 6 }, (_, i) => `https://x.example.invalid/${i}`)) }],
      ["qa_round_cases", { links: arr(["ftp://x.example.invalid/1"]) }],
      ["qa_round_cases", { links: arr(["https://x.example.invalid/1", "khong-phai-lien-ket"]) }],
      ["qa_round_cases", { links: arr([`https://x.example.invalid/${"a".repeat(2000)}`]) }],
      ["qa_round_cases", { revision: -1 }],
      ["qa_result_history", { status: "blocked" }],
      ["qa_result_history", { note_deleted: true, note: "còn" }],
      ["qa_case_status", { ci_status: "untested" }],
      ["qa_case_status", { manual_status: "flaky" }],
      ["qa_case_status", { ci_at: null }],
      ["qa_case_status", { manual_status: null }],
    ];
    for (const [table, changes] of cases) {
      const row = { ...a[table], ...changes };
      if ("id" in row) row.id = randomUUID();
      expect(await pgCode(() => asA((tx) => insert(tx, table, row))), `${table} ${json(changes)}`).toBe("23514");
    }
  });

  it("nhận mọi dạng mã yêu cầu của D10; Khác chỉ có liên kết lỗi vẫn đủ lý do", async () => {
    const a = seeds.a.rows;
    const tc = randomUUID();
    const round = randomUUID();
    const code = await pgCode(() =>
      asA(async (tx) => {
        await insert(tx, "qa_cases", {
          ...a.qa_cases,
          id: tc,
          code: "TC-DANGNHAP-900",
          kind: "manual",
          script: null,
          requirements: arr(["FR-0012", "NFR-001.3", "US-010", "ACC01", "USR01", "OPD02P00108", "COMMON"]),
          labels: "{}",
        });
        await insert(tx, "qa_rounds", { ...a.qa_rounds, id: round, name: "Đợt 2" });
        await insert(tx, "qa_round_cases", {
          ...a.qa_round_cases,
          id: randomUUID(),
          round_id: round,
          case_id: tc,
          status: "other",
          note: null,
          links: arr(["http://tracker.example.invalid/2"]),
        });
        // Chỉ cần biết các lệnh trên qua được check; không giữ dữ liệu để test khác vẫn thấy một dòng mỗi bảng.
        throw Object.assign(new Error("rollback"), { code: "rollback" });
      }),
    );
    expect(code).toBe("rollback");
  });

  it("current_status: bên mới hơn thắng, bằng giờ thì kết quả tay thắng, một bên thì lấy bên đó (FR-052)", async () => {
    const tc = String(seeds.a.rows.qa_cases.id);
    const read = (set: ReturnType<typeof sql>) =>
      asA(async (tx) => {
        const r = await tx.execute(
          sql`update hive.qa_case_status set ${set} where case_id = ${tc} returning current_status, current_source`,
        );
        return r.rows[0];
      });
    const t1 = "2026-10-20T08:00:00Z";
    const t2 = "2026-10-21T08:00:00Z";
    expect(await read(sql`ci_status = 'passed', ci_at = ${t1}, manual_status = 'failed', manual_at = ${t2}`)).toEqual({
      current_status: "failed",
      current_source: "manual",
    });
    expect(await read(sql`ci_at = ${t2}, manual_at = ${t1}`)).toEqual({
      current_status: "passed",
      current_source: "ci",
    });
    expect(await read(sql`ci_at = ${t1}, manual_at = ${t1}`)).toEqual({
      current_status: "failed",
      current_source: "manual",
    });
    expect(await read(sql`manual_status = null, manual_at = null`)).toEqual({
      current_status: "passed",
      current_source: "ci",
    });
    expect(await read(sql`ci_status = 'skipped'`)).toEqual({ current_status: "skipped", current_source: "ci" });
    expect(await read(sql`ci_status = null, ci_at = null, manual_status = 'other', manual_at = ${t1}`)).toEqual({
      current_status: "other",
      current_source: "manual",
    });
    expect(await read(sql`manual_status = null, manual_at = null`)).toEqual({
      current_status: null,
      current_source: null,
    });
    await read(sql`ci_status = 'passed', ci_at = ${t1}, manual_status = 'failed', manual_at = ${t2}`);
  });

  it("xoá tài liệu, lần chạy, kết quả tay thì chỉ đặt null cột trỏ tới; xoá dự án thì xoá mọi dòng qa", async () => {
    const c = await seed("c");
    const tc = String(c.rows.qa_cases.id);
    await admin.query("delete from hive.docs where id = $1", [c.docId]);
    await admin.query("delete from hive.qa_ci_runs where id = $1", [c.rows.qa_ci_runs.id]);
    await admin.query("delete from hive.qa_rounds where id = $1", [c.rows.qa_rounds.id]);
    const area = await admin.query("select doc_id, org_id, doc_key from hive.qa_areas where id = $1", [
      c.rows.qa_areas.id,
    ]);
    expect(area.rows).toEqual([{ doc_id: null, org_id: c.orgId, doc_key: "test-cases/dangnhap.md" }]);
    const status = await admin.query(
      "select ci_run_id, manual_round_case_id, org_id from hive.qa_case_status where case_id = $1",
      [tc],
    );
    expect(status.rows).toEqual([{ ci_run_id: null, manual_round_case_id: null, org_id: c.orgId }]);
    for (const table of ["qa_ci_run_cases", "qa_round_cases", "qa_round_assignees", "qa_result_history"] as const)
      expect((await admin.query(`select 1 from hive.${table} where org_id = $1`, [c.orgId])).rows, table).toEqual([]);

    await admin.query("delete from hive.projects where id = $1", [c.projectId]);
    for (const table of tableNames.filter((t) => t !== "qa_settings"))
      expect((await admin.query(`select 1 from hive.${table} where org_id = $1`, [c.orgId])).rows, table).toEqual([]);
  });
});
