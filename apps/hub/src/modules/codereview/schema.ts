import type { ChecklistItem, CodeOptions, ReviewPhase } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgRole,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Khai báo lại schema và role thay vì lấy từ module khác: module chỉ được import module khác qua index.ts.
const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();
const hiveOwner = pgRole("hive_owner").existing();

const inOrg = sql`org_id = hive.ctx_org()`;
const orgScoped = (name: string) => pgPolicy(`${name}_rw`, { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg });

/**
 * Một phiên review code của một PR do run code mở (specs/009-code-review-workflows). Chép tên, giai đoạn và tuỳ chọn
 * của quy trình lúc mở: sửa quy trình sau đó không đổi phiên đang chạy. Không khoá ngoại tới runs/tasks/projects:
 * module chỉ tham chiếu bảng của module khác bằng id, như `review_instances`. `workflow_id` có khoá ngoại vì cùng
 * quyền sở hữu với bảng quy trình.
 */
export const codeReviews = hive
  .table(
    "code_reviews",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      teamId: uuid("team_id").notNull(),
      projectId: uuid("project_id").notNull(),
      taskId: uuid("task_id"),
      /** Run code tạo ra `head_sha`; chỉ PR của run mới có phiên (Q3), nên không null. */
      runId: uuid("run_id").notNull(),
      workflowId: uuid("workflow_id"),
      workflowName: text("workflow_name").notNull(),
      phases: jsonb("phases").$type<ReviewPhase[]>().notNull(),
      options: jsonb("options").$type<CodeOptions>().notNull(),
      prNumber: integer("pr_number").notNull(),
      prUrl: text("pr_url").notNull(),
      branch: text("branch").notNull(),
      baseBranch: text("base_branch").notNull(),
      headSha: text("head_sha").notNull(),
      round: integer("round").notNull().default(1),
      previousId: uuid("previous_id"),
      gateIndex: integer("gate_index").notNull().default(0),
      status: text("status").notNull().default("in_review"),
      /** Hướng của lần trả lại gần nhất. */
      route: text("route"),
      /** Agent sửa xong thì quay lại checkpoint này. */
      resumeGateIndex: integer("resume_gate_index"),
      /** Chủ run code gốc. */
      requesterUserId: text("requester_user_id"),
      agentRevisions: integer("agent_revisions").notNull().default(0),
      addedLines: integer("added_lines").notNull().default(0),
      deletedLines: integer("deleted_lines").notNull().default(0),
      changedFiles: integer("changed_files").notNull().default(0),
      /** Lý do `needs_review` của run, hiện cho người duyệt. */
      runReasons: jsonb("run_reasons").$type<string[]>().notNull().default([]),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      check(
        "code_reviews_status",
        sql`status in ('in_review', 'changes_requested', 'approved', 'merged', 'cancelled', 'superseded')`,
      ),
      foreignKey({ columns: [t.previousId], foreignColumns: [t.id] }).onDelete("set null"),
      // Một phiên mở cho mỗi PR: vòng cũ phải `superseded` trước khi mở vòng mới.
      uniqueIndex("code_reviews_open_pr")
        .on(t.projectId, t.prNumber)
        .where(sql`status in ('in_review', 'changes_requested', 'approved')`),
      index("code_reviews_org_status").on(t.orgId, t.status, t.updatedAt.desc()),
      index("code_reviews_run").on(t.runId),
      uniqueIndex("code_reviews_org_id").on(t.orgId, t.id),
      orgScoped("code_reviews"),
      pgPolicy("code_reviews_owner_select", { for: "select", to: hiveOwner, using: sql`true` }),
    ],
  )
  .enableRLS();

/**
 * Mỗi lần một checkpoint chạy trong phiên (chạy lại khi bị trả về checkpoint trước, hoặc khi `head_sha` đổi). Gate AI
 * giữ kết quả từng reviewer trong `details`; gate lệnh giữ kết quả từng lệnh.
 */
export const codeReviewGateRuns = hive
  .table(
    "code_review_gate_runs",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      reviewId: uuid("review_id").notNull(),
      gateIndex: integer("gate_index").notNull(),
      gateId: text("gate_id").notNull(),
      headSha: text("head_sha").notNull(),
      status: text("status").notNull().default("waiting"),
      score: doublePrecision("score"),
      checklist: jsonb("checklist").$type<ChecklistItem[]>().notNull().default([]),
      /** AI: [{cli, model, runId, score, summary, findings, checklist}]; lệnh: [{run, exit, ms, tail}]. */
      details: jsonb("details").$type<Record<string, unknown>[]>().notNull().default([]),
      approvals: jsonb("approvals").$type<{ userId: string; at: string }[]>().notNull().default([]),
      /** Run review của reviewer AI; tra ngược run → phiên qua chỉ mục gin. */
      runIds: uuid("run_ids").array().notNull().default(sql`'{}'`),
      note: text("note"),
      decidedBy: text("decided_by"),
      overridden: boolean("overridden").notNull().default(false),
      dueAt: timestamp("due_at", { withTimezone: true }),
      overdueNotifiedAt: timestamp("overdue_notified_at", { withTimezone: true }),
      startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
      finishedAt: timestamp("finished_at", { withTimezone: true }),
    },
    (t) => [
      check("code_review_gate_runs_status", sql`status in ('waiting', 'passed', 'failed', 'skipped')`),
      foreignKey({ columns: [t.reviewId], foreignColumns: [codeReviews.id] }).onDelete("cascade"),
      index("code_review_gate_runs_review").on(t.reviewId, t.startedAt),
      index("code_review_gate_runs_due").on(t.status, t.dueAt),
      index("code_review_gate_runs_runs").using("gin", t.runIds),
      orgScoped("code_review_gate_runs"),
      // hive.code_review_overdue_orgs (SECURITY DEFINER, chạy bằng hive_owner) tìm tổ chức có checkpoint quá hạn.
      pgPolicy("code_review_gate_runs_owner_select", { for: "select", to: hiveOwner, using: sql`true` }),
    ],
  )
  .enableRLS();

