import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgPolicy, pgRole, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Khai báo lại schema và role thay vì lấy từ tenancy: audit nằm dưới mọi module (tenancy cũng ghi audit),
// nên không được phụ thuộc ngược vào module nào ngoài platform.
const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();
const hiveOwner = pgRole("hive_owner").existing();

const inOrg = sql`org_id = hive.ctx_org()`;
// hive.audit_retention_days() (migration 0048) áp sàn 90 ngày và mặc định 365 cho tổ chức chưa có cấu hình.
const expired = sql`created_at < now() - make_interval(days => hive.audit_retention_days(org_id))`;

/**
 * Nhật ký append-only. Chỉ có policy SELECT và INSERT: dù quyền UPDATE/DELETE có bị cấp lại nhầm,
 * RLS vẫn không cho dòng nào khớp. Migration còn REVOKE hai quyền đó khỏi hive_app.
 */
export const auditLog = hive
  .table(
    "audit_log",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      // Không có khoá ngoại tới orgs: nhật ký phải sống sót kể cả khi tổ chức bị xoá.
      orgId: uuid("org_id").notNull(),
      // Null khi thao tác do hệ thống (job, webhook) làm, không có người dùng.
      actorUserId: text("actor_user_id"),
      action: text("action").notNull(),
      targetType: text("target_type"),
      targetId: text("target_id"),
      data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      index("audit_log_org_created").on(t.orgId, t.createdAt.desc()),
      index("audit_log_org_created_id").on(t.orgId, t.createdAt.desc(), t.id.desc()),
      index("audit_log_org_action_created").on(t.orgId, t.action, t.createdAt.desc()),
      index("audit_log_org_actor_created").on(t.orgId, t.actorUserId, t.createdAt.desc()),
      index("audit_log_org_target").on(t.orgId, t.targetType, t.targetId),
      pgPolicy("audit_log_select", { for: "select", to: hiveApp, using: inOrg }),
      pgPolicy("audit_log_insert", { for: "insert", to: hiveApp, withCheck: inOrg }),
      // Chỉ hàm hive.purge_expired_audit_log() (SECURITY DEFINER, chủ là hive_owner) xoá được, và FORCE RLS giới hạn nó
      // ở dòng đã quá thời hạn lưu của tổ chức: lỗi trong hàm hay ai đó kết nối bằng hive_owner cũng không xoá sớm được.
      // DELETE có WHERE cần thêm quyền đọc đúng các dòng đó.
      pgPolicy("audit_log_owner_purge_select", { for: "select", to: hiveOwner, using: expired }),
      pgPolicy("audit_log_owner_purge", { for: "delete", to: hiveOwner, using: expired }),
      // Hàm dọn ghi một dòng audit.purge cho mỗi tổ chức bị xoá dòng, ngoài ra hive_owner không ghi được gì.
      pgPolicy("audit_log_owner_purge_record", {
        for: "insert",
        to: hiveOwner,
        withCheck: sql`action = 'audit.purge' AND actor_user_id IS NULL`,
      }),
    ],
  )
  .enableRLS();

/**
 * Thời hạn lưu nhật ký của tổ chức (OPS-07). Không có dòng nghĩa là mặc định 365 ngày. Không có khoá ngoại tới orgs vì
 * cùng lý do với audit_log. hive_app không có policy DELETE: xoá dòng sẽ lặng lẽ đưa thời hạn về mặc định mà không qua
 * audit.
 */
export const auditSettings = hive
  .table(
    "audit_settings",
    {
      orgId: uuid("org_id").primaryKey(),
      retentionDays: integer("retention_days").notNull().default(365),
      updatedBy: text("updated_by"),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      check("audit_settings_retention_days", sql`${t.retentionDays} BETWEEN 90 AND 3650`),
      pgPolicy("audit_settings_select", { for: "select", to: hiveApp, using: inOrg }),
      pgPolicy("audit_settings_insert", { for: "insert", to: hiveApp, withCheck: inOrg }),
      pgPolicy("audit_settings_update", { for: "update", to: hiveApp, using: inOrg, withCheck: inOrg }),
      // Hàm dọn chạy bằng hive_owner, đọc thời hạn của mọi tổ chức.
      pgPolicy("audit_settings_owner_select", { for: "select", to: hiveOwner, using: sql`true` }),
    ],
  )
  .enableRLS();
