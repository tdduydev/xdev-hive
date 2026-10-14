import { implement } from "@orpc/server";
import {
  type CustomRole,
  PERMISSIONS,
  rolesContract,
  SYSTEM_ROLE_PERMISSIONS,
  type SystemRoleId,
} from "@xdev-hive/contracts";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { authUser } from "../identity/index.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type RequestContext,
  type Tx,
} from "../platform/index.ts";
import { type OrgRole, orgRoleOf, requireOrgRole, type TeamRole, teamRoleOf } from "./permissions.ts";
import { iso, type OrgDeps, onUnique, orgMiddlewares } from "./procedures.ts";
import { customRoles, memberCustomRoles, orgMembers, teamCustomRoles, teamMembers, teams } from "./schema.ts";

const TEAM_SYSTEM_ROLE: Record<TeamRole, SystemRoleId> = {
  admin: "team-admin",
  member: "team-member",
  viewer: "team-viewer",
  ba: "team-ba",
};

/**
 * Quyền từ vai trò tự tạo của người dùng: vai trò gán thẳng cho người (cả tổ chức) và, khi có `teamId`, vai trò gán
 * cho đội đó nếu người dùng ở trong đội. Người không còn là thành viên đang hoạt động thì không có quyền nào.
 */
export async function customPermissions(tx: Tx, userId: string, teamId?: string): Promise<Set<string>> {
  if (!(await orgRoleOf(tx, userId))) return new Set();
  const direct = await tx
    .select({ permissions: customRoles.permissions })
    .from(memberCustomRoles)
    .innerJoin(customRoles, eq(customRoles.id, memberCustomRoles.roleId))
    .where(eq(memberCustomRoles.userId, userId));
  const viaTeam = teamId
    ? await tx
        .select({ permissions: customRoles.permissions })
        .from(teamCustomRoles)
        .innerJoin(customRoles, eq(customRoles.id, teamCustomRoles.roleId))
        .innerJoin(teamMembers, and(eq(teamMembers.teamId, teamCustomRoles.teamId), eq(teamMembers.userId, userId)))
        .where(eq(teamCustomRoles.teamId, teamId))
    : [];
  return new Set([...direct, ...viaTeam].flatMap((r) => r.permissions));
}

/** Quyền hiệu lực: hợp của vai trò tổ chức, vai trò trong đội (khi có `teamId`) và vai trò tự tạo. */
export async function effectivePermissions(tx: Tx, userId: string, teamId?: string): Promise<Set<string>> {
  const org = await orgRoleOf(tx, userId);
  if (!org) return new Set();
  const out = new Set<string>(SYSTEM_ROLE_PERMISSIONS[org]);
  if (teamId) {
    const team = await teamRoleOf(tx, userId, teamId);
    if (team) for (const k of SYSTEM_ROLE_PERMISSIONS[TEAM_SYSTEM_ROLE[team]]) out.add(k);
  }
  for (const k of await customPermissions(tx, userId, teamId)) out.add(k);
  return out;
}

/**
 * Kiểm quyền kiểu cũ trước (vai trò tổ chức/đội, giữ nguyên hành vi đã có), bị từ chối thì xét vai trò tự tạo có
 * quyền `permission` không. Vai trò tự tạo chỉ cộng thêm quyền, không bao giờ bớt.
 */
export async function allowWith<T>(
  tx: Tx,
  userId: string,
  permission: string,
  check: () => Promise<T>,
  teamId?: string,
): Promise<T | undefined> {
  try {
    return await check();
  } catch (error) {
    if (!(error instanceof ForbiddenError) || error.code === "NOT_ORG_MEMBER") throw error;
    if ((await customPermissions(tx, userId, teamId)).has(permission)) return undefined;
    throw error;
  }
}

/** Ai được quản lý vai trò: quản trị tổ chức, hoặc người có vai trò tự tạo chứa roles.write. */
async function requireRolesWrite(tx: Tx, userId: string): Promise<OrgRole | null> {
  return (await allowWith(tx, userId, "roles.write", () => requireOrgRole(tx, userId, "admin"))) ?? null;
}

/**
 * Chặn tự nâng quyền: chỉ chủ sở hữu cấp được quyền mình không có. Quản trị không có policies.fullaccess thì không
 * tạo được vai trò chứa quyền đó, người có roles.write qua vai trò tự tạo chỉ cấp được quyền của chính mình.
 */
async function requireCanGrant(tx: Tx, userId: string, permissions: readonly string[]) {
  if ((await orgRoleOf(tx, userId)) === "owner") return;
  const mine = await effectivePermissions(tx, userId);
  const missing = permissions.filter((k) => !mine.has(k));
  if (missing.length)
    throw new ForbiddenError("PERMISSION_NOT_HELD", `Bạn không thể cấp quyền mình không có: ${missing.join(", ")}.`);
}

