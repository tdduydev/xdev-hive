import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedUsers } from "../../../test/seed.ts";
import { createPool, withTenant } from "../platform/index.ts";
import { invitations, orgMembers, orgs, systems, teams } from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);

const orgA = randomUUID();
const orgB = randomUUID();
let teamA = "";
let teamB = "";

beforeAll(async () => {
  // Seed bằng superuser (bỏ qua RLS) để test đứng độc lập với code tạo tổ chức.
  await seedUsers(admin, ["u-a", "u-b", "u-new"]);
  await admin.query(
    "insert into hive.orgs (id, slug, name, created_by) values ($1, 'a', 'A', 'u-a'), ($2, 'b', 'B', 'u-b')",
    [orgA, orgB],
  );
  await admin.query(
    "insert into hive.org_members (org_id, user_id, role) values ($1, 'u-a', 'owner'), ($2, 'u-b', 'owner')",
    [orgA, orgB],
  );
  teamA = (
    await admin.query("insert into hive.teams (org_id, slug, name) values ($1, 'ta', 'TA') returning id", [orgA])
  ).rows[0].id;
  teamB = (
    await admin.query("insert into hive.teams (org_id, slug, name) values ($1, 'tb', 'TB') returning id", [orgB])
  ).rows[0].id;
  await admin.query(
    "insert into hive.systems (org_id, team_id, slug, name) values ($1, $2, 's', 'S'), ($3, $4, 's', 'S')",
    [orgA, teamA, orgB, teamB],
  );
  await admin.query(
    "insert into hive.invitations (org_id, email, token_hash, expires_at, created_by) values ($1, 'x@a.vn', 'hash-a', now() + interval '7 days', 'u-a')",
    [orgA],
  );
});

/** Drizzle bọc lỗi Postgres trong `cause`; so theo mã SQLSTATE cho chắc. */
async function pgCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
}
const RLS_VIOLATION = "42501";
const FK_VIOLATION = "23503";

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("role hive_app", () => {
  it("không phải superuser, không BYPASSRLS, không sở hữu bảng nào", async () => {
    const role = (await admin.query("select rolsuper, rolbypassrls from pg_roles where rolname = 'hive_app'")).rows[0];
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await admin.query("select count(*)::int as n from pg_tables where tableowner = 'hive_app'");
    expect(owned.rows[0].n).toBe(0);
  });

  it("mọi bảng trong schema hive đều bật và ép RLS", async () => {
    const { rows } = await admin.query(`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'hive' and c.relkind = 'r' and c.relname <> 'migrations'`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows)
      expect({ table: r.relname, rls: r.relrowsecurity, force: r.relforcerowsecurity }).toEqual({
        table: r.relname,
        rls: true,
        force: true,
      });
  });

  it("không đọc được bảng migrations", async () => {
    await expect(app.query("select * from hive.migrations")).rejects.toThrow(/permission denied/);
  });
});

describe("RLS theo tổ chức", () => {
  it("không có context thì mọi bảng trả 0 dòng", async () => {
    await withTenant(app, {}, async (tx) => {
      for (const t of [orgs, orgMembers, teams, systems, invitations])
        expect(await tx.select().from(t)).toHaveLength(0);
    });
  });

  it("context tổ chức A chỉ thấy dữ liệu của A", async () => {
    await withTenant(app, { userId: "u-a", orgId: orgA }, async (tx) => {
      expect((await tx.select().from(teams)).map((t) => t.id)).toEqual([teamA]);
      expect((await tx.select().from(systems)).every((s) => s.orgId === orgA)).toBe(true);
      expect((await tx.select().from(orgs)).map((o) => o.id)).toEqual([orgA]);
    });
  });

  it("không ghi được dòng của tổ chức khác", async () => {
    const code = await pgCode(() =>
      withTenant(app, { userId: "u-a", orgId: orgA }, (tx) =>
        tx.insert(teams).values({ orgId: orgB, slug: "x", name: "X" }),
      ),
    );
    expect(code).toBe(RLS_VIOLATION);
  });

  it("UPDATE không chuyển được dòng sang tổ chức khác", async () => {
    const code = await pgCode(() =>
      withTenant(app, { userId: "u-a", orgId: orgA }, (tx) =>
        tx.update(teams).set({ orgId: orgB }).where(eq(teams.id, teamA)),
      ),
    );
    expect(code).toBe(RLS_VIOLATION);
  });

  it("không sửa hay xoá được dòng của tổ chức khác (0 dòng bị ảnh hưởng)", async () => {
    await withTenant(app, { userId: "u-a", orgId: orgA }, async (tx) => {
      expect(await tx.update(teams).set({ name: "bị sửa" }).where(eq(teams.id, teamB)).returning()).toHaveLength(0);
      expect(await tx.delete(teams).where(eq(teams.id, teamB)).returning()).toHaveLength(0);
    });
    const { rows } = await admin.query("select name from hive.teams where id = $1", [teamB]);
    expect(rows[0].name).toBe("TB");
  });

  it("hệ thống không trỏ được tới đội của tổ chức khác (khoá kép)", async () => {
    const code = await pgCode(() =>
      withTenant(app, { userId: "u-a", orgId: orgA }, (tx) =>
        tx.insert(systems).values({ orgId: orgA, teamId: teamB, slug: "y", name: "Y" }),
      ),
    );
    expect(code).toBe(FK_VIOLATION);
  });
});

