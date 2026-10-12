import type { AgentPolicyInput, TemplateSyncResult } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import { jsonb, pgPolicy, pgRole, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Khai báo lại schema và role thay vì lấy từ tenancy: module chỉ được import module khác qua index.ts.
const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();
const hiveOwner = pgRole("hive_owner").existing();
const inOrg = sql`org_id = hive.ctx_org()`;

/**
 * Chính sách agent, mỗi tổ chức một dòng. Lưu nguyên object đã kiểm bằng agentPolicyInput thay vì tách cột: chính
 * sách đọc và ghi cả khối, và thêm mục mới không cần migration. Chưa có dòng là dùng DEFAULT_AGENT_POLICY.
 */
export const agentPolicies = hive
  .table(
    "agent_policies",
    {
      orgId: uuid("org_id").primaryKey().default(sql`hive.ctx_org()`),
      policy: jsonb("policy").$type<AgentPolicyInput>().notNull(),
      templateSync: jsonb("template_sync").$type<TemplateSyncResult>(),
      updatedBy: text("updated_by"),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    () => [
      pgPolicy("agent_policies_rw", { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg }),
      // hive.purge_run_logs (SECURITY DEFINER, chạy bằng hive_owner) đọc số ngày giữ log của mọi tổ chức.
      pgPolicy("agent_policies_owner_select", { for: "select", to: hiveOwner, using: sql`true` }),
    ],
  )
  .enableRLS();
