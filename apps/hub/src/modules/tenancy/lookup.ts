import { and, eq, sql } from "drizzle-orm";
import { authUser } from "../identity/index.ts";
import type { Tx } from "../platform/index.ts";
import { orgMembers, systems } from "./schema.ts";

export interface SystemRef {
  id: string;
  orgId: string;
  teamId: string;
  slug: string;
  name: string;
}

/** Hệ thống trong tổ chức của context; RLS lọc hệ thống của tổ chức khác nên id lạ trả null. */
export async function findSystem(tx: Tx, id: string): Promise<SystemRef | null> {
  const [row] = await tx
    .select({ id: systems.id, orgId: systems.orgId, teamId: systems.teamId, slug: systems.slug, name: systems.name })
    .from(systems)
    .where(eq(systems.id, id));
  return row ?? null;
}

/** Lệnh quản trị cần giải slug trước khi biết tenant; hàm SQL chỉ lộ id, không mở quyền đọc danh sách tổ chức. */
export async function resolveLegacyImportOrg(tx: Tx, slug: string): Promise<string | null> {
  const { rows } = await tx.execute<{ id: string | null }>(sql`select hive.legacy_import_org(${slug}) as id`);
  return rows[0]?.id ?? null;
}

/** Hệ cũ có tài liệu cấp hệ thống; chuyển sang phạm vi đội sở hữu hệ thống cùng slug. */
export async function findSystemBySlug(tx: Tx, slug: string): Promise<SystemRef | null> {
  const rows = await tx.select().from(systems).where(eq(systems.slug, slug)).limit(2);
  return rows.length === 1 ? (rows[0] ?? null) : null;
}

/** Chỉ gán tác giả có email khớp một thành viên của tổ chức đích. */
export async function findOrgUserByEmail(tx: Tx, email: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: authUser.id })
    .from(orgMembers)
    .innerJoin(authUser, eq(authUser.id, orgMembers.userId))
    .where(and(eq(orgMembers.orgId, sql`hive.ctx_org()`), sql`lower(${authUser.email}) = ${email.toLowerCase()}`));
  return row?.id ?? null;
}
