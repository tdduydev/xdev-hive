import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, pgCode, seedOrg } from "../../../test/org-fixture.ts";
import { createPool, withTenant } from "../platform/index.ts";
import { configLayerEntries } from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const tag = randomUUID().slice(0, 8);
let org: OrgFixture;
let other: OrgFixture;

beforeAll(async () => {
  org = await seedOrg(admin, `cfg-rls-${tag}`);
  other = await seedOrg(admin, `cfg-rls-other-${tag}`);
  for (const o of [org, other])
    await withTenant(app, { orgId: o.orgId }, (tx) =>
      tx.insert(configLayerEntries).values({ layer: "team", targetId: o.teamId, key: "limits.perRunUsd", value: 5 }),
    );
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("config_layer_entries RLS", () => {
  it("enables and forces RLS with USING and WITH CHECK", async () => {
    const { rows } = await admin.query(
      `select c.relrowsecurity, c.relforcerowsecurity, p.qual, p.with_check
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         join pg_policies p on p.tablename = c.relname and p.schemaname = n.nspname
        where n.nspname = 'hive' and c.relname = 'config_layer_entries'`,
    );
    expect(rows).toHaveLength(1);
    expect([rows[0].relrowsecurity, rows[0].relforcerowsecurity]).toEqual([true, true]);
    expect(rows[0].qual).toContain("ctx_org()");
    expect(rows[0].with_check).toContain("ctx_org()");
  });

  it("reads no rows without tenant context", async () => {
    await withTenant(app, {}, async (tx) => expect(await tx.select().from(configLayerEntries)).toHaveLength(0));
  });

  it("only reads its own organization", async () => {
    await withTenant(app, { orgId: org.orgId }, async (tx) => {
      const rows = await tx.select().from(configLayerEntries);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.orgId).toBe(org.orgId);
    });
  });

  it("cannot insert foreign rows or touch them", async () => {
    expect(
      await pgCode(() =>
        withTenant(app, { orgId: org.orgId }, (tx) =>
          tx.insert(configLayerEntries).values({
            orgId: other.orgId,
            layer: "team",
            targetId: other.otherTeamId,
            key: "limits.perRunUsd",
            value: 1,
          }),
        ),
      ),
    ).toBe("42501");
    await withTenant(app, { orgId: org.orgId }, (tx) =>
      tx.execute(sql`update hive.config_layer_entries set value = '99'::jsonb where org_id = ${other.orgId}`),
    );
    const { rows } = await admin.query("select value from hive.config_layer_entries where org_id = $1", [other.orgId]);
    expect(rows[0].value).toBe(5);
  });

  it("rejects a layer other than org and team", async () => {
    expect(
      await pgCode(() =>
        withTenant(app, { orgId: org.orgId }, (tx) =>
          tx.execute(
            sql`insert into hive.config_layer_entries (layer, target_id, key) values ('project', ${randomUUID()}::uuid, 'x')`,
          ),
        ),
      ),
    ).toBe("23514");
  });
});
