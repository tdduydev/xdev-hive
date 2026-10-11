import { sql } from "drizzle-orm";
import { boolean, check, index, pgPolicy, pgRole, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();
const inOrg = sql`org_id = hive.ctx_org()`;
const scoped = (name: string) => pgPolicy(`${name}_rw`, { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg });

// Cấu hình tổ chức thuộc sandbox để tenancy không cần biết chính sách mạng của runner.
export const sandboxOrgSettings = hive
  .table(
    "sandbox_org_settings",
    {
      orgId: uuid("org_id").primaryKey(),
      locked: boolean("locked").notNull().default(false),
      useSuggestedDefaults: boolean("use_suggested_defaults").notNull().default(false),
    },
    () => [scoped("sandbox_org_settings")],
  )
  .enableRLS();

export const egressAllowlists = hive
  .table(
    "egress_allowlists",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      teamId: uuid("team_id"),
      projectId: uuid("project_id"),
      rule: text("rule").notNull(),
      note: text("note"),
      addedBy: text("added_by").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      check("egress_allowlists_scope", sql`(${t.projectId} is null) = (${t.teamId} is null)`),
      index("egress_allowlists_org_project").on(t.orgId, t.projectId),
      index("egress_allowlists_team").on(t.teamId),
      scoped("egress_allowlists"),
    ],
  )
  .enableRLS();

// Một cấu hình hiện tại cho mỗi dự án; cache trên runner dùng base image và hash, không dùng id của dòng.
export const envImages = hive
  .table(
    "env_images",
    {
      projectId: uuid("project_id").primaryKey(),
      orgId: uuid("org_id").notNull(),
      teamId: uuid("team_id").notNull(),
      baseImage: text("base_image").notNull(),
      setupScriptHash: text("setup_script_hash").notNull(),
      updatedBy: text("updated_by").notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [index("env_images_org").on(t.orgId), index("env_images_team").on(t.teamId), scoped("env_images")],
  )
  .enableRLS();