describe("luồng không có tổ chức trong context", () => {
  it("người dùng chỉ thấy tổ chức mình là thành viên", async () => {
    const seen = await withTenant(app, { userId: "u-b" }, (tx) => tx.select().from(orgs));
    expect(seen.map((o) => o.id)).toEqual([orgB]);
  });

  it("tạo tổ chức mới: đặt id làm context rồi mới ghi", async () => {
    const id = randomUUID();
    await withTenant(app, { userId: "u-new", orgId: id }, async (tx) => {
      await tx.insert(orgs).values({ id, slug: `new-${id.slice(0, 8)}`, name: "Mới", createdBy: "u-new" });
      await tx.insert(orgMembers).values({ orgId: id, userId: "u-new", role: "owner" });
    });
    const mine = await withTenant(app, { userId: "u-new" }, (tx) => tx.select().from(orgs));
    expect(mine.map((o) => o.id)).toEqual([id]);
  });

  it("tìm lời mời theo mã băm, sai mã thì không thấy gì", async () => {
    const found = await withTenant(app, { userId: "u-x", inviteTokenHash: "hash-a" }, (tx) =>
      tx.select().from(invitations),
    );
    expect(found).toHaveLength(1);
    const wrong = await withTenant(app, { userId: "u-x", inviteTokenHash: "hash-sai" }, (tx) =>
      tx.select().from(invitations),
    );
    expect(wrong).toHaveLength(0);
  });

  it("context không rò sang lần mượn kết nối sau", async () => {
    await withTenant(app, { userId: "u-a", orgId: orgA }, async () => {});
    const client = await app.connect();
    try {
      const { rows } = await client.query("select hive.ctx_org() as org, hive.ctx_user() as u");
      expect(rows[0]).toEqual({ org: null, u: null });
    } finally {
      client.release();
    }
  });
});

describe("liên kết với người dùng", () => {
  it("thành viên tổ chức và đội phải là người dùng có thật", async () => {
    const code = await pgCode(() =>
      withTenant(app, { userId: "u-a", orgId: orgA }, (tx) =>
        tx.insert(orgMembers).values({ orgId: orgA, userId: "khong-ton-tai", role: "member" }),
      ),
    );
    expect(code).toBe(FK_VIOLATION);
  });

  it("hive.any_org() chỉ trả một bit, hive_app vẫn không đọc được tổ chức khác", async () => {
    const r = await withTenant(app, { userId: "u-zzz" }, async (tx) => ({
      any: (await tx.execute(sql`select hive.any_org() as any`)).rows[0],
      seen: await tx.select().from(orgs),
    }));
    expect(r).toEqual({ any: { any: true }, seen: [] });
  });

  it("hive.invite_pending() chỉ trả một bit theo email, hive_app vẫn không đọc được lời mời", async () => {
    const pending = (email: string) => sql`select hive.invite_pending(${email}) as p`;
    const r = await withTenant(app, { userId: "u-zzz" }, async (tx) => ({
      invited: (await tx.execute(pending("X@A.vn"))).rows[0],
      other: (await tx.execute(pending("khong-moi@a.vn"))).rows[0],
      seen: await tx.select().from(invitations),
    }));
    expect(r).toEqual({ invited: { p: true }, other: { p: false }, seen: [] });
  });
});

describe("migration", () => {
  it("hàm context trả NULL khi giá trị rỗng", async () => {
    const r = await withTenant(app, { orgId: "" }, (tx) => tx.execute(sql`select hive.ctx_org() as o`));
    expect(r.rows[0]).toEqual({ o: null });
  });
});
