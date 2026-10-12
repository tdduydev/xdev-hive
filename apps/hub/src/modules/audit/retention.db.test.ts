import { randomUUID } from "node:crypto";
import { AUDIT_RETENTION_MIN_DAYS, auditRetentionInput } from "@xdev-hive/contracts";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { freshDatabase, seedUsers } from "../../../test/seed.ts";
import { createJobs, createPool, type Jobs, type Tx, withTenant } from "../platform/index.ts";
import { requireOrgRole } from "../tenancy/index.ts";
import {
  AUDIT_RETENTION_CRON,
  AUDIT_RETENTION_QUEUE,
  auditRetentionQueue,
  getAuditRetention,
  purgeExpiredAudit,
  registerAuditRetentionWorker,
  setAuditRetention,
  withAuditAccess,
} from "./index.ts";
import { auditLog, auditSettings } from "./schema.ts";

// Database riêng: hàm dọn chạy trên mọi tổ chức của hub, không được xoá nhật ký mà file test khác đang kiểm.
const db = inject("db");
let admin: pg.Pool;
let owner: pg.Pool;
let app: pg.Pool;
let jobs: Jobs | undefined;
const sharedAdmin = new pg.Pool({ connectionString: db.adminUrl });

const orgShort = randomUUID();
const orgDefault = randomUUID();
const orgLong = randomUUID();
const orgOther = randomUUID();
const chief = "retention-owner";
const manager = "retention-admin";
const member = "retention-member";

/** Drizzle bọc lỗi Postgres trong `cause`; so theo mã SQLSTATE cho chắc. */
async function pgCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
}
const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";

const as = <T>(orgId: string, fn: (tx: Tx) => Promise<T>, userId = chief) => withTenant(app, { userId, orgId }, fn);

async function event(orgId: string, action: string, daysAgo: number): Promise<string> {
  const { rows } = await admin.query(
    "insert into hive.audit_log (org_id, action, created_at) values ($1, $2, now() - $3 * interval '1 day') returning id",
    [orgId, action, daysAgo],
  );
  return rows[0].id;
}

async function actions(orgId: string): Promise<string[]> {
  const { rows } = await admin.query("select action from hive.audit_log where org_id = $1 order by action", [orgId]);
  return rows.map((r) => r.action);
}

beforeAll(async () => {
  const urls = await freshDatabase(db);
  admin = new pg.Pool({ connectionString: urls.adminUrl });
  owner = new pg.Pool({ connectionString: urls.ownerUrl });
  app = createPool(urls.appUrl);
  await seedUsers(admin, [chief, manager, member]);
  for (const orgId of [orgShort, orgDefault, orgLong, orgOther]) {
    await admin.query("insert into hive.orgs (id, slug, name, created_by) values ($1, $2, 'Retention', $3)", [
      orgId,
      `retention-${orgId}`,
      chief,
    ]);
    await admin.query(
      `insert into hive.org_members (org_id, user_id, role, status) values
      ($1, $2, 'owner', 'active'), ($1, $3, 'admin', 'active'), ($1, $4, 'member', 'active')`,
      [orgId, chief, manager, member],
    );
  }
});

afterAll(async () => {
  await jobs?.stop();
  await Promise.all([admin?.end(), owner?.end(), app?.end(), sharedAdmin.end()]);
});

