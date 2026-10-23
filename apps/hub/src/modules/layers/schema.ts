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

const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();
const inOrg = sql`org_id = hive.ctx_org()`;

// Dự án giữ giá trị riêng trong projects.settings; bảng này bổ sung mặc định và khoá của tổ chức.
export const configLayerEntries = hive
  .table(
    "config_layer_entries",
    {
      orgId: uuid("org_id").notNull().default(sql`hive.ctx_org()`),
      layer: text("layer").$type<"org" | "project">().notNull(),
      targetId: uuid("target_id").notNull(),
      key: text("key").notNull(),
      value: jsonb("value"),
      locked: boolean("locked").notNull().default(false),
      version: integer("version").notNull().default(1),
      updatedBy: text("updated_by"),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      check("config_layer_entries_layer", sql`layer in ('org', 'project')`),
      primaryKey({ columns: [t.orgId, t.layer, t.targetId, t.key] }),
      pgPolicy("config_layer_entries_rw", { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg }),
    ],
  )
  .enableRLS();
