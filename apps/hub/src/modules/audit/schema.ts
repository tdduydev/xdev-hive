import { sql } from "drizzle-orm";
import { index, jsonb, pgPolicy, pgRole, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Khai báo lại schema và role thay vì lấy từ tenancy: audit nằm dưới mọi module (tenancy cũng ghi audit),
// nên không được phụ thuộc ngược vào module nào ngoài platform.
const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();

const inOrg = sql`org_id = hive.ctx_org()`;

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
    ],
  )
  .enableRLS();
