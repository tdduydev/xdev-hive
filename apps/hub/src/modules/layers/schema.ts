import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgPolicy,
  pgRole,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// Khai báo lại schema và role thay vì lấy từ tenancy: module chỉ được import module khác qua index.ts.
const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();
const inOrg = sql`org_id = hive.ctx_org()`;

/**
 * Giá trị cấu hình ở tầng công ty và tầng đội (specs/033). Chính sách công ty và cài đặt dự án vẫn nằm ở bảng cũ; bảng
 * này chỉ giữ phần chưa có chỗ ở: giá trị của đội, và cờ khoá. `value` null là "chỉ khoá, chưa đặt giá trị".
 * Không có khoá ngoại tới teams để module giữ đúng ranh giới; dòng của đội đã xoá bị bỏ qua khi đọc.
 */
export const configLayerEntries = hive
  .table(
    "config_layer_entries",
    {
      orgId: uuid("org_id").notNull().default(sql`hive.ctx_org()`),
      layer: text("layer").$type<"org" | "team">().notNull(),
      targetId: uuid("target_id").notNull(),
      key: text("key").notNull(),
      value: jsonb("value"),
      locked: boolean("locked").notNull().default(false),
      version: integer("version").notNull().default(1),
      updatedBy: text("updated_by"),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      check("config_layer_entries_layer", sql`layer in ('org', 'team')`),
      primaryKey({ columns: [t.orgId, t.layer, t.targetId, t.key] }),
      pgPolicy("config_layer_entries_rw", { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg }),
    ],
  )
  .enableRLS();
