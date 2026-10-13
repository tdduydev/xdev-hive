import { and, asc, eq, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { authUser } from "../identity/index.ts";
import { ConflictError, NotFoundError, type Tx } from "../platform/index.ts";
import { requireOrgRole, requireTeamRole, storableTeamRole } from "./permissions.ts";
import { iso, onUnique, type Procedures, slugTaken } from "./procedures.ts";
import { allowWith } from "./roles.ts";
import { orgMembers, teamMembers, teams } from "./schema.ts";

const toTeam = (t: typeof teams.$inferSelect) => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  color: t.color,
  createdAt: iso(t.createdAt),
});

/** Tìm đội trước khi xét quyền, để id đội sai trả NOT_FOUND thay vì "không có quyền". RLS lọc đội tổ chức khác. */
export async function getTeam(tx: Tx, teamId: string) {
  const [row] = await tx.select().from(teams).where(eq(teams.id, teamId));
  if (!row) throw new NotFoundError("TEAM_NOT_FOUND", "Không tìm thấy đội.");
  return row;
}

/** Chỉ thêm vào đội người đang là thành viên hoạt động của tổ chức; người bị khoá hay chờ duyệt thì không. */
async function requireActiveMember(tx: Tx, userId: string) {
  const [row] = await tx
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(
      and(eq(orgMembers.orgId, sql`hive.ctx_org()`), eq(orgMembers.userId, userId), eq(orgMembers.status, "active")),
    );
  if (!row) throw new NotFoundError("MEMBER_NOT_FOUND", "Người này chưa là thành viên đang hoạt động của tổ chức.");
}

async function teamMemberView(tx: Tx, teamId: string, userId: string) {
  const [row] = await tx
    .select({
      teamId: teamMembers.teamId,
      userId: teamMembers.userId,
      role: teamMembers.role,
      name: authUser.name,
      email: authUser.email,
      image: authUser.image,
    })
    .from(teamMembers)
    .innerJoin(authUser, eq(authUser.id, teamMembers.userId))
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
  if (!row) throw new NotFoundError("TEAM_MEMBER_NOT_FOUND", "Người này không ở trong đội.");
  return row;
}

const alreadyInTeam = {
  team_members_team_id_user_id_pk: new ConflictError("ALREADY_IN_TEAM", "Người này đã ở trong đội."),
};

export function teamsRouter({ inOrg }: Procedures) {
  return {
    list: inOrg.teams.list.handler(async ({ context: { tx } }) => {
      const rows = await tx
        .select({
          team: teams,
          // Ghi rõ "teams"."id": Drizzle bỏ tên bảng khi chèn cột vào sql``, và trong subquery "id" sẽ trỏ nhầm sang
          // cột id của systems.
          systemCount: sql<number>`(select count(*)::int from hive.systems s where s.team_id = "teams"."id")`,
          memberCount: sql<number>`(select count(*)::int from hive.team_members m where m.team_id = "teams"."id")`,
        })
        .from(teams)
        .orderBy(asc(teams.name));
      return rows.map((r) => ({ ...toTeam(r.team), systemCount: r.systemCount, memberCount: r.memberCount }));
    }),

    create: inOrg.teams.create.handler(async ({ context: { tx, user, orgId }, input }) => {
      await allowWith(tx, user.id, "teams.create", () => requireOrgRole(tx, user.id, "admin"));
      const [row] = await onUnique(
        () => tx.insert(teams).values({ orgId, slug: input.slug, name: input.name, color: input.color }).returning(),
        slugTaken("teams_org_slug", "đội", input.slug),
      );
      if (!row) throw new Error("Không tạo được đội.");
      if (input.adminUserId) {
        await requireActiveMember(tx, input.adminUserId);
        await tx.insert(teamMembers).values({ teamId: row.id, orgId, userId: input.adminUserId, role: "admin" });
      }
      await recordAudit(tx, {
        action: "team.create",
        targetType: "team",
        targetId: row.id,
        data: { name: row.name, slug: row.slug, adminUserId: input.adminUserId ?? null },
      });
      return toTeam(row);
    }),

    update: inOrg.teams.update.handler(async ({ context: { tx, user }, input }) => {
      const current = await getTeam(tx, input.teamId);
      await requireTeamRole(tx, user.id, current.id, "admin");
      const { teamId: _, ...changes } = input;
      const set = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
      if (Object.keys(set).length === 0) return toTeam(current);
      const [row] = await onUnique(
        () => tx.update(teams).set(set).where(eq(teams.id, current.id)).returning(),
        slugTaken("teams_org_slug", "đội", input.slug ?? ""),
      );
      if (!row) throw new NotFoundError("TEAM_NOT_FOUND", "Không tìm thấy đội.");
      await recordAudit(tx, { action: "team.update", targetType: "team", targetId: row.id, data: set });
      return toTeam(row);
    }),

    remove: inOrg.teams.remove.handler(async ({ context: { tx, user }, input }) => {
      // Xoá đội kéo theo hệ thống và thành viên đội (cascade), nên chỉ chủ sở hữu được làm.
      await requireOrgRole(tx, user.id, "owner");
      const current = await getTeam(tx, input.teamId);
      await tx.delete(teams).where(eq(teams.id, current.id));
      await recordAudit(tx, {
        action: "team.delete",
        targetType: "team",
        targetId: current.id,
        data: { name: current.name, slug: current.slug },
      });
      return { ok: true as const };
    }),
  };
}