export const codeReviewComments = hive
  .table(
    "code_review_comments",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      reviewId: uuid("review_id").notNull(),
      threadId: uuid("thread_id").notNull(),
      path: text("path").notNull(),
      line: integer("line").notNull(),
      side: text("side").$type<"old" | "new">().notNull(),
      headSha: text("head_sha").notNull(),
      body: text("body").notNull(),
      // Danh tính Better Auth là text, không phải UUID.
      authorId: text("author_id"),
      origin: text("origin").$type<"hive" | "github" | "gitlab">().notNull().default("hive"),
      externalAuthor: text("external_author"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      editedAt: timestamp("edited_at", { withTimezone: true }),
      deletedAt: timestamp("deleted_at", { withTimezone: true }),
      resolvedAt: timestamp("resolved_at", { withTimezone: true }),
      resolvedBy: text("resolved_by"),
    },
    (t) => [
      check("code_review_comments_side", sql`${t.side} in ('old', 'new')`),
      check("code_review_comments_origin", sql`${t.origin} in ('hive', 'github', 'gitlab')`),
      check("code_review_comments_line", sql`${t.line} > 0`),
      check("code_review_comments_body", sql`length(${t.body}) <= 20000`),
      uniqueIndex("code_review_comments_org_id").on(t.orgId, t.id),
      uniqueIndex("code_review_comments_org_review_id").on(t.orgId, t.reviewId, t.id),
      // Khoá ghép chặn liên kết sang review hay luồng của tổ chức khác kể cả khi ghi SQL trực tiếp.
      foreignKey({ columns: [t.orgId, t.reviewId], foreignColumns: [codeReviews.orgId, codeReviews.id] }).onDelete(
        "cascade",
      ),
      foreignKey({ columns: [t.orgId, t.reviewId, t.threadId], foreignColumns: [t.orgId, t.reviewId, t.id] }),
      index("code_review_comments_review").on(t.reviewId, t.createdAt, t.id),
      index("code_review_comments_thread").on(t.threadId),
      orgScoped("code_review_comments"),
    ],
  )
  .enableRLS();

export const codeReviewCommentLinks = hive
  .table(
    "code_review_comment_links",
    {
      commentId: uuid("comment_id").primaryKey(),
      orgId: uuid("org_id").notNull(),
      connectionId: uuid("connection_id").notNull(),
      provider: text("provider").$type<"github" | "gitlab">().notNull(),
      prNumber: integer("pr_number").notNull(),
      providerCommentId: text("provider_comment_id"),
      providerThreadId: text("provider_thread_id"),
      providerUrl: text("provider_url"),
      mode: text("mode").$type<"inline" | "fallback">().notNull().default("inline"),
      state: text("state")
        .$type<"pending" | "synced" | "fallback" | "failed" | "disabled">()
        .notNull()
        .default("pending"),
      bodyHash: text("body_hash"),
      providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
      providerResolved: boolean("provider_resolved").notNull().default(false),
      providerDeleted: boolean("provider_deleted").notNull().default(false),
      attempts: integer("attempts").notNull().default(0),
      lastError: text("last_error"),
      nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
      // Giãn mỗi lần ghi hai giây để giữ hạn mức chung qua nhiều tiến trình.
      writeStartedAt: timestamp("write_started_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      foreignKey({
        columns: [t.orgId, t.commentId],
        foreignColumns: [codeReviewComments.orgId, codeReviewComments.id],
      }).onDelete("cascade"),
      uniqueIndex("code_review_comment_links_provider_id").on(t.connectionId, t.providerCommentId),
      index("code_review_comment_links_pending").on(t.orgId, t.state, t.nextAttemptAt),
      index("code_review_comment_links_connection_write").on(t.connectionId, t.writeStartedAt),
      check(
        "code_review_comment_links_state",
        sql`${t.state} in ('pending', 'synced', 'fallback', 'failed', 'disabled')`,
      ),
      check("code_review_comment_links_mode", sql`${t.mode} in ('inline', 'fallback')`),
      check("code_review_comment_links_provider", sql`${t.provider} in ('github', 'gitlab')`),
      orgScoped("code_review_comment_links"),
    ],
  )
  .enableRLS();
