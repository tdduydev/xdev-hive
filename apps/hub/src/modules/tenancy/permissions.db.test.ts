import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedUsers } from "../../../test/seed.ts";
import { createPool, ForbiddenError, type Tx, withTenant } from "../platform/index.ts";
import { orgRoleOf, requireOrgRole, requireTeamRole, teamRoleOf, teamRolesOf, visibleTeamIds } from "./index.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);

const orgA = randomUUID();
const orgB = randomUUID();
let teamA = "";
let teamA2 = "";
let teamB = "";

const inA = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, { userId: "caller", orgId: orgA }, fn);

beforeAll(async () => {
  const slug = () => `p-${randomUUID().slice(0, 8)}`;
  await seedUsers(admin, ["owner", "admin", "tadmin", "tmember", "tviewer", "loner", "pending", "blocked", "only-b"]);
  await admin.query(
    "insert into hive.orgs (id, slug, name, created_by) values ($1, $2, 'A', 'owner'), ($3, $4, 'B', 'x')",
    [orgA, slug(), orgB, slug()],
  );
  await admin.query(
    `insert into hive.org_members (org_id, user_id, role, status) values
       ($1, 'owner', 'owner', 'active'), ($1, 'admin', 'admin', 'active'),
       ($1, 'tadmin', 'member', 'active'), ($1, 'tmember', 'member', 'active'),
       ($1, 'tviewer', 'member', 'active'), ($1, 'loner', 'member', 'active'),
       ($1, 'pending', 'admin', 'pending'), ($1, 'blocked', 'owner', 'blocked'),
       ($2, 'only-b', 'owner', 'active'), ($2, 'tmember', 'owner', 'active')`,
    [orgA, orgB],
  );
  const team = async (org: string, s: string) =>
    (await admin.query("insert into hive.teams (org_id, slug, name) values ($1, $2, $2) returning id", [org, s]))
      .rows[0].id as string;
  teamA = await team(orgA, "ta");
  teamA2 = await team(orgA, "ta2");
  teamB = await team(orgB, "tb");
  await admin.query(
    `insert into hive.team_members (team_id, org_id, user_id, role) values
       ($1, $2, 'tadmin', 'admin'), ($1, $2, 'tmember', 'member'), ($1, $2, 'tviewer', 'viewer'),
       ($1, $2, 'pending', 'admin'), ($1, $2, 'blocked', 'admin'), ($3, $4, 'tmember', 'admin')`,
    [teamA, orgA, teamB, orgB],
  );
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

/** Bắt ForbiddenError để so mã; lỗi khác (lỗi SQL) phải nổi lên để test hỏng rõ ràng. */
async function forbiddenCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    if (error instanceof ForbiddenError) return error.code;
    throw error;
  }
}

describe("orgRoleOf", () => {
  it.each([
    ["owner", "owner"],
    ["admin", "admin"],
    ["loner", "member"],
  ] as const)("%s là %s", async (user, role) => {
    expect(await inA((tx) => orgRoleOf(tx, user))).toBe(role);
  });

  it.each(["pending", "blocked", "only-b", "không-có"])("%s không có vai trò", async (user) => {
    expect(await inA((tx) => orgRoleOf(tx, user))).toBeNull();
  });

  it("chỉ lấy vai trò ở tổ chức của context, không lẫn tổ chức khác", async () => {
    // tmember là owner ở B nhưng chỉ là member ở A, và được RLS cho thấy cả hai dòng của mình.
    const role = await withTenant(app, { userId: "tmember", orgId: orgA }, (tx) => orgRoleOf(tx, "tmember"));
    expect(role).toBe("member");
  });

  it("không có tổ chức trong context thì không có vai trò", async () => {
    expect(await withTenant(app, { userId: "owner" }, (tx) => orgRoleOf(tx, "owner"))).toBeNull();
  });
});

describe("requireOrgRole", () => {
  it.each([
    ["owner", "owner"],
    ["owner", "member"],
    ["admin", "admin"],
    ["admin", "member"],
    ["loner", "member"],
  ] as const)("%s đạt mức %s", async (user, min) => {
    await expect(inA((tx) => requireOrgRole(tx, user, min))).resolves.toBeDefined();
  });

  it("trả về vai trò thực", async () => {
    expect(await inA((tx) => requireOrgRole(tx, "owner", "member"))).toBe("owner");
  });

  it.each([
    ["admin", "owner"],
    ["loner", "admin"],
    ["loner", "owner"],
  ] as const)("%s không đạt mức %s", async (user, min) => {
    expect(await forbiddenCode(() => inA((tx) => requireOrgRole(tx, user, min)))).toBe("ORG_ROLE_REQUIRED");
  });

  it.each(["pending", "blocked", "only-b"])("%s không phải thành viên đang hoạt động", async (user) => {
    expect(await forbiddenCode(() => inA((tx) => requireOrgRole(tx, user, "member")))).toBe("NOT_ORG_MEMBER");
  });

  it("lỗi có message tiếng Việt", async () => {
    await expect(inA((tx) => requireOrgRole(tx, "loner", "admin"))).rejects.toThrow(/Cần vai trò quản trị/);
  });
});

