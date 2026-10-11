import { ORPCError } from "@orpc/server";
import { eq, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import {
  type Auth,
  type AuthHooks,
  checkDomainVerification,
  getDomainVerification,
  getSsoProvider,
  removeSsoProvider,
  requestDomainVerification,
  saveSsoProvider,
  ssoCallbackUrl,
  systemTxtResolver,
} from "../identity/index.ts";
import { NotFoundError, type Tx, withTenant } from "../platform/index.ts";
import { invitationService } from "./invitations.ts";
import { requireOrgRole } from "./permissions.ts";
import type { Procedures, TenancyDeps } from "./procedures.ts";
import { orgMembers, orgs } from "./schema.ts";

// providerId suy ra từ id tổ chức chứ không từ slug: slug đổi được, còn callback URL đã dán bên nhà cung cấp thì
// không được đổi theo. Chỉ hub đăng ký nhà cung cấp (API của plugin bị tắt), nên providerId dạng này tin được.
const PREFIX = "org-";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ssoProviderIdOf = (orgId: string) => `${PREFIX}${orgId}`;
const orgIdOf = (providerId: string) => {
  const id = providerId.startsWith(PREFIX) ? providerId.slice(PREFIX.length) : "";
  return UUID.test(id) ? id : undefined;
};

/**
 * Xếp người vừa đăng nhập SSO vào tổ chức sở hữu nhà cung cấp, theo chính sách sso_join của tổ chức. Chỉ khi tên miền
 * đã được xác minh là của tổ chức và email đúng tên miền đó: tên miền do quản trị tổ chức tự khai, và IdP của tổ chức
 * phát được email bất kỳ (khách, đối tác, hay người của tổ chức khác); những người đó phải được mời riêng. Đã có dòng
 * thành viên (kể cả bị khoá) thì giữ nguyên, nên gọi lại ở mỗi lần đăng nhập vẫn an toàn.
 */
export type MemberPendingInput = { orgId: string; userId: string; email: string; name: string };
export type MemberPendingCallback = (tx: Tx, member: MemberPendingInput) => Promise<unknown>;

export function ssoProvisioning(pool: pg.Pool, onMemberPending?: MemberPendingCallback): AuthHooks["ssoSignedIn"] {
  return async ({ providerId, domain, domainVerified, user }) => {
    const orgId = orgIdOf(providerId);
    const emailDomain = user.email.split("@").pop()?.toLowerCase();
    if (!orgId || !domainVerified || !emailDomain || emailDomain !== domain.toLowerCase()) return;
    await withTenant(pool, { userId: user.id, orgId }, async (tx) => {
      const [org] = await tx.select({ ssoJoin: orgs.ssoJoin }).from(orgs).where(eq(orgs.id, orgId));
      if (!org) return;
      const status = org.ssoJoin === "member" ? "active" : "pending";
      const [row] = await tx
        .insert(orgMembers)
        .values({ orgId, userId: user.id, role: "member", status })
        .onConflictDoNothing()
        .returning();
      if (row) {
        await recordAudit(tx, {
          action: "org_member.sso_join",
          targetType: "user",
          targetId: user.id,
          data: { status, email: user.email },
        });
        if (status === "pending")
          await onMemberPending?.(tx, { orgId, userId: user.id, email: user.email, name: user.name });
      }
    });
  };
}

/** Các hook đăng nhập cần tới tổ chức; main.ts tiêm vào createAuth. */
export function authHooks(pool: pg.Pool, opts: { onMemberPending?: MemberPendingCallback } = {}): AuthHooks {
  const invites = invitationService(pool);
  return {
    inviteValid: (token, email) => invites.valid(token, email),
    invitePending: (email) => invites.pendingFor(email),
    anyOrg: () =>
      withTenant(pool, {}, async (tx) => {
        const { rows } = await tx.execute<{ any: boolean }>(sql`select hive.any_org() as any`);
        return rows[0]?.any !== false;
      }),
    acceptInvite: async (token, user) => {
      await invites.accept(token, user);
    },
    ssoSignedIn: ssoProvisioning(pool, opts.onMemberPending),
  };
}

async function settings(tx: Tx, auth: Auth, orgId: string) {
  const [org] = await tx.select({ ssoJoin: orgs.ssoJoin }).from(orgs).where(eq(orgs.id, orgId));
  if (!org) throw new NotFoundError("ORG_NOT_FOUND", "Không tìm thấy tổ chức.");
  const providerId = ssoProviderIdOf(orgId);
  return {
    providerId,
    callbackUrl: await ssoCallbackUrl(auth, providerId),
    join: org.ssoJoin,
    provider: await getSsoProvider(auth, providerId),
    domainVerification: await getDomainVerification(auth, providerId),
  };
}

/**
 * Tổ chức chưa xác minh vừa bị giành tên miền: ghi vào nhật ký của chính tổ chức đó, để quản trị bên ấy biết vì sao SSO
 * biến mất. Transaction riêng vì audit lấy org_id từ tenant context. Người thao tác là quản trị của tổ chức giành.
 */
async function auditDomainLost(pool: pg.Pool, userId: string, lostProviderId: string, domain: string, byOrgId: string) {
  const lostOrgId = orgIdOf(lostProviderId);
  if (!lostOrgId) return;
  await withTenant(pool, { userId, orgId: lostOrgId }, (tx) =>
    recordAudit(tx, {
      action: "sso.domain_lost",
      targetType: "org",
      targetId: lostOrgId,
      data: { domain, claimedByOrgId: byOrgId },
    }),
  );
}

/** Ghi audit hai phía khi tên miền bị giành từ tổ chức chưa xác minh. */
async function auditClaim(
  tx: Tx,
  pool: pg.Pool,
  claim: { userId: string; orgId: string; domain: string; claimedFrom: string | undefined },
) {
  if (!claim.claimedFrom) return;
  await recordAudit(tx, {
    action: "sso.domain_claim",
    targetType: "org",
    targetId: claim.orgId,
    data: { domain: claim.domain, fromOrgId: orgIdOf(claim.claimedFrom) ?? claim.claimedFrom },
  });
  await auditDomainLost(pool, claim.userId, claim.claimedFrom, claim.domain, claim.orgId);
}

export function ssoProvidersRouter({ inOrg }: Procedures, deps: TenancyDeps) {
  const auth = () => {
    if (!deps.auth) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Hub chưa cấu hình đăng nhập." });
    return deps.auth;
  };
  const resolveTxt = deps.resolveTxt ?? systemTxtResolver();

  return {
    get: inOrg.ssoProviders.get.handler(async ({ context: { tx, user, orgId } }) => {
      await requireOrgRole(tx, user.id, "admin");
      return settings(tx, auth(), orgId);
    }),

    upsert: inOrg.ssoProviders.upsert.handler(async ({ context: { tx, pool, user, orgId, headers }, input }) => {
      await requireOrgRole(tx, user.id, "admin");
      // Ghi phần của hub trước, gọi plugin sau cùng: plugin lỗi thì transaction rollback, không để lại chính sách
      // và audit cho một cấu hình chưa lưu được.
      await tx.update(orgs).set({ ssoJoin: input.join }).where(eq(orgs.id, orgId));
      await recordAudit(tx, {
        action: "sso.update",
        targetType: "org",
        targetId: orgId,
        data: {
          issuer: input.issuer,
          domain: input.domain,
          join: input.join,
          clientSecretChanged: Boolean(input.clientSecret),
        },
      });
      const saved = await saveSsoProvider(
        auth(),
        { userId: user.id, headers },
        {
          providerId: ssoProviderIdOf(orgId),
          issuer: input.issuer,
          domain: input.domain,
          clientId: input.clientId,
          clientSecret: input.clientSecret,
        },
      );
      await auditClaim(tx, pool, { userId: user.id, orgId, domain: input.domain, claimedFrom: saved.claimedFrom });
      return settings(tx, auth(), orgId);
    }),

    requestDomainVerification: inOrg.ssoProviders.requestDomainVerification.handler(
      async ({ context: { tx, user, orgId }, input }) => {
        await requireOrgRole(tx, user.id, "admin");
        const v = await requestDomainVerification(auth(), ssoProviderIdOf(orgId), input.domain);
        await recordAudit(tx, {
          action: "sso.domain_verification_request",
          targetType: "org",
          targetId: orgId,
          data: { domain: v.domain },
        });
        return settings(tx, auth(), orgId);
      },
    ),

    checkDomainVerification: inOrg.ssoProviders.checkDomainVerification.handler(
      async ({ context: { tx, pool, user, orgId, headers } }) => {
        await requireOrgRole(tx, user.id, "admin");
        const result = await checkDomainVerification(
          auth(),
          { userId: user.id, headers },
          ssoProviderIdOf(orgId),
          resolveTxt,
        );
        await recordAudit(tx, {
          action: "sso.domain_verify",
          targetType: "org",
          targetId: orgId,
          data: { domain: result.domain, applied: result.applied },
        });
        await auditClaim(tx, pool, { userId: user.id, orgId, domain: result.domain, claimedFrom: result.claimedFrom });
        return settings(tx, auth(), orgId);
      },
    ),

    remove: inOrg.ssoProviders.remove.handler(async ({ context: { tx, user, orgId, headers } }) => {
      await requireOrgRole(tx, user.id, "admin");
      await recordAudit(tx, { action: "sso.remove", targetType: "org", targetId: orgId });
      const removed = await removeSsoProvider(auth(), { userId: user.id, headers }, ssoProviderIdOf(orgId));
      if (!removed) throw new NotFoundError("SSO_NOT_CONFIGURED", "Tổ chức chưa cấu hình SSO.");
      return settings(tx, auth(), orgId);
    }),
  };
}
