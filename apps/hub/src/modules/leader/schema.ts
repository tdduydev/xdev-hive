import type { LeaderAction } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
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
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      foreignKey({ columns: [t.threadId, t.orgId], foreignColumns: [chatThreads.id, chatThreads.orgId] }).onDelete(
        "cascade",
      ),
      index("chat_messages_thread_created").on(t.threadId, t.createdAt),
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
