import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
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
