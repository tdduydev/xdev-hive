import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, pgCode, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { egressAllowlists, envImages, sandboxOrgSettings } from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const tag = randomUUID().slice(0, 8);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
let org: OrgFixture;
let other: OrgFixture;
let projectId: string;
let foreignId: string;
let unconfiguredForeignId: string;
const tables = [egressAllowlists, envImages, sandboxOrgSettings];
const tenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, { orgId: org.orgId }, fn);
const image = { baseImage: "node:24", setupScriptHash: "a".repeat(64), updatedBy: "test" };

beforeAll(async () => {
  const first = await seedOrg(admin, `sb-rls-${tag}`);
  const second = await seedOrg(admin, `sb-rls-other-${tag}`);
  org = first;
  other = second;
  const seed = async (o: typeof first, key: string) =>
    (
      await seedProject(admin, app, {
        orgId: o.orgId,
        teamId: o.teamId,
        systemId: o.systemId,
        adminUserId: o.user("owner"),
        masterKey,
        key,
      })
    ).projectId;
  projectId = await seed(first, `sb-rls-${tag}`);
  foreignId = await seed(second, `sb-rls-other-${tag}`);
  unconfiguredForeignId = await seed(second, `sb-rls-unused-${tag}`);
  for (const [o, project] of [
    [org, projectId],
    [other, foreignId],
  ] as const) {
    await withTenant(app, { orgId: o.orgId }, async (tx) => {
      await tx.insert(sandboxOrgSettings).values({ orgId: o.orgId });
      await tx
        .insert(egressAllowlists)
        .values({ orgId: o.orgId, teamId: o.teamId, projectId: project, rule: "api.internal:443", addedBy: "test" });
      await tx.insert(envImages).values({ orgId: o.orgId, teamId: o.teamId, projectId: project, ...image });
    });
  }
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("sandbox RLS", () => {
  it("enables and forces RLS with USING and WITH CHECK on every new table", async () => {
    const { rows } = await admin.query(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity, p.qual, p.with_check
      from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_policies p on p.tablename = c.relname and p.schemaname = n.nspname
      where n.nspname = 'hive' and c.relname = any($1)`,
      [["egress_allowlists", "env_images", "sandbox_org_settings"]],
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect([r.relrowsecurity, r.relforcerowsecurity]).toEqual([true, true]);
      expect(r.qual).toContain("ctx_org()");
      expect(r.with_check).toContain("ctx_org()");
    }
  });
  it("reads no rows without tenant context", async () => {
    await withTenant(app, {}, async (tx) => {
      for (const table of tables) expect(await tx.select().from(table)).toHaveLength(0);
    });
  });
  it("only reads own organization", async () => {
    await tenant(async (tx) => {
      for (const table of tables) {
        const rows = await tx.select().from(table);
        expect(rows).toHaveLength(1);
        expect(rows.every((r) => r.orgId === org.orgId)).toBe(true);
      }
    });
  });
  it("cannot insert foreign rows", async () => {
    expect(
      await pgCode(() =>
        tenant((tx) =>
          tx.insert(egressAllowlists).values({ orgId: other.orgId, rule: "foreign.internal", addedBy: "test" }),
        ),
      ),
    ).toBe("42501");
    expect(await pgCode(() => tenant((tx) => tx.insert(sandboxOrgSettings).values({ orgId: other.orgId })))).toBe(
      "42501",
    );
    expect(
      await pgCode(() =>
        tenant((tx) =>
          tx.insert(envImages).values({ orgId: other.orgId, teamId: other.teamId, projectId: foreignId, ...image }),
        ),
      ),
    ).toBe("42501");
  });
  it("cannot move rows to a foreign tenant", async () => {
    for (const table of tables) {
      expect(
        await pgCode(() =>
          tenant((tx) => tx.update(table).set({ orgId: other.orgId }).where(eq(table.orgId, org.orgId))),
        ),
      ).toBe("42501");
    }
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
  it("rejects project links across organizations or teams", async () => {
    for (const [project, team] of [
      [unconfiguredForeignId, org.teamId],
      [projectId, org.otherTeamId],
    ]) {
      expect(
        await pgCode(() =>
          tenant((tx) =>
            tx
              .insert(egressAllowlists)
              .values({ orgId: org.orgId, projectId: project, teamId: team, rule: "api.internal", addedBy: "test" }),
          ),
        ),
      ).toBe("23503");
      expect(
        await pgCode(() =>
          tenant((tx) =>
            tx.execute(
              sql`insert into hive.env_images (org_id, team_id, project_id, base_image, setup_script_hash, updated_by) values (${org.orgId}, ${team}, ${project}, 'node:24', ${image.setupScriptHash}, 'test') on conflict (project_id) do update set team_id = excluded.team_id`,
            ),
          ),
        ),
      ).toBe("23503");
    }
  });
  it("requires team and project scope together", async () => {
    expect(
      await pgCode(() =>
        tenant((tx) =>
          tx.insert(egressAllowlists).values({ orgId: org.orgId, projectId, rule: "api.internal", addedBy: "test" }),
        ),
      ),
    ).toBe("23514");
  });
});