describe("thời hạn lưu của tổ chức", () => {
  it("mặc định 365 ngày khi tổ chức chưa cấu hình", async () => {
    expect(await as(orgDefault, getAuditRetention)).toEqual({ retentionDays: 365, updatedAt: null });
    const { rows } = await admin.query("select hive.audit_retention_days($1) as days", [orgDefault]);
    expect(rows[0].days).toBe(365);
  });

  it("đổi thời hạn ghi audit kèm giá trị trước/sau; lưu lại cùng giá trị thì không ghi thêm", async () => {
    const saved = await as(orgShort, (tx) => setAuditRetention(tx, { retentionDays: 180 }), manager);
    expect(saved.retentionDays).toBe(180);
    expect(saved.updatedAt).not.toBeNull();
    await as(orgShort, (tx) => setAuditRetention(tx, { retentionDays: 90 }), manager);
    await as(orgShort, (tx) => setAuditRetention(tx, { retentionDays: 90 }), manager);
    expect(await as(orgShort, getAuditRetention)).toMatchObject({ retentionDays: 90 });
    const { rows } = await admin.query(
      `select actor_user_id, target_type, data from hive.audit_log
       where org_id = $1 and action = 'audit.retention.update' order by created_at`,
      [orgShort],
    );
    expect(rows).toEqual([
      {
        actor_user_id: manager,
        target_type: "audit_settings",
        data: { before: { retentionDays: 365 }, after: { retentionDays: 180 } },
      },
      {
        actor_user_id: manager,
        target_type: "audit_settings",
        data: { before: { retentionDays: 180 }, after: { retentionDays: 90 } },
      },
    ]);
    await as(orgLong, (tx) => setAuditRetention(tx, { retentionDays: 730 }));
  });

  it("từ chối thời hạn dưới sàn ở hợp đồng API lẫn trong database, không ghi gì", async () => {
    expect(
      auditRetentionInput.safeParse({ retentionDays: AUDIT_RETENTION_MIN_DAYS - 1 }).error?.issues[0]?.message,
    ).toBe("Thời hạn lưu tối thiểu 90 ngày.");
    expect(auditRetentionInput.safeParse({ retentionDays: 3651 }).success).toBe(false);
    expect(auditRetentionInput.safeParse({ retentionDays: 90.5 }).success).toBe(false);
    // Gọi thẳng service, bỏ qua hợp đồng: CHECK của bảng chặn và cả transaction rollback, kể cả dòng audit.
    expect(await pgCode(() => as(orgShort, (tx) => setAuditRetention(tx, { retentionDays: 1 })))).toBe(CHECK_VIOLATION);
    expect(await as(orgShort, getAuditRetention)).toMatchObject({ retentionDays: 90 });
    const { rows } = await admin.query(
      "select count(*)::int as n from hive.audit_log where org_id = $1 and action = 'audit.retention.update'",
      [orgShort],
    );
    expect(rows[0].n).toBe(2);
  });

  it("chỉ chủ sở hữu và quản trị được đổi; thành viên bị từ chối và lần từ chối được ghi", async () => {
    const authorize = (userId: string) => (tx: Tx) => requireOrgRole(tx, userId, "admin");
    await expect(
      withAuditAccess(app, { orgId: orgDefault, userId: member }, authorize(member), (tx) =>
        setAuditRetention(tx, { retentionDays: 90 }),
      ),
    ).rejects.toMatchObject({ code: "ORG_ROLE_REQUIRED" });
    expect(await as(orgDefault, getAuditRetention)).toEqual({ retentionDays: 365, updatedAt: null });
    const { rows } = await admin.query("select action from hive.audit_log where org_id = $1 and actor_user_id = $2", [
      orgDefault,
      member,
    ]);
    expect(rows).toEqual([{ action: "audit.denied" }]);
    for (const userId of [chief, manager]) {
      const view = await withAuditAccess(app, { orgId: orgOther, userId }, authorize(userId), getAuditRetention);
      expect(view.retentionDays).toBe(365);
    }
  });

  it("RLS: không context thì 0 dòng, không thấy hay ghi cấu hình của tổ chức khác, không xoá được cấu hình", async () => {
    expect(await withTenant(app, {}, (tx) => tx.select().from(auditSettings))).toHaveLength(0);
    const seen = await as(orgShort, (tx) => tx.select().from(auditSettings));
    expect(seen.map((r) => r.orgId)).toEqual([orgShort]);
    const cross = await pgCode(() =>
      as(orgDefault, (tx) => tx.insert(auditSettings).values({ orgId: orgLong, retentionDays: 90 })),
    );
    expect(cross).toBe(INSUFFICIENT_PRIVILEGE);
    const moved = await pgCode(() =>
      as(orgShort, (tx) => tx.update(auditSettings).set({ orgId: orgLong }).where(eq(auditSettings.orgId, orgShort))),
    );
    expect(moved).toBe(INSUFFICIENT_PRIVILEGE);
    // Xoá dòng cấu hình sẽ đưa thời hạn về mặc định mà không có audit.
    expect(await pgCode(() => as(orgShort, (tx) => tx.delete(auditSettings)))).toBe(INSUFFICIENT_PRIVILEGE);
    const { rows } = await admin.query(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'hive.audit_settings'::regclass",
    );
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});

describe("dọn nhật ký quá hạn", () => {
  let recentDefault = "";
  beforeAll(async () => {
    // orgShort giữ 90 ngày, orgDefault 365 (mặc định), orgLong 730.
    await event(orgShort, "short.expired", 91);
    await event(orgShort, "short.kept", 89);
    await event(orgDefault, "default.expired", 366);
    recentDefault = await event(orgDefault, "default.kept", 364);
    await event(orgLong, "long.expired", 731);
    await event(orgLong, "long.kept", 400);
  });

  it("hive_app vẫn không UPDATE hay DELETE thẳng được dòng nhật ký, kể cả dòng đã quá hạn", async () => {
    for (const run of [
      (tx: Tx) => tx.delete(auditLog).where(eq(auditLog.action, "default.expired")),
      (tx: Tx) => tx.update(auditLog).set({ action: "bị sửa" }).where(eq(auditLog.id, recentDefault)),
    ])
      expect(await pgCode(() => as(orgDefault, run))).toBe(INSUFFICIENT_PRIVILEGE);
    await expect(app.query("truncate hive.audit_log")).rejects.toThrow(/permission denied/);
    expect(await actions(orgDefault)).toContain("default.expired");
  });

  it("cả hive_owner cũng chỉ thấy và xoá được dòng đã quá hạn, không ghi được dòng tuỳ ý", async () => {
    // FORCE RLS: chủ bảng (chủ hàm dọn) chịu policy theo thời hạn của từng tổ chức.
    const all = await owner.query("select action from hive.audit_log where org_id = $1 order by action", [orgLong]);
    expect(all.rows.map((r) => r.action)).toEqual(["long.expired"]);
    const removed = await owner.query("delete from hive.audit_log where org_id = $1 and action = 'long.kept'", [
      orgLong,
    ]);
    expect(removed.rowCount).toBe(0);
    await expect(
      owner.query("insert into hive.audit_log (org_id, action) values ($1, 'forged.event')", [orgLong]),
    ).rejects.toThrow(/row-level security/);
    await expect(
      owner.query("update hive.audit_log set action = 'bị sửa' where org_id = $1", [orgLong]),
    ).resolves.toMatchObject({ rowCount: 0 });
    expect(await actions(orgLong)).toEqual(["audit.retention.update", "long.expired", "long.kept"]);
  });

  it("chỉ hive_app gọi được hàm dọn", async () => {
    const { rows } = await admin.query(
      `select has_function_privilege('hive_app', 'hive.purge_expired_audit_log()', 'execute') as app,
              has_function_privilege('hive_auth', 'hive.purge_expired_audit_log()', 'execute') as auth,
              has_function_privilege('hive_auth', 'hive.audit_retention_days(uuid)', 'execute') as days`,
    );
    expect(rows[0]).toEqual({ app: true, auth: false, days: false });
  });

  it("xoá đúng dòng quá thời hạn của từng tổ chức và ghi audit.purge cho tổ chức bị xoá", async () => {
    const otherBefore = await actions(orgOther);
    expect(await purgeExpiredAudit(app)).toBe(3);
    expect(await actions(orgShort)).toEqual([
      "audit.purge",
      "audit.retention.update",
      "audit.retention.update",
      "short.kept",
    ]);
    expect(await actions(orgDefault)).toEqual(["audit.denied", "audit.purge", "default.kept"]);
    expect(await actions(orgLong)).toEqual(["audit.purge", "audit.retention.update", "long.kept"]);
    expect(await actions(orgOther)).toEqual(otherBefore);
    const { rows } = await admin.query(
      `select org_id, actor_user_id, target_type, data from hive.audit_log where action = 'audit.purge'`,
    );
    const byOrg = Object.fromEntries(rows.map((r) => [r.org_id, r]));
    expect(rows).toHaveLength(3);
    for (const [orgId, days] of [
      [orgShort, 90],
      [orgDefault, 365],
      [orgLong, 730],
    ] as const)
      expect(byOrg[orgId]).toMatchObject({
        actor_user_id: null,
        target_type: "audit_log",
        data: { deleted: 1, retentionDays: days, before: expect.any(String) },
      });
    // Tổ chức thấy dòng audit.purge của mình qua RLS như mọi dòng khác.
    const visible = await as(orgShort, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "audit.purge")));
    expect(visible).toHaveLength(1);
  });

  it("chạy lại không xoá thêm, không ghi thêm audit.purge", async () => {
    expect(await purgeExpiredAudit(app)).toBe(0);
    const { rows } = await admin.query("select count(*)::int as n from hive.audit_log where action = 'audit.purge'");
    expect(rows[0].n).toBe(3);
  });

  it("worker chạy theo hàng đợi pg-boss và đặt lịch hằng ngày", async () => {
    await event(orgDefault, "default.expired.again", 400);
    jobs = createJobs({ connectionString: db.jobsUrl, queues: [auditRetentionQueue], maintenance: false });
    await jobs.start();
    await registerAuditRetentionWorker(jobs, { pool: app }, { pollingIntervalSeconds: 0.5 });
    const { rows } = await sharedAdmin.query("select cron from pgboss.schedule where name = $1", [
      AUDIT_RETENTION_QUEUE,
    ]);
    expect(rows).toEqual([{ cron: AUDIT_RETENTION_CRON }]);
    await jobs.enqueue(AUDIT_RETENTION_QUEUE, {});
    await expect.poll(() => actions(orgDefault), { timeout: 15_000 }).not.toContain("default.expired.again");
    expect(await actions(orgDefault)).toContain("default.kept");
  });

  it("giữ sàn 90 ngày kể cả khi cấu hình trong database bị sửa lách CHECK", async () => {
    // Chỉ superuser làm được việc này; database của file test là riêng nên gỡ CHECK không ảnh hưởng file khác.
    await admin.query("alter table hive.audit_settings drop constraint audit_settings_retention_days");
    await admin.query("update hive.audit_settings set retention_days = 1 where org_id = $1", [orgShort]);
    await event(orgShort, "short.recent", 30);
    expect(await purgeExpiredAudit(app)).toBe(0);
    expect(await actions(orgShort)).toContain("short.recent");
    const { rows } = await admin.query("select hive.audit_retention_days($1) as days", [orgShort]);
    expect(rows[0].days).toBe(90);
  });
});
