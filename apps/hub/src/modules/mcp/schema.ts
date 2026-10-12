import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgPolicy,
  pgRole,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();
const inOrg = sql`org_id = hive.ctx_org()`;
const scoped = (name: string) => pgPolicy(`${name}_rw`, { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg });
const date = (name: string) => timestamp(name, { withTimezone: true });

export const mcpToolOverrides = hive
  .table(
    "mcp_tool_overrides",
    {
      orgId: uuid("org_id").notNull(),
      toolName: text("tool_name").notNull(),
      enabled: boolean("enabled").notNull().default(true),
      updatedBy: text("updated_by").notNull(),
      updatedAt: date("updated_at").notNull().defaultNow(),
    },
    (t) => [primaryKey({ columns: [t.orgId, t.toolName] }), scoped("mcp_tool_overrides")],
  )
  .enableRLS();

export const mcpUserTokens = hive
  .table(
    "mcp_user_tokens",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      userId: text("user_id").notNull(),
      tokenHash: text("token_hash").notNull(),
      prefix: text("prefix").notNull(),
      clientId: text("client_id").notNull(),
      expiresAt: date("expires_at").notNull(),
      lastUsedAt: date("last_used_at"),
      revokedAt: date("revoked_at"),
      createdAt: date("created_at").notNull().defaultNow(),
    },
    (t) => [
      uniqueIndex("mcp_user_tokens_hash").on(t.tokenHash),
      index("mcp_user_tokens_org_user").on(t.orgId, t.userId),
      check("mcp_user_tokens_initial_expiry", sql`${t.expiresAt} > ${t.createdAt}`),
      scoped("mcp_user_tokens"),
    ],
  )
  .enableRLS();

/**
 * Quy tắc MCP server ngoài (MCP-05). Một dòng vừa là quy tắc cho phép/chặn, vừa (khi có `transport`) là định nghĩa
 * server mà hub phát xuống máy chạy run (MCP-06). `project_id` null là quy tắc của cả tổ chức; không có khoá ngoại tới
 * projects vì module catalog đã phụ thuộc module mcp (đăng ký tool), như egress_allowlists của sandbox.
 */
export const mcpServerRules = hive
  .table(
    "mcp_server_rules",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      projectId: uuid("project_id"),
      name: text("name").notNull(),
      rule: text("rule", { enum: ["allow", "deny"] }).notNull(),
      matchType: text("match_type", { enum: ["name", "url", "command", "wildcard"] }).notNull(),
      pattern: text("pattern").notNull(),
      transport: text("transport", { enum: ["stdio", "http"] }),
      command: text("command"),
      args: jsonb("args").$type<string[]>().notNull().default([]),
      url: text("url"),
      updatedBy: text("updated_by").notNull(),
      createdAt: date("created_at").notNull().defaultNow(),
      updatedAt: date("updated_at").notNull().defaultNow(),
    },
    (t) => [
      check("mcp_server_rules_rule", sql`${t.rule} in ('allow', 'deny')`),
      check("mcp_server_rules_match_type", sql`${t.matchType} in ('name', 'url', 'command', 'wildcard')`),
      check(
        "mcp_server_rules_launch",
        sql`(${t.transport} is null and ${t.command} is null and ${t.url} is null)
          or (${t.transport} = 'stdio' and ${t.command} is not null and ${t.url} is null)
          or (${t.transport} = 'http' and ${t.url} is not null and ${t.command} is null)`,
      ),
      index("mcp_server_rules_org_project").on(t.orgId, t.projectId),
      scoped("mcp_server_rules"),
    ],
  )
  .enableRLS();