const nameTaken = (name: string) => ({
  custom_roles_org_name: new ConflictError("ROLE_NAME_TAKEN", `Tổ chức đã có vai trò "${name}".`),
});

async function getRole(tx: Tx, roleId: string) {
  const [row] = await tx.select().from(customRoles).where(eq(customRoles.id, roleId));
  if (!row) throw new NotFoundError("ROLE_NOT_FOUND", "Không tìm thấy vai trò.");
  return row;
}

async function roleViews(tx: Tx, roleIds?: string[]): Promise<CustomRole[]> {
  const rows = await tx
    .select()
    .from(customRoles)
    .where(roleIds ? inArray(customRoles.id, roleIds) : undefined)
    .orderBy(asc(customRoles.name));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const members = await tx
    .select({ roleId: memberCustomRoles.roleId, userId: authUser.id, name: authUser.name, email: authUser.email })
    .from(memberCustomRoles)
    .innerJoin(authUser, eq(authUser.id, memberCustomRoles.userId))
    .where(inArray(memberCustomRoles.roleId, ids))
    .orderBy(asc(authUser.name));
  const teamRows = await tx
    .select({ roleId: teamCustomRoles.roleId, teamId: teams.id, name: teams.name })
    .from(teamCustomRoles)
    .innerJoin(teams, eq(teams.id, teamCustomRoles.teamId))
    .where(inArray(teamCustomRoles.roleId, ids))
    .orderBy(asc(teams.name));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    scope: r.scope,
    permissions: PERMISSIONS.filter((k) => r.permissions.includes(k)),
    assignments: [
      ...members
        .filter((m) => m.roleId === r.id)
        .map((m) => ({ kind: "member" as const, userId: m.userId, name: m.name, email: m.email })),
      ...teamRows
        .filter((t) => t.roleId === r.id)
        .map((t) => ({ kind: "team" as const, teamId: t.teamId, name: t.name })),
    ],
    updatedAt: iso(r.updatedAt),
  }));
}

async function roleView(tx: Tx, roleId: string): Promise<CustomRole> {
  const [view] = await roleViews(tx, [roleId]);
  if (!view) throw new NotFoundError("ROLE_NOT_FOUND", "Không tìm thấy vai trò.");
  return view;
}

async function systemRoles(tx: Tx) {
  const orgCounts = await tx
    .select({ role: orgMembers.role, n: sql<number>`count(*)::int` })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, sql`hive.ctx_org()`), eq(orgMembers.status, "active")))
    .groupBy(orgMembers.role);
  const teamCounts = await tx
    .select({ role: teamMembers.role, n: sql<number>`count(*)::int` })
    .from(teamMembers)
    .groupBy(teamMembers.role);
  const orgN = (r: OrgRole) => orgCounts.find((c) => c.role === r)?.n ?? 0;
  const teamN = (r: TeamRole) => teamCounts.find((c) => c.role === r)?.n ?? 0;
  const role = (id: SystemRoleId, scope: "org" | "team", memberCount: number) => ({
    id,
    scope,
    permissions: [...SYSTEM_ROLE_PERMISSIONS[id]],
    memberCount,
  });
  return [
    role("owner", "org", orgN("owner")),
    role("admin", "org", orgN("admin")),
    role("member", "org", orgN("member")),
    role("team-admin", "team", teamN("admin")),
    role("team-member", "team", teamN("member")),
    role("team-viewer", "team", teamN("viewer")),
    role("team-ba", "team", teamN("ba")),
  ];
}

const diff = (before: readonly string[], after: readonly string[]) => ({
  added: after.filter((k) => !before.includes(k)),
  removed: before.filter((k) => !after.includes(k)),
});