describe("teamRoleOf", () => {
  it.each([
    ["owner", "admin"],
    ["admin", "admin"],
    ["tadmin", "admin"],
    ["tmember", "member"],
    ["tviewer", "viewer"],
  ] as const)("%s có vai trò %s ở đội", async (user, role) => {
    expect(await inA((tx) => teamRoleOf(tx, user, teamA))).toBe(role);
  });

  it("owner/admin tổ chức là admin của cả đội không có dòng thành viên", async () => {
    expect(await inA((tx) => teamRoleOf(tx, "owner", teamA2))).toBe("admin");
    expect(await inA((tx) => teamRoleOf(tx, "admin", teamA2))).toBe("admin");
  });

  it.each([
    ["loner", "không thuộc đội"],
    ["tadmin", "admin đội khác"],
  ] as const)("%s (%s) không có vai trò ở đội", async (user, _why) => {
    expect(await inA((tx) => teamRoleOf(tx, user, teamA2))).toBeNull();
  });

  it.each(["pending", "blocked"])("%s ở tổ chức mất quyền ở đội dù còn dòng thành viên", async (user) => {
    expect(await inA((tx) => teamRoleOf(tx, user, teamA))).toBeNull();
  });

  it("đội của tổ chức khác thì không có vai trò, kể cả owner", async () => {
    expect(await inA((tx) => teamRoleOf(tx, "owner", teamB))).toBeNull();
    // tmember là admin đội B nhưng context đang ở A.
    expect(await inA((tx) => teamRoleOf(tx, "tmember", teamB))).toBeNull();
  });

  it("id đội không tồn tại thì không có vai trò, kể cả owner", async () => {
    expect(await inA((tx) => teamRoleOf(tx, "owner", randomUUID()))).toBeNull();
  });
});

describe("teamRolesOf", () => {
  const users = ["owner", "admin", "tadmin", "tmember", "tviewer", "loner", "pending", "blocked", "only-b"];

  it.each(users)("%s: cùng kết quả với teamRoleOf từng đội, một truy vấn cho mọi đội", async (user) => {
    const teams = [teamA, teamA2, teamB, randomUUID()];
    const one = new Map<string, string>();
    for (const t of teams) {
      const role = await inA((tx) => teamRoleOf(tx, user, t));
      if (role) one.set(t, role);
    }
    expect(await inA((tx) => teamRolesOf(tx, user, teams))).toEqual(one);
    // Bỏ trống danh sách là mọi đội của tổ chức trong context; đội B và id lạ không bao giờ có.
    expect(await inA((tx) => teamRolesOf(tx, user))).toEqual(one);
    expect(new Set(await inA((tx) => visibleTeamIds(tx, user)))).toEqual(new Set(one.keys()));
  });

  it("danh sách rỗng thì không hỏi database", async () => {
    expect(await inA((tx) => teamRolesOf(tx, "owner", []))).toEqual(new Map());
  });
});

describe("requireTeamRole", () => {
  it.each([
    ["owner", "admin"],
    ["admin", "admin"],
    ["tadmin", "admin"],
    ["tmember", "member"],
    ["tmember", "viewer"],
    ["tviewer", "viewer"],
  ] as const)("%s đạt mức %s", async (user, min) => {
    await expect(inA((tx) => requireTeamRole(tx, user, teamA, min))).resolves.toBeDefined();
  });

  it("trả về vai trò thực", async () => {
    expect(await inA((tx) => requireTeamRole(tx, "tmember", teamA, "viewer"))).toBe("member");
  });

  it.each([
    ["tmember", "admin"],
    ["tviewer", "member"],
    ["tviewer", "admin"],
  ] as const)("%s không đạt mức %s", async (user, min) => {
    expect(await forbiddenCode(() => inA((tx) => requireTeamRole(tx, user, teamA, min)))).toBe("TEAM_ROLE_REQUIRED");
  });

  // id đội chỉ có sau beforeAll, nên bảng test giữ tên đội rồi tra lúc chạy.
  it.each([
    ["loner", "ta2"],
    ["blocked", "ta"],
    ["owner", "tb"],
  ] as const)("%s không truy cập được đội %s", async (user, team) => {
    const id = { ta: teamA, ta2: teamA2, tb: teamB }[team];
    expect(await forbiddenCode(() => inA((tx) => requireTeamRole(tx, user, id, "viewer")))).toBe("NOT_TEAM_MEMBER");
  });
});
