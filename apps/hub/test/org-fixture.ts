import { randomUUID } from "node:crypto";
import type pg from "pg";

export interface OrgFixture {
  orgId: string;
  teamId: string;
  otherTeamId: string;
  systemId: string;
  otherSystemId: string;
}

/**
 * Seed bằng superuser (bỏ qua RLS) một tổ chức có hai đội, mỗi đội một hệ thống, và người dùng với các vai trò:
 * `owner`, `admin` (tổ chức); `tadmin`, `tmember`, `tviewer` (đội chính); `oadmin` (quản trị đội kia).
 * Id người dùng có hậu tố riêng của file test, vì các file chạy song song trên cùng database.
 */
export async function seedOrg(admin: pg.Pool, suffix: string): Promise<OrgFixture & { user: (n: string) => string }> {
  const user = (n: string) => `${n}-${suffix}`;
  const names = ["owner", "admin", "tadmin", "tmember", "tviewer", "oadmin", "loner"];
  // Người dùng cũng có trong auth."user", phòng khi org_members có khoá ngoại tới bảng này.
  await admin.query(
    `insert into auth."user" (id, name, email) select id, id, id || '@seed.test' from unnest($1::text[]) as id
     on conflict (id) do nothing`,
    [names.map(user)],
  );
  const orgId = randomUUID();
  await admin.query("insert into hive.orgs (id, slug, name, created_by) values ($1, $2, $2, $3)", [
    orgId,
    `org-${suffix}-${orgId.slice(0, 6)}`,
    user("owner"),
  ]);
  const roles: Record<string, string> = { owner: "owner", admin: "admin" };
  for (const n of names) {
    await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, $3)", [
      orgId,
      user(n),
      roles[n] ?? "member",
    ]);
  }
  const team = async (slug: string) =>
    (await admin.query("insert into hive.teams (org_id, slug, name) values ($1, $2, $2) returning id", [orgId, slug]))
      .rows[0].id as string;
  const teamId = await team("thanh-toan");
  const otherTeamId = await team("crm");
  const system = async (t: string, slug: string, name: string) =>
    (
      await admin.query("insert into hive.systems (org_id, team_id, slug, name) values ($1, $2, $3, $4) returning id", [
        orgId,
        t,
        slug,
        name,
      ])
    ).rows[0].id as string;
  const systemId = await system(teamId, "hoa-don", "Hoá đơn");
  const otherSystemId = await system(otherTeamId, "khach-hang", "Khách hàng");
  for (const [t, n, role] of [
    [teamId, "tadmin", "admin"],
    [teamId, "tmember", "member"],
    [teamId, "tviewer", "viewer"],
    [otherTeamId, "oadmin", "admin"],
  ] as const) {
    await admin.query("insert into hive.team_members (team_id, org_id, user_id, role) values ($1, $2, $3, $4)", [
      t,
      orgId,
      user(n),
      role,
    ]);
  }
  return { orgId, teamId, otherTeamId, systemId, otherSystemId, user };
}

/** Drizzle bọc lỗi Postgres trong `cause`; so theo mã SQLSTATE cho chắc. */
export async function pgCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
}

/** Bắt lỗi nghiệp vụ có `code` (ForbiddenError, NotFoundError, ConflictError) để so mã. */
export async function errorCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z_]+$/.test(code)) return code;
    throw error;
  }
}
