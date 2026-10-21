import type { ArtifactPageError, LeaderAction } from "@xdev-hive/contracts";
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
  uuid,
} from "drizzle-orm/pg-core";

const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();
const inOrg = sql`org_id = hive.ctx_org()`;
const scoped = (name: string) => pgPolicy(`${name}_rw`, { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg });

export const chatRole = hive.enum("leader_chat_role", ["user", "leader", "system"]);
export const approvalState = hive.enum("leader_approval_state", ["pending", "approved", "rejected", "expired"]);

export const chatThreads = hive
  .table(
    "chat_threads",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      projectId: uuid("project_id"),
      createdBy: text("created_by").notNull(),
      title: text("title").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("chat_threads_id_org").on(t.id, t.orgId),
      index("chat_threads_org_updated").on(t.orgId, t.updatedAt),
      scoped("chat_threads"),
    ],
  )
  .enableRLS();

export const chatMessages = hive
  .table(
    "chat_messages",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      threadId: uuid("thread_id").notNull(),
      role: chatRole("role").notNull(),
      content: text("content").notNull(),
      senderId: text("sender_id"),
      runId: uuid("run_id"),
      // Thẻ artifact trong chat. Khoá ngoại tới artifacts (module khác) nằm trong migration viết tay với `on delete set
      // null (artifact_id)`: set null cả khoá ghép sẽ làm org_id null và vỡ RLS.
      artifactId: uuid("artifact_id"),
      artifactVersion: integer("artifact_version"),
      /** "Nhờ Leader sửa": lỗi chạy của trang, dữ liệu không tin cậy do trang viết. */
      pageErrors: jsonb("page_errors").$type<ArtifactPageError[]>(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      foreignKey({ columns: [t.threadId, t.orgId], foreignColumns: [chatThreads.id, chatThreads.orgId] }).onDelete(
        "cascade",
      ),
      index("chat_messages_thread_created").on(t.threadId, t.createdAt),
      // Xoá hẳn artifact phải tìm các tin nhắn trỏ tới nó để đặt artifact_id = null.
      index("chat_messages_artifact").on(t.artifactId).where(sql`artifact_id is not null`),
      scoped("chat_messages"),
    ],
  )
  .enableRLS();

export const approvals = hive
  .table(
    "approvals",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      threadId: uuid("thread_id").notNull(),
      action: jsonb("action").$type<LeaderAction>().notNull(),
      status: approvalState("status").notNull().default("pending"),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
      decidedBy: text("decided_by"),
      reason: text("reason"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      foreignKey({ columns: [t.threadId, t.orgId], foreignColumns: [chatThreads.id, chatThreads.orgId] }).onDelete(
        "cascade",
      ),
      index("approvals_org_status_expiry").on(t.orgId, t.status, t.expiresAt),
      scoped("approvals"),
    ],
  )
  .enableRLS();

export const delegationKind = hive.enum("leader_delegation_kind", ["task", "run"]);

/**
 * Liên kết giao việc (specs/028): một dòng mỗi lần Leader tạo task hay giao run trong một phiên, để dựng cây phiên →
 * task → run. Không unique vì Leader giao run nhiều lần cho một task. Khoá ngoại tới tasks và runs (module khác) nằm trong
 * migration viết tay; run_id dùng `on delete set null (run_id)` vì set null cả khoá ghép sẽ làm org_id null và vỡ RLS.
 */
export const leaderDelegations = hive
  .table(
    "leader_delegations",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      threadId: uuid("thread_id").notNull(),
      kind: delegationKind("kind").notNull(),
      taskId: uuid("task_id").notNull(),
      runId: uuid("run_id"),
      createdBy: text("created_by").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      foreignKey({ columns: [t.threadId, t.orgId], foreignColumns: [chatThreads.id, chatThreads.orgId] }).onDelete(
        "cascade",
      ),
      index("leader_delegations_thread").on(t.orgId, t.threadId, t.createdAt),
      // tree.links tìm phiên theo task hay run; xoá task, run cũng tìm theo hai cột này.
      index("leader_delegations_task").on(t.orgId, t.taskId),
      index("leader_delegations_run").on(t.orgId, t.runId),
      scoped("leader_delegations"),
    ],
  )
  .enableRLS();
