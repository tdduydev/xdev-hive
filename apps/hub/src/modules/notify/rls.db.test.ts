import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pgCode, seedOrg } from "../../../test/org-fixture.ts";
import { createPool, withTenant } from "../platform/index.ts";
import { inboxItems } from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
let org: Awaited<ReturnType<typeof seedOrg>>;
let other: typeof org;
let itemId = "";
beforeAll(async () => {
  org = await seedOrg(admin, `inbox-rls-${randomUUID()}`);
  other = await seedOrg(admin, `inbox-rls-other-${randomUUID()}`);
  itemId = (
    await admin.query(
      "insert into hive.inbox_items (org_id, user_id, event, event_key, title, body) values ($1, $2, 'run.failed', 'rls', 'Run lỗi', '') returning id",
      [org.orgId, org.user("tmember")],
    )
  ).rows[0].id;
});
afterAll(async () => {
  await Promise.all([admin.end(), pool.end()]);
});

describe("inbox RLS", () => {
  it("enables and forces RLS, denies reads without both contexts", async () => {
    const { rows } = await admin.query(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'hive.inbox_items'::regclass",
    );
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    for (const context of [{}, { orgId: org.orgId }, { userId: org.user("tmember") }]) {
      expect(await withTenant(pool, context, (tx) => tx.select().from(inboxItems))).toEqual([]);
    }
  });

  it("owners and other users cannot read or change a recipient's item", async () => {
    for (const context of [
      { orgId: org.orgId, userId: org.user("owner") },
      { orgId: org.orgId, userId: org.user("admin") },
      { orgId: other.orgId, userId: org.user("tmember") },
      { orgId: other.orgId, userId: other.user("owner") },
    ]) {
      await withTenant(pool, context, async (tx) => {
        expect(await tx.select().from(inboxItems).where(eq(inboxItems.id, itemId))).toEqual([]);
        expect(
          await tx.update(inboxItems).set({ readAt: new Date() }).where(eq(inboxItems.id, itemId)).returning(),
        ).toEqual([]);
        expect(await tx.delete(inboxItems).where(eq(inboxItems.id, itemId)).returning()).toEqual([]);
      });
    }
    const rows = await withTenant(pool, { orgId: org.orgId, userId: org.user("tmember") }, (tx) =>
      tx.select().from(inboxItems),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.readAt).toBeNull();
  });

  it("WITH CHECK rejects changes to the organization or recipient", async () => {
    for (const patch of [{ orgId: other.orgId }, { userId: org.user("admin") }]) {
      expect(
        await pgCode(() =>
          withTenant(pool, { orgId: org.orgId, userId: org.user("tmember") }, (tx) =>
            tx.update(inboxItems).set(patch).where(eq(inboxItems.id, itemId)),
          ),
        ),
      ).toBe("42501");
    }
  });

  it("rejects inserts outside the tenant and recipients outside the organization", async () => {
    const values = {
      orgId: org.orgId,
      userId: org.user("tmember"),
      event: "run.failed",
      eventKey: randomUUID(),
      title: "Run lỗi",
      body: "",
    };
    expect(
      await pgCode(() => withTenant(pool, { orgId: other.orgId }, (tx) => tx.insert(inboxItems).values(values))),
    ).toBe("42501");
    expect(
      await pgCode(() =>
        withTenant(pool, { orgId: org.orgId }, (tx) =>
          tx.insert(inboxItems).values({ ...values, userId: other.user("tmember") }),
        ),
      ),
    ).toBe("23503");
  });
});
