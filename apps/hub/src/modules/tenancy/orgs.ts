import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { ForbiddenError, NotFoundError, type Tx, withTenant } from "../platform/index.ts";
import { requireOrgRole } from "./permissions.ts";
import { iso, onUnique, type Procedures, type SessionUser, slugTaken, type TenancyDeps } from "./procedures.ts";
import { orgMembers, orgs } from "./schema.ts";

// Khoá advisory cố định cho việc tạo tổ chức: hai người cùng tạo tổ chức đầu tiên thì người sau phải thấy tổ chức
// của người trước, nếu không cả hai cùng lọt quy tắc "hub chưa có tổ chức nào".
const ORG_CREATE_LOCK = 7_310_001;

const toOrg = (o: typeof orgs.$inferSelect) => ({
  id: o.id,
  slug: o.slug,
  name: o.name,
  emailDomain: o.emailDomain,
  createdAt: iso(o.createdAt),
});

/** Người đầu tiên của hub được tạo tổ chức; sau đó chỉ email trong HIVE_ORG_CREATORS. */
async function canCreateOrg(tx: Tx, user: SessionUser, creators: string[]): Promise<boolean> {
  if (creators.includes(user.email.toLowerCase())) return true;
  const { rows } = await tx.execute<{ any: boolean }>(sql`select hive.any_org() as any`);
  return rows[0]?.any === false;
}

async function currentOrg(tx: Tx, orgId: string) {
  const [row] = await tx.select().from(orgs).where(eq(orgs.id, orgId));
  if (!row) throw new NotFoundError("ORG_NOT_FOUND", "Không tìm thấy tổ chức.");
  return row;
}

export function orgsRouter({ authed, inOrg }: Procedures, deps: TenancyDeps) {
  const creators = deps.orgCreators ?? [];
  return {
    mine: authed.orgs.mine.handler(({ context: { user, pool } }) =>
      withTenant(pool, { userId: user.id }, async (tx) => {
        // Không có tổ chức trong context: RLS chỉ cho thấy dòng thành viên của chính người gọi.
        const rows = await tx
          .select({ org: orgs, role: orgMembers.role })
          .from(orgMembers)
          .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
          .where(and(eq(orgMembers.userId, user.id), eq(orgMembers.status, "active")))
          .orderBy(asc(orgs.name));
        return {
          orgs: rows.map((r) => ({ ...toOrg(r.org), role: r.role })),
          canCreateOrg: await canCreateOrg(tx, user, creators),
        };
      }),
    ),

    create: authed.orgs.create.handler(({ context: { user, pool }, input }) => {
      // Sinh id trước rồi đặt làm context: policy orgs_insert chỉ cho ghi đúng tổ chức của context.
      const id = randomUUID();
      return withTenant(pool, { userId: user.id, orgId: id }, async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${ORG_CREATE_LOCK})`);
        if (!(await canCreateOrg(tx, user, creators))) {
          throw new ForbiddenError(
            "ORG_CREATE_NOT_ALLOWED",
            "Hub đã có tổ chức. Hãy nhờ quản trị tổ chức gửi lời mời, hoặc nhờ quản trị hub cho phép tạo tổ chức mới.",
          );
        }
        const [row] = await onUnique(
          () =>
            tx
              .insert(orgs)
              .values({ id, slug: input.slug, name: input.name, emailDomain: input.emailDomain, createdBy: user.id })
              .returning(),
          slugTaken("orgs_slug_unique", "tổ chức", input.slug),
        );
        if (!row) throw new Error("Không tạo được tổ chức.");
        await tx.insert(orgMembers).values({ orgId: id, userId: user.id, role: "owner" });
        await recordAudit(tx, {
          action: "org.create",
          targetType: "org",
          targetId: id,
          data: { name: input.name, slug: input.slug, emailDomain: input.emailDomain ?? null },
        });
        return { ...toOrg(row), role: "owner" as const };
      });
    }),

    get: inOrg.orgs.get.handler(async ({ context: { tx, orgId, orgRole } }) => ({
      ...toOrg(await currentOrg(tx, orgId)),
      role: orgRole,
    })),

    update: inOrg.orgs.update.handler(async ({ context: { tx, user, orgId }, input }) => {
      const role = await requireOrgRole(tx, user.id, "admin");
      const { orgId: _, ...changes } = input;
      const set = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
      if (Object.keys(set).length === 0) return { ...toOrg(await currentOrg(tx, orgId)), role };
      const [row] = await onUnique(
        () => tx.update(orgs).set(set).where(eq(orgs.id, orgId)).returning(),
        slugTaken("orgs_slug_unique", "tổ chức", input.slug ?? ""),
      );
      if (!row) throw new NotFoundError("ORG_NOT_FOUND", "Không tìm thấy tổ chức.");
      await recordAudit(tx, { action: "org.update", targetType: "org", targetId: orgId, data: set });
      return { ...toOrg(row), role };
    }),
  };
}
