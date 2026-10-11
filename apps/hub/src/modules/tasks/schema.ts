import type { PlanContent } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgRole,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Khai báo lại schema và role thay vì lấy từ tenancy: module chỉ được import module khác qua index.ts.
const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();

const inOrg = sql`org_id = hive.ctx_org()`;

export const taskStatus = hive.enum("task_status", [
  "todo",
  "queued",
  "running",
  "awaiting_plan",
  "review",
  "done",
  "cancelled",
]);
export const planStatus = hive.enum("plan_status", ["awaiting", "approved", "rejected", "superseded"]);

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

/**
 * Kế hoạch của plan mode (docs/architecture.md mục 4.1): run `plan` nộp kế hoạch, run code của task chờ ở
 * `awaiting_plan` tới khi người duyệt hoặc từ chối. Khoá ngoại tới runs và teams (bảng của module khác) nằm trong
 * migration viết tay.
 */
export const plans = hive
  .table(
    "plans",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      teamId: uuid("team_id").notNull(),
      taskId: uuid("task_id").notNull(),
      /** Run code chờ kế hoạch; duyệt thì chính run này chạy tiếp. */
      runId: uuid("run_id").notNull(),
      /** Run `plan` đã lập kế hoạch; mỗi run plan nhiều nhất một kế hoạch. */
      planRunId: uuid("plan_run_id").notNull(),
      revision: integer("revision").notNull(),
      status: planStatus("status").notNull().default("awaiting"),
      content: jsonb("content").$type<PlanContent>().notNull(),
      /** Bản người duyệt sửa; giữ riêng để còn biết agent đã đề xuất gì. */
      editedContent: jsonb("edited_content").$type<PlanContent>(),
      note: text("note"),
      decidedBy: text("decided_by"),
      decidedAt: timestamp("decided_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("plans_plan_run").on(t.planRunId),
      unique("plans_task_revision").on(t.taskId, t.revision),
      // Một run code chỉ chờ một kế hoạch: hai lần kết luận chạy chồng không ghi được hai kế hoạch cùng chờ.
      uniqueIndex("plans_run_awaiting").on(t.runId).where(sql`status = 'awaiting'`),
      // Khoá kép theo tổ chức: khoá ngoại bỏ qua RLS, thiếu org_id thì kế hoạch trỏ được tới task của tổ chức khác.
      foreignKey({ columns: [t.taskId, t.orgId], foreignColumns: [tasks.id, tasks.orgId] }).onDelete("cascade"),
      index("plans_org_team").on(t.orgId, t.teamId),
      index("plans_task_created").on(t.taskId, t.createdAt),
      // Dispatch tìm kế hoạch đã duyệt của run code; huỷ run tìm kế hoạch còn chờ.
      index("plans_run").on(t.runId),
      pgPolicy("plans_rw", { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg }),
    ],
  )
  .enableRLS();
