import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgPolicy, pgRole, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

// Khai báo lại schema và role thay vì lấy từ tenancy: module chỉ được import module khác qua index.ts.
const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();

const inOrg = sql`org_id = hive.ctx_org()`;

export const taskStatus = hive.enum("task_status", ["todo", "queued", "running", "review", "done", "cancelled"]);

/**
 * Task thuộc một dự án; team_id chép từ dự án để kiểm quyền đội không phải join sang bảng của catalog. Khoá ngoại tới
 * projects và teams (bảng của module khác) nằm trong migration viết tay.
 */
export const tasks = hive
  .table(
    "tasks",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      teamId: uuid("team_id").notNull(),
      projectId: uuid("project_id").notNull(),
      /** Số thứ tự trong dự án; key của task là `<project key>-<number>`. */
      number: integer("number").notNull(),
      /** Chép lúc tạo để nhánh `ai/<key>` không đổi khi dự án đổi key. */
      key: text("key").notNull(),
      title: text("title").notNull(),
      body: text("body").notNull().default(""),
      type: text("type"),
      status: taskStatus("status").notNull().default("todo"),
      preferredCli: text("preferred_cli").$type<"claude" | "codex" | "gemini">(),
      createdBy: text("created_by").notNull(),
      source: jsonb("source").$type<Record<string, unknown>>().notNull().default({}),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("tasks_project_number").on(t.projectId, t.number),
      unique("tasks_id_org").on(t.id, t.orgId),
      index("tasks_org_team").on(t.orgId, t.teamId),
      index("tasks_project_status").on(t.projectId, t.status),
      pgPolicy("tasks_rw", { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg }),
    ],
  )
  .enableRLS();
