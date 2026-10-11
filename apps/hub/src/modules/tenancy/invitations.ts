import { createHash, randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { ConflictError, ForbiddenError, NotFoundError, type Tx, withTenant } from "../platform/index.ts";
import { requireOrgRole } from "./permissions.ts";
import { iso, type Procedures, type TenancyDeps } from "./procedures.ts";
import { invitations, orgMembers, orgs, teamMembers, teams } from "./schema.ts";
import { getTeam } from "./teams.ts";

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 32 byte ngẫu nhiên: đủ để không đoán được, nên chỉ cần băm một lượt sha256 (không cần hàm băm chậm). */
const newToken = () => randomBytes(32).toString("base64url");
export const hashInviteToken = (token: string) => createHash("sha256").update(token).digest("hex");

type Invitation = typeof invitations.$inferSelect;

const statusOf = (inv: Invitation, now = new Date()) =>
  inv.acceptedAt ? ("accepted" as const) : inv.expiresAt <= now ? ("expired" as const) : ("pending" as const);

/**
 * Lời mời theo mã, chạy fn trong transaction có context của tổ chức mời. Người nhận chưa thuộc tổ chức nên bước
 * đầu chỉ tìm được lời mời nhờ policy theo mã băm (inviteTokenHash); bước sau mới đặt tổ chức vào context để đọc
 * tên tổ chức và ghi org_members, team_members, audit (các policy này chỉ cho ghi trong tổ chức của context).
 */
async function withInvitation<T>(
  pool: pg.Pool,
  token: string,
  userId: string | undefined,
  fn: (tx: Tx, inv: Invitation) => Promise<T>,
): Promise<T> {
  const inviteTokenHash = hashInviteToken(token);
  const orgId = await withTenant(pool, { inviteTokenHash }, async (tx) => {
    const [row] = await tx
      .select({ orgId: invitations.orgId })
      .from(invitations)
      .where(eq(invitations.tokenHash, inviteTokenHash));
    return row?.orgId;
  });
  if (!orgId)
    throw new NotFoundError("INVITE_NOT_FOUND", "Không tìm thấy lời mời. Link có thể sai hoặc đã bị thu hồi.");
  return withTenant(pool, { userId, orgId, inviteTokenHash }, async (tx) => {
    // Khoá dòng để hai lần nhận cùng lúc không cùng lọt qua bước kiểm "chưa dùng".
    const [inv] = await tx
      .select()
      .from(invitations)
      .where(and(eq(invitations.tokenHash, inviteTokenHash), eq(invitations.orgId, orgId)))
      .for("update");
    if (!inv)
      throw new NotFoundError("INVITE_NOT_FOUND", "Không tìm thấy lời mời. Link có thể sai hoặc đã bị thu hồi.");
    return fn(tx, inv);
  });
}

function assertUsable(inv: Invitation, email: string) {
  const status = statusOf(inv);
  if (status === "accepted") throw new ConflictError("INVITE_USED", "Lời mời này đã được dùng.");
  if (status === "expired")
    throw new ConflictError("INVITE_EXPIRED", "Lời mời đã hết hạn. Hãy nhờ quản trị tổ chức gửi lời mời mới.");
  if (inv.email !== email.toLowerCase())
    throw new ForbiddenError(
      "INVITE_EMAIL_MISMATCH",
      `Lời mời này dành cho ${inv.email}. Hãy đăng nhập bằng đúng email đó để nhận lời mời.`,
    );
}

export interface InviteUser {
  id: string;
  email: string;
}

/** Dùng chung cho API invitations.accept và cho việc tự nhận lời mời ngay sau khi đăng ký bằng mã mời. */
export function invitationService(pool: pg.Pool) {
  return {
    /** Mã còn dùng được cho email này không; không ném lỗi để hook đăng ký tự chọn thông báo. */
    async valid(token: string, email: string): Promise<boolean> {
      try {
        return await withInvitation(pool, token, undefined, async (_tx, inv) => {
          assertUsable(inv, email);
          return true;
        });
      } catch (error) {
        if (error instanceof NotFoundError || error instanceof ConflictError || error instanceof ForbiddenError)
          return false;
        throw error;
      }
    },

    /** Email này có lời mời còn hạn, chưa dùng ở tổ chức nào không. Không cần mã: dùng cho đăng nhập GitHub/GitLab. */
    async pendingFor(email: string): Promise<boolean> {
      return withTenant(pool, {}, async (tx) => {
        const { rows } = await tx.execute<{ pending: boolean }>(sql`select hive.invite_pending(${email}) as pending`);
        return rows[0]?.pending === true;
      });
    },

    accept(token: string, user: InviteUser) {
      return withInvitation(pool, token, user.id, async (tx, inv) => {
        assertUsable(inv, user.email);
        const [existing] = await tx
          .select()
          .from(orgMembers)
          .where(and(eq(orgMembers.orgId, inv.orgId), eq(orgMembers.userId, user.id)));
        if (existing?.status === "blocked")
          throw new ForbiddenError("MEMBER_BLOCKED", "Tài khoản của bạn đang bị khoá trong tổ chức này.");
        let role = inv.orgRole;
        if (!existing) await tx.insert(orgMembers).values({ orgId: inv.orgId, userId: user.id, role });
        else if (existing.status === "pending")
          // Người đang chờ duyệt (vd. đã vào bằng SSO) mà được quản trị mời thì coi như đã duyệt.
          await tx
            .update(orgMembers)
            .set({ status: "active", role })
            .where(and(eq(orgMembers.orgId, inv.orgId), eq(orgMembers.userId, user.id)));
        // Đã là thành viên thì giữ vai trò hiện có: lời mời không được hạ quyền ai.
        else role = existing.role;
        // Đội có thể đã bị xoá sau khi mời (team_id không có khoá ngoại); khi đó chỉ vào tổ chức.
        if (inv.teamId) {
          const [team] = await tx.select({ id: teams.id }).from(teams).where(eq(teams.id, inv.teamId));
          if (team)
            await tx
              .insert(teamMembers)
              .values({ teamId: team.id, orgId: inv.orgId, userId: user.id, role: inv.teamRole ?? "member" })
              .onConflictDoNothing();
        }
        await tx
          .update(invitations)
          .set({ acceptedAt: new Date(), acceptedBy: user.id })
          .where(eq(invitations.id, inv.id));
        await recordAudit(tx, {
          action: "invitation.accept",
          targetType: "invitation",
          targetId: inv.id,
          data: { email: inv.email, orgRole: inv.orgRole, teamId: inv.teamId, teamRole: inv.teamRole },
        });
        const [org] = await tx.select().from(orgs).where(eq(orgs.id, inv.orgId));
        if (!org) throw new NotFoundError("ORG_NOT_FOUND", "Không tìm thấy tổ chức.");
        return {
          id: org.id,
          slug: org.slug,
          name: org.name,
          emailDomain: org.emailDomain,
          createdAt: iso(org.createdAt),
          role,
        };
      });
    },
  };
}

export function invitationsRouter({ base, authed, inOrg }: Procedures, deps: TenancyDeps) {
  const publicUrl = (deps.publicUrl ?? "").replace(/\/+$/, "");
  const pool = () => {
    if (!deps.pool) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Hub chưa cấu hình HIVE_DATABASE_URL." });
    return deps.pool;
  };

  return {
    create: inOrg.invitations.create.handler(async ({ context: { tx, user, orgId }, input }) => {
      // Mời làm quản trị là cấp vai trò quản trị; đổi vai trò (orgMembers.setRole) chỉ chủ sở hữu được làm, nên mời
      // cũng vậy, không thì quản trị tự nhân bản quyền của mình qua lời mời.
      await requireOrgRole(tx, user.id, input.orgRole === "admin" ? "owner" : "admin");
      if (input.teamId) await getTeam(tx, input.teamId);
      const emails = [...new Set(input.emails)];
      // Mời lại cùng email thì thay lời mời cũ chưa dùng: link chỉ hiện một lần, nên mời lại là cách lấy link mới.
      await tx
        .delete(invitations)
        .where(and(eq(invitations.orgId, orgId), inArray(invitations.email, emails), isNull(invitations.acceptedAt)));
      const expiresAt = new Date(Date.now() + TTL_MS);
      const created = [];
      for (const email of emails) {
        const token = newToken();
        const [row] = await tx
          .insert(invitations)
          .values({
            orgId,
            email,
            orgRole: input.orgRole,
            teamId: input.teamId ?? null,
            teamRole: input.teamId ? (input.teamRole ?? "member") : null,
            tokenHash: hashInviteToken(token),
            expiresAt,
            createdBy: user.id,
          })
          .returning();
        if (!row) throw new Error("Không tạo được lời mời.");
        await recordAudit(tx, {
          action: "invitation.create",
          targetType: "invitation",
          targetId: row.id,
          data: { email, orgRole: row.orgRole, teamId: row.teamId, teamRole: row.teamRole },
        });
        created.push({ id: row.id, email, link: `${publicUrl}/moi/${token}`, expiresAt: iso(expiresAt) });
      }
      return { invitations: created };
    }),

    list: inOrg.invitations.list.handler(async ({ context: { tx, user } }) => {
      await requireOrgRole(tx, user.id, "admin");
      const rows = await tx
        .select({ inv: invitations, teamName: teams.name })
        .from(invitations)
        .leftJoin(teams, eq(teams.id, invitations.teamId))
        .where(eq(invitations.orgId, sql`hive.ctx_org()`))
        .orderBy(desc(invitations.createdAt));
      const now = new Date();
      return rows.map(({ inv, teamName }) => ({
        id: inv.id,
        email: inv.email,
        orgRole: inv.orgRole,
        teamId: inv.teamId,
        teamName,
        teamRole: inv.teamRole,
        status: statusOf(inv, now),
        expiresAt: iso(inv.expiresAt),
        createdAt: iso(inv.createdAt),
        acceptedAt: inv.acceptedAt ? iso(inv.acceptedAt) : null,
      }));
    }),

    revoke: inOrg.invitations.revoke.handler(async ({ context: { tx, user }, input }) => {
      await requireOrgRole(tx, user.id, "admin");
      const [inv] = await tx.select().from(invitations).where(eq(invitations.id, input.invitationId));
      if (!inv) throw new NotFoundError("INVITE_NOT_FOUND", "Không tìm thấy lời mời.");
      if (inv.acceptedAt) throw new ConflictError("INVITE_USED", "Lời mời đã được dùng, không thu hồi được.");
      await tx.delete(invitations).where(eq(invitations.id, inv.id));
      await recordAudit(tx, {
        action: "invitation.revoke",
        targetType: "invitation",
        targetId: inv.id,
        data: { email: inv.email },
      });
      return { ok: true as const };
    }),

    preview: base.invitations.preview.handler(({ input }) =>
      withInvitation(pool(), input.token, undefined, async (tx, inv) => {
        const [org] = await tx.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, inv.orgId));
        return { orgName: org?.name ?? "", email: inv.email, status: statusOf(inv), expiresAt: iso(inv.expiresAt) };
      }),
    ),

    accept: authed.invitations.accept.handler(({ context: { user, pool }, input }) =>
      invitationService(pool).accept(input.token, { id: user.id, email: user.email }),
    ),
  };
}
