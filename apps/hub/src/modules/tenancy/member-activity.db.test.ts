import { randomUUID } from "node:crypto";
import { call } from "@orpc/server";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, expect, inject, it } from "vitest";
import { seedUsers } from "../../../test/seed.ts";
import type { Auth } from "../identity/index.ts";
import { createPool, withTenant } from "../platform/index.ts";
import { tenancyRouter } from "./router.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const orgA = randomUUID();
const orgB = randomUUID();
const signedIn = `activity-${randomUUID()}`;
const neverSignedIn = `activity-${randomUUID()}`;
const onlyB = `activity-${randomUUID()}`;
const old = "2026-10-01T03:00:00.000Z";
const latest = "2026-10-12T03:00:00.000Z";

beforeAll(async () => {
  await seedUsers(admin, [signedIn, neverSignedIn, onlyB]);
  await admin.query(
    "insert into hive.orgs (id, slug, name, created_by) values ($1::uuid, $1::text, 'A', $3), ($2::uuid, $2::text, 'B', $4)",
    [orgA, orgB, signedIn, onlyB],
  );
  await admin.query(
    "insert into hive.org_members (org_id, user_id, role) values ($1, $3, 'owner'), ($1, $4, 'member'), ($2, $5, 'owner'), ($2, $3, 'member')",
    [orgA, orgB, signedIn, neverSignedIn, onlyB],
  );
  for (const [user, provider] of [
    [signedIn, "credential"],
    [signedIn, "github"],
    [signedIn, "github"],
    [onlyB, "google"],
  ]) {
    await admin.query(
      'insert into auth.account (id, "accountId", "providerId", "userId", "accessToken") values ($1, $1, $2, $3, $4)',
      [randomUUID(), provider, user, "test-access-token"],
    );
  }
  for (const [user, created, updated] of [
    [signedIn, old, latest],
    [signedIn, old, old],
    [onlyB, latest, latest],
  ]) {
    await admin.query(
      'insert into auth.session (id, token, "userId", "expiresAt", "createdAt", "updatedAt", "ipAddress", "userAgent") values ($1, $1, $2, now(), $3, $4, $5, $6)',
      [randomUUID(), user, created, updated, "192.0.2.1", "test-agent"],
    );
  }
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

it("returns only safe activity fields for current organization members", async () => {
  const result = await withTenant(app, { userId: signedIn, orgId: orgA }, (tx) =>
    tx.execute(sql`select * from hive.org_member_activity() order by user_id`),
  );
  expect(result.rows).toHaveLength(2);
  const row = result.rows.find((r) => r.user_id === signedIn);
  // pg trả timestamptz dạng chuỗi ở pool của app; so theo thời điểm, không theo định dạng.
  expect({ ...row, last_seen_at: new Date(String(row?.last_seen_at)).toISOString() }).toEqual({
    user_id: signedIn,
    last_seen_at: latest,
    providers: ["credential", "github"],
  });
  expect(result.rows.find((row) => row.user_id === neverSignedIn)).toEqual({
    user_id: neverSignedIn,
    last_seen_at: null,
    providers: [],
  });
  expect(result.rows.some((row) => row.user_id === onlyB)).toBe(false);
});

it("returns no rows without an organization context even for a member of two organizations", async () => {
  const result = await withTenant(app, { userId: signedIn }, (tx) =>
    tx.execute(sql`select * from hive.org_member_activity()`),
  );
  expect(result.rows).toEqual([]);
});

it("keeps auth table access denied and exposes the function only through explicit grants", async () => {
  const result = await app.query(`select
    has_table_privilege(current_user, 'auth.account', 'SELECT') as accounts,
    has_table_privilege(current_user, 'auth.session', 'SELECT') as sessions,
    has_function_privilege(current_user, 'hive.org_member_activity()', 'EXECUTE') as executable`);
  expect(result.rows[0]).toEqual({ accounts: false, sessions: false, executable: true });
  const metadata = await admin.query(`select p.prosecdef, p.proconfig,
    exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute
    from pg_proc p where p.oid = 'hive.org_member_activity()'::regprocedure`);
  expect(metadata.rows[0]).toEqual({ prosecdef: true, proconfig: ['search_path=""'], public_execute: false });
});

it("lists activity through the existing tenant middleware and rejects another organization's caller", async () => {
  const routerFor = (userId: string) =>
    tenancyRouter({
      pool: app,
      auth: {
        api: { getSession: async () => ({ user: { id: userId, name: userId, email: `${userId}@seed.test` } }) },
      } as unknown as Auth,
    });
  const context = { headers: new Headers({ "x-hive-org": orgA }) };
  const members = await call(routerFor(signedIn).orgMembers.list, undefined, { context });
  expect(members).toHaveLength(2);
  expect(members.find((member) => member.userId === signedIn)).toMatchObject({
    providers: ["credential", "github"],
    lastSeenAt: latest,
  });
  expect(members.find((member) => member.userId === neverSignedIn)).toMatchObject({ providers: [], lastSeenAt: null });
  expect(
    members.every(
      (member) =>
        Object.keys(member).sort().join(",") ===
        "email,image,joinedAt,lastSeenAt,name,providers,role,status,teams,userId",
    ),
  ).toBe(true);
  await expect(call(routerFor(onlyB).orgMembers.list, undefined, { context })).rejects.toThrow(
    "Bạn không phải thành viên của tổ chức này.",
  );
});
