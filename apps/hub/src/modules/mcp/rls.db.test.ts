import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pgCode, seedOrg } from "../../../test/org-fixture.ts";
import { createPool, type Tx, withTenant } from "../platform/index.ts";
import { mcpServerRules, mcpToolOverrides, mcpUserTokens } from "./schema.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);
const owner = createPool(db.ownerUrl);
let org: Awaited<ReturnType<typeof seedOrg>>;
let other: typeof org;
const tables = [mcpToolOverrides, mcpUserTokens, mcpServerRules];
const tenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, { orgId: org.orgId, userId: org.user("owner") }, fn);
const token = (orgId: string) => ({
  orgId,
  userId: "test",
  tokenHash: randomUUID(),
  prefix: "test-prefix",
  clientId: "test",
  expiresAt: new Date(Date.now() + 86_400_000),
});

const serverRule = (orgId: string) => ({
  orgId,
  name: "Shell",
  rule: "deny" as const,
  matchType: "name" as const,
  pattern: "shell",
  updatedBy: "test",
});

beforeAll(async () => {
  const tag = randomUUID().slice(0, 8);
  org = await seedOrg(admin, `mcp-rls-${tag}`);
  other = await seedOrg(admin, `mcp-rls-other-${tag}`);
  for (const o of [org, other])
    await withTenant(app, { orgId: o.orgId }, async (tx) => {
      await tx
        .insert(mcpToolOverrides)
        .values({ orgId: o.orgId, toolName: "task_get", enabled: false, updatedBy: "test" });
      await tx.insert(mcpUserTokens).values(token(o.orgId));
      await tx.insert(mcpServerRules).values(serverRule(o.orgId));
    });
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end(), owner.end()]);
});

describe("MCP RLS", () => {
  it("enables and forces RLS, with USING and WITH CHECK, and hive_app has no bypass", async () => {
    const { rows } = await admin.query(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity, p.qual, p.with_check
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      join pg_policies p on p.tablename = c.relname and p.schemaname = n.nspname
      where n.nspname = 'hive' and c.relname = any($1)`,
      [["mcp_tool_overrides", "mcp_user_tokens", "mcp_server_rules"]],
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect([row.relrowsecurity, row.relforcerowsecurity]).toEqual([true, true]);
      expect(row.qual).toContain("ctx_org()");
      expect(row.with_check).toContain("ctx_org()");
    }
    const role = await tenant((tx) =>
      tx.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
        sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
      ),
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
  it("returns no rows without context, even for the table owner", async () => {
    for (const pool of [app, owner])
      await withTenant(pool, {}, async (tx) => {
        for (const table of tables) expect(await tx.select().from(table)).toHaveLength(0);
      });
  });
  it("sees only the selected tenant and context never leaks across pool reuse", async () => {
    await tenant(async (tx) => {
      for (const table of tables) {
        const rows = await tx.select().from(table);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.orgId).toBe(org.orgId);
      }
    });
    await withTenant(app, {}, async (tx) => {
      for (const table of tables) expect(await tx.select().from(table)).toHaveLength(0);
    });
  });
  it("rejects inserting a foreign tenant and moving own rows to a foreign tenant", async () => {
    expect(await pgCode(() => tenant((tx) => tx.insert(mcpUserTokens).values(token(other.orgId))))).toBe("42501");
    expect(await pgCode(() => tenant((tx) => tx.insert(mcpServerRules).values(serverRule(other.orgId))))).toBe("42501");
    expect(
      await pgCode(() =>
        tenant((tx) =>
          tx.insert(mcpToolOverrides).values({ orgId: other.orgId, toolName: "foreign_tool", updatedBy: "test" }),
        ),
      ),
    ).toBe("42501");
    for (const table of tables)
      expect(
        await pgCode(() =>
          tenant((tx) => tx.update(table).set({ orgId: other.orgId }).where(eq(table.orgId, org.orgId))),
        ),
      ).toBe("42501");
  });
  it("cannot update or delete foreign rows", async () => {
    await tenant(async (tx) => {
      for (const table of tables) {
        expect(
          await tx.update(table).set({ orgId: other.orgId }).where(eq(table.orgId, other.orgId)).returning(),
        ).toHaveLength(0);
        expect(await tx.delete(table).where(eq(table.orgId, other.orgId)).returning()).toHaveLength(0);
      }
    });
  });
});
