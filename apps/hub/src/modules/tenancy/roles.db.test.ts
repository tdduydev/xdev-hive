import { randomUUID } from "node:crypto";
import { call } from "@orpc/server";
import { SYSTEM_ROLE_PERMISSIONS } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedUsers } from "../../../test/seed.ts";
import type { Auth } from "../identity/index.ts";
import { createPool, withTenant } from "../platform/index.ts";
import { allowWith, customPermissions, effectivePermissions, requireOrgRole, rolesRouter } from "./index.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);

const u = (name: string) => `roles-${name}-${randomUUID().slice(0, 8)}`;
const owner = u("owner");
const orgAdmin = u("admin");
const member = u("member");
const viewer = u("viewer");
const blocked = u("blocked");
const onlyB = u("only-b");
const orgA = randomUUID();
const orgB = randomUUID();
let teamA = "";
let teamA2 = "";

const router = (userId: string) =>
  rolesRouter({
    pool: app,
    auth: {
      api: { getSession: async () => ({ user: { id: userId, name: userId, email: `${userId}@seed.test` } }) },
    } as unknown as Auth,
  });
const ctx = (org = orgA) => ({ context: { headers: new Headers({ "x-hive-org": org }) } });
const inA = <T>(userId: string, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { userId, orgId: orgA }, fn);

async function errorCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    // Lỗi nghiệp vụ của hub (Forbidden, Conflict, NotFound, BadRequest) đều có `code`; lỗi khác phải nổi lên.
    const code = (error as { code?: unknown }).code;
    if (
      typeof code === "string" &&
      error instanceof Error &&
      error.name.endsWith("Error") &&
      code === code.toUpperCase()
    )
      return code;
    throw error;
  }
}

