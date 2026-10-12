import { and, asc, eq, ne, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { authUser } from "../identity/index.ts";
import { ConflictError, ForbiddenError, NotFoundError, type Tx } from "../platform/index.ts";
import { requireOrgRole } from "./permissions.ts";
import { iso, type Procedures } from "./procedures.ts";
import { allowWith } from "./roles.ts";
import { orgMembers, teamMembers, teams } from "./schema.ts";

const inCtxOrg = eq(orgMembers.orgId, sql`hive.ctx_org()`);

async function getMember(tx: Tx, userId: string) {
  const [row] = await tx
    .select()
    .from(orgMembers)
    .where(and(inCtxOrg, eq(orgMembers.userId, userId)));
  if (!row) throw new NotFoundError("MEMBER_NOT_FOUND", "Người này không thuộc tổ chức.");
  return row;
}

/**
 * Chặn thao tác làm tổ chức không còn chủ sở hữu đang hoạt động. Khoá các dòng owner (FOR UPDATE) để hai owner
 * cùng hạ nhau một lúc thì người sau phải chờ và thấy kết quả của người trước.
 */
async function keepAnotherOwner(tx: Tx, userId: string) {
  const others = await tx
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(and(inCtxOrg, eq(orgMembers.role, "owner"), eq(orgMembers.status, "active"), ne(orgMembers.userId, userId)))
    .for("update");
  if (others.length === 0)
    throw new ConflictError("LAST_OWNER", "Tổ chức phải còn ít nhất một chủ sở hữu đang hoạt động.");
}

/** Duyệt hoặc từ chối người đang chờ (thường là người vào bằng SSO). Từ chối là khoá, không xoá: xoá thì lần đăng
 * nhập SSO sau họ lại vào hàng chờ. */
function decidePending({ inOrg }: Procedures, decision: "approve" | "deny") {
  const proc = decision === "approve" ? inOrg.orgMembers.approve : inOrg.orgMembers.deny;
  const status = decision === "approve" ? ("active" as const) : ("blocked" as const);
  return proc.handler(async ({ context: { tx, user }, input }) => {
    await allowWith(tx, user.id, "members.lock", () => requireOrgRole(tx, user.id, "admin"));
    const target = await getMember(tx, input.userId);
    if (target.status !== "pending")
      throw new ConflictError("MEMBER_NOT_PENDING", "Người này không ở trạng thái chờ duyệt.");
    await tx
      .update(orgMembers)
      .set({ status })
      .where(and(inCtxOrg, eq(orgMembers.userId, target.userId)));
    await recordAudit(tx, { action: `org_member.${decision}`, targetType: "user", targetId: target.userId });
    return { userId: target.userId, role: target.role, status };
  });
}

export function orgMembersRouter(p: Procedures) {
  const { inOrg } = p;
  return {
    approve: decidePending(p, "approve"),
    deny: decidePending(p, "deny"),
    list: inOrg.orgMembers.list.handler(async ({ context: { tx } }) => {
      const members = await tx
        .select({
          userId: orgMembers.userId,
          role: orgMembers.role,
          status: orgMembers.status,
          joinedAt: orgMembers.createdAt,
          name: authUser.name,
          email: authUser.email,
          image: authUser.image,
          providers: sql<string[]>`activity.providers`,
          lastSeenAt: sql<string | null>`activity.last_seen_at`,
        })
        .from(orgMembers)
        .innerJoin(authUser, eq(authUser.id, orgMembers.userId))
        .innerJoin(sql`hive.org_member_activity() AS activity`, sql`activity.user_id = ${orgMembers.userId}`)
        .where(inCtxOrg)
        .orderBy(asc(authUser.name));
      const memberships = await tx
        .select({ userId: teamMembers.userId, teamId: teams.id, name: teams.name, role: teamMembers.role })
        .from(teamMembers)
        .innerJoin(teams, eq(teams.id, teamMembers.teamId))
        .orderBy(asc(teams.name));
      const byUser = Map.groupBy(memberships, (m) => m.userId);
      return members.map((m) => ({
        ...m,
        joinedAt: iso(m.joinedAt),
        lastSeenAt: m.lastSeenAt === null ? null : new Date(m.lastSeenAt).toISOString(),
        teams: (byUser.get(m.userId) ?? []).map(({ teamId, name, role }) => ({ teamId, name, role })),
      }));
    }),

    setRole: inOrg.orgMembers.setRole.handler(async ({ context: { tx, user }, input }) => {
      await requireOrgRole(tx, user.id, "owner");
      const target = await getMember(tx, input.userId);
      if (target.role === "owner" && input.role !== "owner" && target.status === "active")
        await keepAnotherOwner(tx, target.userId);
      await tx
        .update(orgMembers)
        .set({ role: input.role })
        .where(and(inCtxOrg, eq(orgMembers.userId, target.userId)));
      await recordAudit(tx, {
        action: "org_member.set_role",
        targetType: "user",
        targetId: target.userId,
        data: { from: target.role, to: input.role },
      });
      return { userId: target.userId, role: input.role, status: target.status };
    }),

    setStatus: inOrg.orgMembers.setStatus.handler(async ({ context: { tx, user }, input }) => {
      const actorRole = await requireOrgRole(tx, user.id, "admin");
      const target = await getMember(tx, input.userId);
      if (target.userId === user.id)
        throw new ForbiddenError("SELF_STATUS", "Không tự khoá hay đổi trạng thái của chính mình.");
      if (target.role === "owner" && actorRole !== "owner")
        throw new ForbiddenError("ORG_ROLE_REQUIRED", "Chỉ chủ sở hữu mới đổi được trạng thái của chủ sở hữu khác.");
      if (target.role === "owner" && target.status === "active" && input.status !== "active")
        await keepAnotherOwner(tx, target.userId);
      await tx
        .update(orgMembers)
        .set({ status: input.status })
        .where(and(inCtxOrg, eq(orgMembers.userId, target.userId)));
      await recordAudit(tx, {
        action: "org_member.set_status",
        targetType: "user",
        targetId: target.userId,
        data: { from: target.status, to: input.status },
      });
      return { userId: target.userId, role: target.role, status: input.status };
    }),
  };
}
