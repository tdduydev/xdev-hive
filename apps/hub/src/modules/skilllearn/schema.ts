import type { LearnTrigger } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import {
  check,
  date,
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
  uuid,
} from "drizzle-orm/pg-core";

// Khai báo lại schema và role thay vì lấy từ module khác: module chỉ được import module khác qua index.ts.
const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();
const hiveOwner = pgRole("hive_owner").existing();
const inOrg = sql`org_id = hive.ctx_org()`;
const orgScoped = (name: string) => pgPolicy(`${name}_rw`, { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg });

/**
 * Một lô học của một dự án trong một ngày (UTC): mỗi (dự án, ngày) tối đa một dòng, nên job hẹn giờ chạy lại bao nhiêu
 * lần cũng không tạo hai run. `window_to` của lô gần nhất là mốc bắt đầu của lô sau, để run đã xét không bị xét lại.
 * Khoá ngoại tới projects và runs (bảng của module khác) nằm trong migration viết tay.
 */
export const skillLearningBatches = hive
  .table(
    "skill_learning_batches",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      teamId: uuid("team_id").notNull(),
      projectId: uuid("project_id").notNull(),
      day: date("day", { mode: "string" }).notNull(),
      windowFrom: timestamp("window_from", { withTimezone: true }).notNull(),
      windowTo: timestamp("window_to", { withTimezone: true }).notNull(),
      /** `empty`: không có run đáng học, không tạo run agent; `running`: chờ run `skill_proposal` xong. */
      status: text("status").notNull(),
      /** Run `skill_proposal` của lô; null khi `empty`. */
      runId: uuid("run_id"),
      /** Run code đã đưa vào lô, kèm lý do đáng học (id → danh sách trigger). */
      candidates: jsonb("candidates").$type<Record<string, LearnTrigger[]>>().notNull().default({}),
      /** Số đề xuất hub nhận, số bị bỏ vì trùng hoặc vượt hạn mức. */
      accepted: integer("accepted").notNull().default(0),
      duplicates: integer("duplicates").notNull().default(0),
      note: text("note"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      finishedAt: timestamp("finished_at", { withTimezone: true }),
    },
    (t) => [
      unique("skill_learning_batches_project_day").on(t.projectId, t.day),
      unique("skill_learning_batches_id_org").on(t.id, t.orgId),
      check("skill_learning_batches_status", sql`status in ('running', 'done', 'failed', 'empty')`),
      index("skill_learning_batches_org_created").on(t.orgId, t.createdAt.desc()),
      orgScoped("skill_learning_batches"),
      // hive.skill_learning_orgs (SECURITY DEFINER, chạy bằng hive_owner) liệt kê tổ chức còn lô đang chạy.
      pgPolicy("skill_learning_batches_owner_select", { for: "select", to: hiveOwner, using: sql`true` }),
    ],
  )
  .enableRLS();

/** Người trong đội đánh dấu một run “nên thành skill”: lô sau xét run đó dù không thử lại hay đắt. */
export const skillLearningMarks = hive
  .table(
    "skill_learning_marks",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      runId: uuid("run_id").notNull(),
      markedBy: text("marked_by").notNull(),
      note: text("note"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [unique("skill_learning_marks_run").on(t.runId), orgScoped("skill_learning_marks")],
  )
  .enableRLS();

/**
 * Đề xuất skill agent viết, chờ quản trị đội duyệt. Giữ cả đề xuất bị từ chối (kèm lý do) để lô sau không đề xuất lại
 * đúng skill đó. `scope_*` là phạm vi của skill đang sửa (`edit`) hoặc dự án nguồn (`new`).
 */
export const learnedSkillProposals = hive
  .table(
    "learned_skill_proposals",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      batchId: uuid("batch_id").notNull(),
      /** Run `skill_proposal` viết đề xuất. */
      runId: uuid("run_id").notNull(),
      teamId: uuid("team_id").notNull(),
      projectId: uuid("project_id").notNull(),
      kind: text("kind").notNull(),
      name: text("name").notNull(),
      description: text("description").notNull(),
      content: text("content").notNull(),
      reason: text("reason").notNull(),
      /** Phạm vi của skill đích: team_id null là cả tổ chức, project_id null là cả đội. */
      scopeTeamId: uuid("scope_team_id"),
      scopeProjectId: uuid("scope_project_id"),
      baseVersion: integer("base_version").notNull().default(0),
      triggers: text("triggers").array().notNull().default(sql`'{}'::text[]`),
      sourceRunIds: uuid("source_run_ids").array().notNull().default(sql`'{}'::uuid[]`),
      status: text("status").notNull().default("pending"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      decidedBy: text("decided_by"),
      decidedAt: timestamp("decided_at", { withTimezone: true }),
      decisionNote: text("decision_note"),
      /** Cách đưa vào skill của tổ chức khi duyệt: `pr` (kho Git) hoặc `saved` (lưu thẳng vì chưa nối kho). */
      deliveryMode: text("delivery_mode"),
      prNumber: integer("pr_number"),
      prUrl: text("pr_url"),
      deliveryError: text("delivery_error"),
      resultSkillId: uuid("result_skill_id"),
      resultVersion: integer("result_version"),
    },
    (t) => [
      check("learned_skill_proposals_kind", sql`kind in ('new', 'edit')`),
      check("learned_skill_proposals_status", sql`status in ('pending', 'approved', 'rejected')`),
      check("learned_skill_proposals_delivery", sql`delivery_mode is null or delivery_mode in ('pr', 'saved')`),
      check("learned_skill_proposals_scope", sql`scope_project_id is null or scope_team_id is not null`),
      foreignKey({
        columns: [t.batchId, t.orgId],
        foreignColumns: [skillLearningBatches.id, skillLearningBatches.orgId],
      }).onDelete("cascade"),
      index("learned_skill_proposals_org_status").on(t.orgId, t.status, t.createdAt.desc()),
      index("learned_skill_proposals_project").on(t.projectId, t.name),
      orgScoped("learned_skill_proposals"),
    ],
  )
  .enableRLS();
