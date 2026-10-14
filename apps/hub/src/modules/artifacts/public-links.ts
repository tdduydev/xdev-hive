import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  ARTIFACT_LIMITS,
  type ArtifactPublicLink,
  type ArtifactPublicLinkOrgItem,
  type ArtifactPublicLinkRevokeReason,
  type ArtifactType,
} from "@xdev-hive/contracts";
import { and, count, desc, eq, gt, isNull, type SQL, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { ForbiddenError, type Tx, withTenant } from "../platform/index.ts";
import { orgRoleOf, requireOrgRole } from "../tenancy/index.ts";
import { artifactError, audit, type Reader } from "./access.ts";
import { artifactPolicyOf } from "./limits.ts";
import { artifactPublicLinks, artifacts } from "./schema.ts";
import { artifactFor } from "./service.ts";
import { type ArtifactDeps, assertNoSecrets, revokePublicLinks, userNames, versionRow } from "./versions.ts";

/*
 * Link công khai (plan.md D21, FR-140…FR-147): người ngoài tổ chức xem đúng một phiên bản, không đăng nhập. Mã chỉ lưu
 * dạng sha256 như PAT nhưng không mang tổ chức (URL công khai không lộ id tổ chức); tra bằng hàm SECURITY DEFINER rồi mới
 * vào `withTenant` của tổ chức đó.
 */

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Mã link 32 byte có dạng base64url đúng 43 ký tự; chặn sớm chuỗi khác để không tốn một lần tra database. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const publicPagePath = (token: string) => `/_artifact/s/${token}`;

type LinkRow = typeof artifactPublicLinks.$inferSelect;

/** Cột `active` tính bằng đồng hồ của database, cùng đồng hồ với hàm resolve và với lúc thu hồi. */
const activeSql = sql<boolean>`(${artifactPublicLinks.revokedAt} is null and ${artifactPublicLinks.expiresAt} > now())`;
const activeWhere = and(isNull(artifactPublicLinks.revokedAt), gt(artifactPublicLinks.expiresAt, sql`now()`)) as SQL;

function linkView(row: LinkRow, active: boolean): ArtifactPublicLink {
  return {
    id: row.id,
    artifactId: row.artifactId,
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedBy: row.revokedBy,
    revokeReason: (row.revokeReason as ArtifactPublicLinkRevokeReason | null) ?? null,
    viewCount: row.viewCount,
    lastViewedAt: row.lastViewedAt?.toISOString() ?? null,
    active,
  };
}

async function linkById(tx: Tx, id: string): Promise<{ row: LinkRow; active: boolean } | null> {
  const [found] = await tx
    .select({ row: artifactPublicLinks, active: activeSql })
    .from(artifactPublicLinks)
    .where(eq(artifactPublicLinks.id, id));
  return found ?? null;
}

const isOrgAdmin = async (tx: Tx, userId: string) => {
  const role = await orgRoleOf(tx, userId);
  return role === "admin" || role === "owner";
};

// ---- Route oRPC ----------------------------------------------------------------------------------------------------

/**
 * `publicLinks.create` (FR-140, FR-141): chỉ chủ, chính sách bật, hạn trong trần, ≤ 10 link còn hiệu lực, quét bí mật lại
 * vì quy tắc quét có thể mới hơn lúc lưu. Mã chỉ có trong URL trả về lần này.
 */
export async function createPublicLink(
  tx: Tx,
  reader: Reader,
  input: { id: string; version: number; expiresInDays: number },
  deps: { publicUrl: string },
): Promise<{ link: ArtifactPublicLink; url: string }> {
  // Khoá dòng artifact để hai lần tạo đồng thời không cùng lọt qua phép đếm 10 link.
  const row = await artifactFor(tx, reader, input.id, { lock: true });
  if (row.deletedAt)
    throw artifactError("ARTIFACT_NOT_FOUND", "Artifact đang ở thùng rác. Khôi phục trước khi chia sẻ.");
  if (reader.kind !== "user" || row.ownerUserId !== reader.userId) throw artifactError("ARTIFACT_LINK_OWNER_ONLY");
  const policy = await artifactPolicyOf(tx);
  if (!policy.enabled) throw artifactError("ARTIFACTS_DISABLED");
  if (!policy.publicLinks.enabled) throw artifactError("ARTIFACT_PUBLIC_LINKS_DISABLED");
  if (input.expiresInDays > policy.publicLinks.maxDays)
    throw artifactError(
      "ARTIFACT_LINK_EXPIRY_INVALID",
      `Hạn link tối đa ${policy.publicLinks.maxDays} ngày theo chính sách của tổ chức.`,
      { limit: policy.publicLinks.maxDays },
    );
  const v = await versionRow(tx, row.id, input.version);
  if (!v) throw artifactError("ARTIFACT_NOT_FOUND", "Không tìm thấy phiên bản này.");
  if (v.tombstonedAt || v.content === null)
    throw artifactError("ARTIFACT_NOT_FOUND", "Phiên bản này đã bị xoá vì chứa bí mật.");
  assertNoSecrets(v.content, { artifactId: row.id, type: row.type });
  const [active] = await tx
    .select({ n: count() })
    .from(artifactPublicLinks)
    .where(and(eq(artifactPublicLinks.artifactId, row.id), activeWhere));
  if ((active?.n ?? 0) >= ARTIFACT_LIMITS.activePublicLinks)
    throw artifactError("ARTIFACT_LINK_LIMIT", undefined, { limit: ARTIFACT_LIMITS.activePublicLinks });

  const token = randomBytes(32).toString("base64url");
  const [link] = await tx
    .insert(artifactPublicLinks)
    .values({
      orgId: row.orgId,
      artifactId: row.id,
      version: v.version,
      tokenSha256: sha256(token),
      createdBy: reader.userId,
      expiresAt: sql`now() + make_interval(days => ${input.expiresInDays}::int)`,
    })
    .returning();
  if (!link) throw new Error("Không lưu được link công khai.");
  // Không ghi mã hay URL: audit đọc được bởi quản trị, mã trong đó là mở được link (SC-012).
  await audit(tx, reader, "artifact.public_link.create", row.id, {
    linkId: link.id,
    version: v.version,
    expiresAt: link.expiresAt.toISOString(),
    expiresInDays: input.expiresInDays,
  });
  return { link: linkView(link, true), url: new URL(publicPagePath(token), deps.publicUrl).href };
}

/** `publicLinks.list`: link của một artifact, mới tạo trước, không mã. Chủ, hoặc quản trị tổ chức (họ thu hồi được). */
export async function listPublicLinks(tx: Tx, reader: Reader, input: { id: string }): Promise<ArtifactPublicLink[]> {
  const [row] = await tx
    .select({ id: artifacts.id, ownerUserId: artifacts.ownerUserId })
    .from(artifacts)
    .where(eq(artifacts.id, input.id));
  if (!row) throw artifactError("ARTIFACT_NOT_FOUND");
  if (reader.kind !== "user" || (row.ownerUserId !== reader.userId && !(await isOrgAdmin(tx, reader.userId)))) {
    // Đọc được thì nói rõ là thiếu quyền; không đọc được thì như không tồn tại để không dò được id.
    await artifactFor(tx, reader, input.id);
    throw artifactError("ARTIFACT_LINK_OWNER_ONLY", "Chỉ chủ artifact xem được link công khai của nó.");
  }
  const rows = await tx
    .select({ row: artifactPublicLinks, active: activeSql })
    .from(artifactPublicLinks)
    .where(eq(artifactPublicLinks.artifactId, row.id))
    .orderBy(desc(artifactPublicLinks.createdAt), desc(artifactPublicLinks.id))
    .limit(200);
  return rows.map((r) => linkView(r.row, r.active));
}

/** `publicLinks.revoke` (FR-142, FR-147): chủ hoặc quản trị tổ chức; link đã hết hiệu lực thì trả nguyên trạng. */
export async function revokePublicLink(
  tx: Tx,
  reader: Reader,
  input: { linkId: string },
  deps: ArtifactDeps,
): Promise<ArtifactPublicLink> {
  const found = await linkById(tx, input.linkId);
  if (!found) throw artifactError("ARTIFACT_NOT_FOUND", "Không tìm thấy link công khai.");
  const [row] = await tx.select().from(artifacts).where(eq(artifacts.id, found.row.artifactId)).for("update");
  if (!row) throw artifactError("ARTIFACT_NOT_FOUND", "Không tìm thấy link công khai.");
  const allowed =
    reader.kind === "user" && (row.ownerUserId === reader.userId || (await isOrgAdmin(tx, reader.userId)));
  if (!allowed) {
    await artifactFor(tx, reader, row.id);
    throw new ForbiddenError("ARTIFACT_FORBIDDEN", "Chỉ chủ artifact hoặc quản trị tổ chức thu hồi được link.");
  }
  if (found.active) await revokePublicLinks(tx, reader, row, eq(artifactPublicLinks.id, found.row.id), "manual", deps);
  const after = await linkById(tx, input.linkId);
  if (!after) throw artifactError("ARTIFACT_NOT_FOUND", "Không tìm thấy link công khai.");
  return linkView(after.row, after.active);
}

const encodeCursor = (at: string, id: string) => Buffer.from(JSON.stringify([at, id])).toString("base64url");
function decodeCursor(cursor: string): [string, string] | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "string"
      ? [value[0], value[1]]
      : null;
  } catch {
    return null;
  }
}