export function teamMembersRouter({ inOrg }: Procedures) {
  return {
    list: inOrg.teamMembers.list.handler(async ({ context: { tx, user }, input }) => {
      const team = await getTeam(tx, input.teamId);
      await requireTeamRole(tx, user.id, team.id, "viewer");
      return tx
        .select({
          teamId: teamMembers.teamId,
          userId: teamMembers.userId,
          role: teamMembers.role,
          name: authUser.name,
          email: authUser.email,
          image: authUser.image,
        })
        .from(teamMembers)
        .innerJoin(authUser, eq(authUser.id, teamMembers.userId))
        .where(eq(teamMembers.teamId, team.id))
        .orderBy(asc(authUser.name));
    }),

    add: inOrg.teamMembers.add.handler(async ({ context: { tx, user, orgId }, input }) => {
      const role = storableTeamRole(input.role);
      const team = await getTeam(tx, input.teamId);
      await allowWith(tx, user.id, "teams.manage", () => requireTeamRole(tx, user.id, team.id, "admin"), team.id);
      await requireActiveMember(tx, input.userId);
      await onUnique(
        () => tx.insert(teamMembers).values({ teamId: team.id, orgId, userId: input.userId, role }),
        alreadyInTeam,
      );
      await recordAudit(tx, {
        action: "team_member.add",
        targetType: "team",
        targetId: team.id,
        data: { userId: input.userId, role: input.role },
      });
      return teamMemberView(tx, team.id, input.userId);
    }),

    setRole: inOrg.teamMembers.setRole.handler(async ({ context: { tx, user }, input }) => {
      const role = storableTeamRole(input.role);
      const team = await getTeam(tx, input.teamId);
      await allowWith(tx, user.id, "teams.manage", () => requireTeamRole(tx, user.id, team.id, "admin"), team.id);
      const before = await teamMemberView(tx, team.id, input.userId);
      await tx
        .update(teamMembers)
        .set({ role })
        .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, input.userId)));
      await recordAudit(tx, {
        action: "team_member.set_role",
        targetType: "team",
        targetId: team.id,
        data: { userId: input.userId, from: before.role, to: input.role },
      });
      return { ...before, role: input.role };
    }),

    remove: inOrg.teamMembers.remove.handler(async ({ context: { tx, user }, input }) => {
      const team = await getTeam(tx, input.teamId);
      await allowWith(tx, user.id, "teams.manage", () => requireTeamRole(tx, user.id, team.id, "admin"), team.id);
      const removed = await tx
        .delete(teamMembers)
        .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, input.userId)))
        .returning({ role: teamMembers.role });
      if (removed.length === 0) throw new NotFoundError("TEAM_MEMBER_NOT_FOUND", "Người này không ở trong đội.");
      await recordAudit(tx, {
        action: "team_member.remove",
        targetType: "team",
        targetId: team.id,
        data: { userId: input.userId, role: removed[0]?.role },
      });
      return { ok: true as const };
    }),
  };
}
