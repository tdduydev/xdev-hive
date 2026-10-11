import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPool, withTenant } from "../platform/index.ts";
import { recordAudit } from "./index.ts";
import { auditLog } from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);

const orgA = randomUUID();
const orgB = randomUUID();
let rowB = "";

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
// Cùng một mã cho cả vi phạm policy RLS lẫn thiếu quyền trên bảng.
const INSUFFICIENT_PRIVILEGE = "42501";

beforeAll(async () => {
  // Seed bằng superuser (bỏ qua RLS). audit_log không có khoá ngoại nên không cần dựng tổ chức.
  rowB = (
    await admin.query(
      "insert into hive.audit_log (org_id, actor_user_id, action) values ($1, 'u-b', 'team.create') returning id",
      [orgB],
    )
  ).rows[0].id;
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("recordAudit", () => {
  it("ghi vào tổ chức của context, lấy người làm từ context khi không truyền", async () => {
    const id = await withTenant(app, { userId: "u-a", orgId: orgA }, (tx) =>
      recordAudit(tx, { action: "team.create", targetType: "team", targetId: "t-1", data: { name: "TA" } }),
    );
    const { rows } = await admin.query("select * from hive.audit_log where id = $1", [id]);
    expect(rows[0]).toMatchObject({
      org_id: orgA,
      actor_user_id: "u-a",
      action: "team.create",
      target_type: "team",
      target_id: "t-1",
      data: { name: "TA" },
    });
  });

  it("actorUserId null nghĩa là hệ thống làm, không lấy từ context", async () => {
    const id = await withTenant(app, { userId: "u-a", orgId: orgA }, (tx) =>
      recordAudit(tx, { action: "system.sync", actorUserId: null }),
    );
    const { rows } = await admin.query("select actor_user_id, data from hive.audit_log where id = $1", [id]);
    expect(rows[0]).toEqual({ actor_user_id: null, data: {} });
  });

  it("rollback cùng thao tác được ghi", async () => {
    const action = `rollback.${randomUUID()}`;
    await expect(
      withTenant(app, { userId: "u-a", orgId: orgA }, async (tx) => {
        await recordAudit(tx, { action });
        throw new Error("thao tác hỏng");
      }),
    ).rejects.toThrow("thao tác hỏng");
    const { rows } = await admin.query("select 1 from hive.audit_log where action = $1", [action]);
    expect(rows).toHaveLength(0);
  });

  it("thiếu tổ chức trong context thì báo lỗi, không ghi lặng lẽ", async () => {
    const code = await pgCode(() => withTenant(app, { userId: "u-a" }, (tx) => recordAudit(tx, { action: "x.y" })));
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe("RLS của audit_log", () => {
  it("bật và ép RLS", async () => {
    const { rows } = await admin.query(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'hive.audit_log'::regclass",
    );
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("không có context thì trả 0 dòng", async () => {
    expect(await withTenant(app, {}, (tx) => tx.select().from(auditLog))).toHaveLength(0);
  });

  it("không đọc chéo tổ chức", async () => {
    const seen = await withTenant(app, { userId: "u-a", orgId: orgA }, (tx) => tx.select().from(auditLog));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.orgId === orgA)).toBe(true);
    const seenB = await withTenant(app, { userId: "u-b", orgId: orgB }, (tx) => tx.select().from(auditLog));
    expect(seenB.map((r) => r.id)).toEqual([rowB]);
  });

  it("không ghi được dòng cho tổ chức khác", async () => {
    const code = await pgCode(() =>
      withTenant(app, { userId: "u-a", orgId: orgA }, (tx) =>
        tx.insert(auditLog).values({ orgId: orgB, actorUserId: "u-a", action: "team.create" }),
      ),
    );
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe("append-only", () => {
  it("hive_app chỉ có SELECT và INSERT", async () => {
    const { rows } = await admin.query(
      `select privilege_type from information_schema.role_table_grants
       where grantee = 'hive_app' and table_schema = 'hive' and table_name = 'audit_log' order by 1`,
    );
    expect(rows.map((r) => r.privilege_type)).toEqual(["INSERT", "SELECT"]);
  });

  it("không UPDATE được, kể cả dòng của chính tổ chức", async () => {
    const code = await pgCode(() =>
      withTenant(app, { userId: "u-b", orgId: orgB }, (tx) =>
        tx.update(auditLog).set({ action: "bị sửa" }).where(eq(auditLog.id, rowB)),
      ),
    );
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("không DELETE hay TRUNCATE được", async () => {
    const del = await pgCode(() =>
      withTenant(app, { userId: "u-b", orgId: orgB }, (tx) => tx.delete(auditLog).where(eq(auditLog.id, rowB))),
    );
    expect(del).toBe(INSUFFICIENT_PRIVILEGE);
    await expect(app.query("truncate hive.audit_log")).rejects.toThrow(/permission denied/);
    const { rows } = await admin.query("select action from hive.audit_log where id = $1", [rowB]);
    expect(rows[0].action).toBe("team.create");
  });
});