/**
 * `publicLinks.orgList` (FR-147): link còn hiệu lực của cả tổ chức cho quản trị thu hồi. Chỉ metadata, kể cả artifact
 * `private` mà quản trị không đọc được (C5): họ cần biết thứ gì đang ra ngoài tổ chức.
 */
export async function orgListPublicLinks(
  tx: Tx,
  userId: string,
  input: { cursor?: string | undefined; limit: number },
): Promise<{ items: ArtifactPublicLinkOrgItem[]; nextCursor: string | null }> {
  await requireOrgRole(tx, userId, "admin");
  const where: SQL[] = [activeWhere];
  const at = input.cursor ? decodeCursor(input.cursor) : null;
  if (at)
    where.push(
      sql`(${artifactPublicLinks.createdAt}, ${artifactPublicLinks.id}) < (${at[0]}::timestamptz, ${at[1]}::uuid)`,
    );
  const rows = await tx
    .select({
      row: artifactPublicLinks,
      at: sql<string>`${artifactPublicLinks.createdAt}::text`,
      title: artifacts.title,
      type: artifacts.type,
      ownerUserId: artifacts.ownerUserId,
    })
    .from(artifactPublicLinks)
    .innerJoin(artifacts, eq(artifacts.id, artifactPublicLinks.artifactId))
    .where(and(...where))
    .orderBy(desc(artifactPublicLinks.createdAt), desc(artifactPublicLinks.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const names = await userNames(
    tx,
    page.map((r) => r.ownerUserId),
  );
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      ...linkView(r.row, true),
      artifactTitle: r.title,
      artifactType: r.type,
      owner: { id: r.ownerUserId, name: names.get(r.ownerUserId) ?? r.ownerUserId },
    })),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.at, last.row.id) : null,
  };
}