beforeAll(async () => {
  await seedUsers(admin, [owner, orgAdmin, member, viewer, blocked, onlyB]);
  await admin.query(
    "insert into hive.orgs (id, slug, name, created_by) values ($1::uuid, $1::text, 'A', $3), ($2::uuid, $2::text, 'B', $4)",
    [orgA, orgB, owner, onlyB],
  );
  await admin.query(
    `insert into hive.org_members (org_id, user_id, role, status) values
       ($1, $3, 'owner', 'active'), ($1, $4, 'admin', 'active'), ($1, $5, 'member', 'active'),
       ($1, $6, 'member', 'active'), ($1, $7, 'member', 'blocked'), ($2, $8, 'owner', 'active')`,
    [orgA, orgB, owner, orgAdmin, member, viewer, blocked, onlyB],
  );
  const team = async (s: string) =>
    (await admin.query("insert into hive.teams (org_id, slug, name) values ($1, $2, $2) returning id", [orgA, s]))
      .rows[0].id as string;
  teamA = await team(`ta-${randomUUID().slice(0, 6)}`);
  teamA2 = await team(`tb-${randomUUID().slice(0, 6)}`);
  await admin.query(
    `insert into hive.team_members (team_id, org_id, user_id, role) values
       ($1, $3, $4, 'viewer'), ($1, $3, $5, 'member'), ($2, $3, $5, 'member'), ($1, $3, $6, 'member')`,
    [teamA, teamA2, orgA, viewer, member, blocked],
  );
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("tạo, sửa, xoá vai trò", () => {
  it("quản trị tạo vai trò; trùng tên báo xung đột; thành viên không tạo được", async () => {
    const role = await call(
      router(orgAdmin).create,
      { name: "Kiểm toán", scope: "org", permissions: ["audit.read", "costs.read"] },
      ctx(),
    );
    expect(role).toMatchObject({ name: "Kiểm toán", scope: "org", permissions: ["costs.read", "audit.read"] });
    expect(
      await errorCode(() => call(router(orgAdmin).create, { name: "Kiểm toán", scope: "org", permissions: [] }, ctx())),
    ).toBe("ROLE_NAME_TAKEN");
    expect(
      await errorCode(() => call(router(member).create, { name: "X", scope: "org", permissions: [] }, ctx())),
    ).toBe("ORG_ROLE_REQUIRED");
    const audit = await admin.query(
      "select action, data from hive.audit_log where org_id = $1 and target_id = $2 order by created_at",
      [orgA, role.id],
    );
    expect(audit.rows[0]).toMatchObject({ action: "role.create", data: { name: "Kiểm toán" } });
  });

  it("chặn tự nâng quyền: quản trị không cấp được quyền mình không có, chủ sở hữu thì được", async () => {
    expect(
      await errorCode(() =>
        call(router(orgAdmin).create, { name: "Full", scope: "org", permissions: ["policies.fullaccess"] }, ctx()),
      ),
    ).toBe("PERMISSION_NOT_HELD");
    const full = await call(
      router(owner).create,
      { name: `Full ${randomUUID().slice(0, 4)}`, scope: "org", permissions: ["policies.fullaccess"] },
      ctx(),
    );
    expect(full.permissions).toEqual(["policies.fullaccess"]);
  });

  it("nhân bản vai trò hệ thống lấy đúng bộ quyền", async () => {
    const copy = await call(
      router(orgAdmin).create,
      { name: `Xem ${randomUUID().slice(0, 4)}`, scope: "team", permissions: ["roles.write"], copyOf: "team-viewer" },
      ctx(),
    );
    expect(copy.permissions).toEqual([...SYSTEM_ROLE_PERMISSIONS["team-viewer"]]);
  });

  it("sửa quyền ghi nhật ký phần thêm và bớt", async () => {
    const role = await call(
      router(orgAdmin).create,
      { name: `Sửa ${randomUUID().slice(0, 4)}`, scope: "org", permissions: ["tasks.read"] },
      ctx(),
    );
    const updated = await call(
      router(orgAdmin).update,
      { roleId: role.id, permissions: ["tasks.read", "runs.read"], description: "Đọc" },
      ctx(),
    );
    expect(updated).toMatchObject({ permissions: ["tasks.read", "runs.read"], description: "Đọc" });
    const audit = await admin.query("select data from hive.audit_log where target_id = $1 and action = 'role.update'", [
      role.id,
    ]);
    expect(audit.rows[0].data).toMatchObject({ added: ["runs.read"], removed: [] });
  });
});

describe("gán vai trò và quyền hiệu lực", () => {
  it("vai trò gán cho người có hiệu lực cả tổ chức và thay được kiểm quyền quản trị", async () => {
    const role = await call(
      router(orgAdmin).create,
      { name: `Auditor ${randomUUID().slice(0, 4)}`, scope: "org", permissions: ["audit.read"] },
      ctx(),
    );
    const check = (userId: string) =>
      inA(userId, (tx) => allowWith(tx, userId, "audit.read", () => requireOrgRole(tx, userId, "admin")));
    expect(await errorCode(() => check(member))).toBe("ORG_ROLE_REQUIRED");
    const view = await call(router(orgAdmin).assign, { roleId: role.id, kind: "member", userId: member }, ctx());
    expect(view.assignments).toEqual([expect.objectContaining({ kind: "member", userId: member })]);
    expect(await errorCode(() => check(member))).toBeUndefined();
    // Quyền khác vẫn bị chặn: vai trò tự tạo chỉ cộng đúng quyền của nó.
    expect(
      await errorCode(() =>
        inA(member, (tx) => allowWith(tx, member, "audit.export", () => requireOrgRole(tx, member, "admin"))),
      ),
    ).toBe("ORG_ROLE_REQUIRED");
    const mine = await call(router(member).mine, {}, ctx());
    expect(mine.permissions).toContain("audit.read");
    expect(mine.permissions).not.toContain("audit.export");
  });

  it("vai trò gán cho đội chỉ có hiệu lực trong đội đó, với người ở trong đội", async () => {
    const role = await call(
      router(orgAdmin).create,
      { name: `Duyệt ${randomUUID().slice(0, 4)}`, scope: "team", permissions: ["plans.decide"] },
      ctx(),
    );
    await call(router(orgAdmin).assign, { roleId: role.id, kind: "team", teamId: teamA }, ctx());
    const perms = (userId: string, teamId?: string) => inA(userId, (tx) => customPermissions(tx, userId, teamId));
    expect((await perms(viewer, teamA)).has("plans.decide")).toBe(true);
    expect((await perms(viewer, teamA2)).has("plans.decide")).toBe(false);
    expect((await perms(viewer)).has("plans.decide")).toBe(false);
    // Thành viên tổ chức không ở đội A không nhận quyền của đội A.
    expect((await perms(orgAdmin, teamA)).has("plans.decide")).toBe(false);
    // Người bị khoá mất hết quyền tự tạo dù còn dòng team_members.
    expect((await perms(blocked, teamA)).size).toBe(0);
    const eff = await inA(viewer, (tx) => effectivePermissions(tx, viewer, teamA));
    expect(eff.has("plans.decide")).toBe(true);
    expect(eff.has("tasks.read")).toBe(true);
  });

  it("vai trò phạm vi đội không gán được cho người", async () => {
    const role = await call(
      router(orgAdmin).create,
      { name: `Đội ${randomUUID().slice(0, 4)}`, scope: "team", permissions: ["tasks.read"] },
      ctx(),
    );
    expect(
      await errorCode(() => call(router(orgAdmin).assign, { roleId: role.id, kind: "member", userId: member }, ctx())),
    ).toBeDefined();
  });

  it("không xoá được vai trò đang gán; gỡ hết rồi thì xoá được", async () => {
    const role = await call(
      router(orgAdmin).create,
      { name: `Xoá ${randomUUID().slice(0, 4)}`, scope: "org", permissions: ["tasks.read"] },
      ctx(),
    );
    await call(router(orgAdmin).assign, { roleId: role.id, kind: "member", userId: viewer }, ctx());
    expect(await errorCode(() => call(router(orgAdmin).remove, { roleId: role.id }, ctx()))).toBe("ROLE_IN_USE");
    await call(router(orgAdmin).unassign, { roleId: role.id, kind: "member", userId: viewer }, ctx());
    expect(await call(router(orgAdmin).remove, { roleId: role.id }, ctx())).toEqual({ ok: true });
  });

  it("người có roles.write qua vai trò tự tạo chỉ cấp được quyền của chính mình", async () => {
    const manager = await call(
      router(owner).create,
      { name: `QLVT ${randomUUID().slice(0, 4)}`, scope: "org", permissions: ["roles.write", "tasks.read"] },
      ctx(),
    );
    await call(router(owner).assign, { roleId: manager.id, kind: "member", userId: viewer }, ctx());
    const ok = await call(
      router(viewer).create,
      { name: `Con ${randomUUID().slice(0, 4)}`, scope: "org", permissions: ["tasks.read"] },
      ctx(),
    );
    expect(ok.permissions).toEqual(["tasks.read"]);
    expect(
      await errorCode(() =>
        call(router(viewer).create, { name: "Leo thang", scope: "org", permissions: ["audit.read"] }, ctx()),
      ),
    ).toBe("PERMISSION_NOT_HELD");
  });
});

describe("danh sách và cô lập tổ chức", () => {
  it("liệt kê vai trò hệ thống kèm số người và vai trò tự tạo kèm người, đội được gán", async () => {
    const list = await call(router(member).list, undefined, ctx());
    const sys = Object.fromEntries(list.system.map((r) => [r.id, r.memberCount]));
    expect(sys).toMatchObject({ owner: 1, admin: 1, member: 2, "team-viewer": 1 });
    expect(list.custom.length).toBeGreaterThan(0);
  });

  it("tổ chức B không thấy và không gán được vai trò của tổ chức A", async () => {
    const roleA = await call(
      router(orgAdmin).create,
      { name: `Riêng ${randomUUID().slice(0, 4)}`, scope: "org", permissions: ["tasks.read"] },
      ctx(),
    );
    const listB = await call(router(onlyB).list, undefined, ctx(orgB));
    expect(listB.custom.some((r) => r.id === roleA.id)).toBe(false);
    expect(
      await errorCode(() => call(router(onlyB).assign, { roleId: roleA.id, kind: "member", userId: onlyB }, ctx(orgB))),
    ).toBeDefined();
    const rows = await withTenant(app, { userId: onlyB, orgId: orgB }, (tx) =>
      tx.execute(`select count(*)::int as n from hive.custom_roles where org_id = '${orgA}'`),
    );
    expect(rows.rows[0]).toEqual({ n: 0 });
  });
});