/** Router vai trò (specs/001-custom-roles), dựng từ middleware chọn tổ chức chung của tenancy. */
export function rolesRouter(deps: OrgDeps) {
  const m = orgMiddlewares(deps);
  const os = implement(rolesContract).$context<RequestContext>().use(m.authed).use(m.inOrg);
  return {
    list: os.list.handler(async ({ context: { tx } }) => ({
      system: await systemRoles(tx),
      custom: await roleViews(tx),
    })),

    mine: os.mine.handler(async ({ context: { tx, user }, input }) => {
      const granted = await effectivePermissions(tx, user.id, input.teamId);
      return { permissions: PERMISSIONS.filter((k) => granted.has(k)) };
    }),

    create: os.create.handler(async ({ context: { tx, user, orgId }, input }) => {
      await requireRolesWrite(tx, user.id);
      const permissions = input.copyOf ? [...SYSTEM_ROLE_PERMISSIONS[input.copyOf]] : input.permissions;
      await requireCanGrant(tx, user.id, permissions);
      const [row] = await onUnique(
        () =>
          tx
            .insert(customRoles)
            .values({
              orgId,
              name: input.name,
              description: input.description || null,
              scope: input.scope,
              permissions,
              createdBy: user.id,
            })
            .returning(),
        nameTaken(input.name),
      );
      if (!row) throw new Error("Không tạo được vai trò.");
      await recordAudit(tx, {
        action: "role.create",
        targetType: "custom_role",
        targetId: row.id,
        data: { name: row.name, scope: row.scope, permissions, copyOf: input.copyOf ?? null },
      });
      return roleView(tx, row.id);
    }),

    update: os.update.handler(async ({ context: { tx, user }, input }) => {
      await requireRolesWrite(tx, user.id);
      const role = await getRole(tx, input.roleId);
      const permissions = input.permissions ?? role.permissions;
      await requireCanGrant(tx, user.id, diff(role.permissions, permissions).added);
      const name = input.name ?? role.name;
      await onUnique(
        () =>
          tx
            .update(customRoles)
            .set({
              name,
              description: input.description === undefined ? role.description : input.description || null,
              permissions,
              updatedAt: new Date(),
            })
            .where(eq(customRoles.id, role.id)),
        nameTaken(name),
      );
      await recordAudit(tx, {
        action: "role.update",
        targetType: "custom_role",
        targetId: role.id,
        data: { name, ...diff(role.permissions, permissions) },
      });
      return roleView(tx, role.id);
    }),

    remove: os.remove.handler(async ({ context: { tx, user }, input }) => {
      await requireRolesWrite(tx, user.id);
      const role = await getRole(tx, input.roleId);
      const view = await roleView(tx, role.id);
      if (view.assignments.length)
        throw new ConflictError(
          "ROLE_IN_USE",
          `Vai trò đang gán cho ${view.assignments.length} người hoặc đội; gỡ hết trước khi xoá.`,
        );
      await tx.delete(customRoles).where(eq(customRoles.id, role.id));
      await recordAudit(tx, {
        action: "role.delete",
        targetType: "custom_role",
        targetId: role.id,
        data: { name: role.name, permissions: role.permissions },
      });
      return { ok: true as const };
    }),

    assign: os.assign.handler(async ({ context: { tx, user, orgId }, input }) => {
      await requireRolesWrite(tx, user.id);
      const role = await getRole(tx, input.roleId);
      // Gán vai trò cũng là cấp quyền: không cho gán vai trò có quyền mà người gán không có.
      await requireCanGrant(tx, user.id, role.permissions);
      if (input.kind === "member") {
        if (role.scope === "team")
          throw new BadRequestError("ROLE_TEAM_SCOPE", "Vai trò phạm vi đội chỉ gán được cho đội.");
        const [member] = await tx
          .select({ userId: orgMembers.userId })
          .from(orgMembers)
          .where(
            and(
              eq(orgMembers.orgId, sql`hive.ctx_org()`),
              eq(orgMembers.userId, input.userId),
              eq(orgMembers.status, "active"),
            ),
          );
        if (!member) throw new NotFoundError("MEMBER_NOT_FOUND", "Người này chưa là thành viên đang hoạt động.");
        await tx
          .insert(memberCustomRoles)
          .values({ roleId: role.id, orgId, userId: input.userId })
          .onConflictDoNothing();
      } else {
        const [team] = await tx.select({ id: teams.id }).from(teams).where(eq(teams.id, input.teamId));
        if (!team) throw new NotFoundError("TEAM_NOT_FOUND", "Không tìm thấy đội.");
        await tx.insert(teamCustomRoles).values({ roleId: role.id, orgId, teamId: input.teamId }).onConflictDoNothing();
      }
      await recordAudit(tx, {
        action: "role.assign",
        targetType: "custom_role",
        targetId: role.id,
        data: input.kind === "member" ? { userId: input.userId } : { teamId: input.teamId },
      });
      return roleView(tx, role.id);
    }),

    unassign: os.unassign.handler(async ({ context: { tx, user }, input }) => {
      await requireRolesWrite(tx, user.id);
      const role = await getRole(tx, input.roleId);
      if (input.kind === "member")
        await tx
          .delete(memberCustomRoles)
          .where(and(eq(memberCustomRoles.roleId, role.id), eq(memberCustomRoles.userId, input.userId)));
      else
        await tx
          .delete(teamCustomRoles)
          .where(and(eq(teamCustomRoles.roleId, role.id), eq(teamCustomRoles.teamId, input.teamId)));
      await recordAudit(tx, {
        action: "role.unassign",
        targetType: "custom_role",
        targetId: role.id,
        data: input.kind === "member" ? { userId: input.userId } : { teamId: input.teamId },
      });
      return roleView(tx, role.id);
    }),
  };
}