// ---- Phục vụ trang công khai ---------------------------------------------------------------------------------------

/** `null` khi mã sai dạng, không có, hết hạn hay đã thu hồi; người gọi trả cùng một trang 404 cho mọi lý do. */
export async function resolvePublicLink(
  pool: pg.Pool,
  token: string,
): Promise<{ orgId: string; linkId: string } | null> {
  if (!TOKEN_RE.test(token)) return null;
  // Chưa biết tổ chức nên context trống; hàm SECURITY DEFINER chỉ trả org_id và id link.
  const rows = await withTenant(pool, {}, (tx) =>
    tx.execute<{ org_id: string; link_id: string }>(
      sql`select org_id, link_id from hive.artifact_public_link_resolve(${sha256(token)})`,
    ),
  );
  const row = rows.rows[0];
  return row ? { orgId: row.org_id, linkId: row.link_id } : null;
}

export interface PublicTarget {
  linkId: string;
  artifactId: string;
  title: string;
  type: ArtifactType;
  version: number;
  expiresAt: Date;
  content: string;
  compiled: string | null;
  compileError: string | null;
}

/**
 * Link còn mở được không, kiểm lại mỗi lần phục vụ (trang và khung): link còn hạn, chưa thu hồi; artifact chưa vào thùng
 * rác; phiên bản còn nội dung; chủ còn trong tổ chức; tổ chức bật artifact và link công khai. Tắt chính sách không sửa
 * dòng nào (bật lại thì link chạy lại), nên phải kiểm ở đây (FR-142).
 */
export async function publicTarget(tx: Tx, linkId: string): Promise<PublicTarget | null> {
  const found = await linkById(tx, linkId);
  if (!found?.active) return null;
  const [a] = await tx.select().from(artifacts).where(eq(artifacts.id, found.row.artifactId));
  if (!a || a.deletedAt) return null;
  const policy = await artifactPolicyOf(tx);
  if (!policy.enabled || !policy.publicLinks.enabled) return null;
  // Chủ rời tổ chức thì job hằng giờ mới đặt `revoked_at`; không để link sống thêm trong khoảng đó.
  if (!(await orgRoleOf(tx, a.ownerUserId))) return null;
  const v = await versionRow(tx, a.id, found.row.version);
  if (!v || v.tombstonedAt || v.content === null) return null;
  return {
    linkId: found.row.id,
    artifactId: a.id,
    title: a.title,
    type: a.type,
    version: v.version,
    expiresAt: found.row.expiresAt,
    content: v.content,
    compiled: v.compiled,
    compileError: v.compileError,
  };
}

/** Cập nhật lượt xem ngay trong transaction phục vụ khung: đếm bền, không phụ thuộc bộ gộp audit trong bộ nhớ. */
export async function countView(tx: Tx, linkId: string): Promise<void> {
  await tx
    .update(artifactPublicLinks)
    .set({ viewCount: sql`${artifactPublicLinks.viewCount} + 1`, lastViewedAt: sql`now()` })
    .where(eq(artifactPublicLinks.id, linkId));
}

// ---- Audit lượt xem gộp theo giờ -----------------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Giữ tối đa chừng này IP băm mỗi dòng audit; đủ để thấy một link bị nhiều nơi mở, không phình dòng audit. */
const MAX_IP_HASHES = 50;

interface ViewBucket {
  orgId: string;
  linkId: string;
  artifactId: string;
  version: number;
  hour: number;
  views: number;
  ips: Set<string>;
}

/**
 * Audit `artifact.public_link.view` gộp tối đa một dòng mỗi link mỗi giờ (FR-146). Bảng audit chỉ cho chèn, nên lượt xem
 * gộp trong bộ nhớ rồi ghi khi hết giờ; hub tắt giữa giờ thì mất phần audit của giờ đó, còn `view_count` đã ghi bền.
 * IP băm bằng muối đổi mỗi ngày và không ra khỏi tiến trình: cùng ngày thì đếm được số nơi mở, qua ngày không nối lại được.
 */
export class PublicViewLog {
  private readonly buckets = new Map<string, ViewBucket>();
  private salt = randomBytes(32);
  private saltDay = -1;

  hashIp(ip: string, now = Date.now()): string {
    const day = Math.floor(now / DAY_MS);
    if (day !== this.saltDay) {
      this.salt = randomBytes(32);
      this.saltDay = day;
    }
    return createHmac("sha256", this.salt).update(ip).digest("hex").slice(0, 32);
  }

  record(
    view: { orgId: string; linkId: string; artifactId: string; version: number; ip: string },
    now = Date.now(),
  ): void {
    const hour = now - (now % HOUR_MS);
    const key = `${view.linkId}:${hour}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { ...view, hour, views: 0, ips: new Set() };
      this.buckets.set(key, bucket);
    }
    bucket.views += 1;
    if (bucket.ips.size < MAX_IP_HASHES) bucket.ips.add(this.hashIp(view.ip, now));
  }

  get pending(): number {
    return this.buckets.size;
  }

  /** Ghi các giờ đã qua (hoặc mọi giờ khi `all`); lỗi ghi thì bỏ giờ đó, không để audit hỏng làm hỏng việc xem. */
  async flush(pool: pg.Pool, opts: { now?: number; all?: boolean } = {}): Promise<number> {
    const now = opts.now ?? Date.now();
    const current = now - (now % HOUR_MS);
    const due = [...this.buckets].filter(([, b]) => opts.all || b.hour < current);
    for (const [key] of due) this.buckets.delete(key);
    let written = 0;
    for (const [, b] of due) {
      try {
        await withTenant(pool, { orgId: b.orgId }, (tx) =>
          recordAudit(tx, {
            action: "artifact.public_link.view",
            actorUserId: null,
            targetType: "artifact",
            targetId: b.artifactId,
            data: {
              linkId: b.linkId,
              version: b.version,
              hour: new Date(b.hour).toISOString(),
              views: b.views,
              visitors: b.ips.size,
              ipHashes: [...b.ips],
            },
          }),
        );
        written++;
      } catch (error) {
        console.error("Không ghi được audit artifact.public_link.view:", error);
      }
    }
    return written;
  }
}
