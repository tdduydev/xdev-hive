import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { type Jobs, type Tx, withTenant } from "../platform/index.ts";
import { orgRoleOf } from "../tenancy/index.ts";
import { allLinkTargets } from "./hooks.ts";
import { artifactLinks, artifactPublicLinks, artifacts } from "./schema.ts";
import { type ArtifactDeps, revokePublicLinks } from "./versions.ts";

/*
 * Dọn artifact (plan.md D11, D14, D21): thùng rác quá 30 ngày, bản xem trước hết hạn, link công khai hết hạn quá 90 ngày
 * (hàm `hive.artifact_purge`, SECURITY DEFINER vì job không có tổ chức trong context); rồi theo từng tổ chức: liên kết
 * tới đích đã mất và link công khai của chủ đã rời tổ chức.
 */

export const ARTIFACT_PURGE_QUEUE = "artifact-purge";
export const artifactPurgeQueue = {
  name: ARTIFACT_PURGE_QUEUE,
  // Lần chạy sau làm nốt phần sót, nên không chồng nhiều lần chạy.
  policy: "singleton",
  retryLimit: 3,
  retryDelay: 300,
} as const;
/** Mỗi giờ: bản xem trước chỉ sống 10 phút nên không để tới cả ngày; phần còn lại chạy lại không tốn gì. */
export const ARTIFACT_PURGE_CRON = "23 * * * *";

export interface PurgeResult {
  artifacts: number;
  previews: number;
  publicLinks: number;
  orphanLinks: number;
  ownerLeftLinks: number;
}

/** Liên kết tới đích đã mất của tổ chức trong context. Loại đích chưa có module cài `existing` thì không đụng. */
export async function purgeOrphanLinks(tx: Tx): Promise<number> {
  let removed = 0;
  for (const target of allLinkTargets()) {
    if (!target.existing) continue;
    const rows = await tx
      .selectDistinct({ id: artifactLinks.targetId })
      .from(artifactLinks)
      .where(eq(artifactLinks.targetKind, target.kind));
    if (rows.length === 0) continue;
    const alive = await target.existing(
      tx,
      rows.map((r) => r.id),
    );
    const gone = rows.map((r) => r.id).filter((id) => !alive.has(id));
    if (gone.length === 0) continue;
    const deleted = await tx
      .delete(artifactLinks)
      .where(and(eq(artifactLinks.targetKind, target.kind), inArray(artifactLinks.targetId, gone)))
      .returning({ id: artifactLinks.artifactId });
    removed += deleted.length;
  }
  return removed;
}

/**
 * Link công khai do chủ đã rời tổ chức tạo hết hiệu lực (D21 `owner_left`). Tenancy không biết artifact nên không có
 * sự kiện "rời tổ chức" gửi tới đây; job quét lại mỗi lần chạy, còn trang link công khai (T015) kiểm chủ khi phục vụ.
 */
export async function revokeOwnerLeftLinks(tx: Tx, deps: ArtifactDeps = {}): Promise<number> {
  const rows = await tx
    .selectDistinct({
      artifact: {
        id: artifacts.id,
        orgId: artifacts.orgId,
        ownerUserId: artifacts.ownerUserId,
        title: artifacts.title,
      },
    })
    .from(artifactPublicLinks)
    .innerJoin(artifacts, eq(artifacts.id, artifactPublicLinks.artifactId))
    .where(and(isNull(artifactPublicLinks.revokedAt), sql`${artifactPublicLinks.expiresAt} > now()`));
  const active = new Map<string, boolean>();
  let revoked = 0;
  for (const { artifact } of rows) {
    let ownerActive = active.get(artifact.ownerUserId);
    if (ownerActive === undefined) {
      ownerActive = (await orgRoleOf(tx, artifact.ownerUserId)) !== null;
      active.set(artifact.ownerUserId, ownerActive);
    }
    if (ownerActive) continue;
    revoked += await revokePublicLinks(
      tx,
      null,
      artifact,
      eq(artifactPublicLinks.artifactId, artifact.id),
      "owner_left",
      deps,
    );
  }
  return revoked;
}

export async function purgeArtifacts(pool: pg.Pool, deps: ArtifactDeps = {}): Promise<PurgeResult> {
  const result: PurgeResult = { artifacts: 0, previews: 0, publicLinks: 0, orphanLinks: 0, ownerLeftLinks: 0 };
  const purged = await withTenant(pool, {}, async (tx) => {
    const { rows } = await tx.execute<{ org_id: string; artifacts: number; previews: number; public_links: number }>(
      sql`select * from hive.artifact_purge()`,
    );
    return rows;
  });
  for (const row of purged) {
    result.artifacts += row.artifacts;
    result.previews += row.previews;
    result.publicLinks += row.public_links;
    // Bản xem trước hết hạn là rác tạm, không cần dấu vết; artifact và link thì ghi để quản trị biết vì sao mất.
    if (row.artifacts === 0 && row.public_links === 0) continue;
    await withTenant(pool, { orgId: row.org_id }, (tx) =>
      recordAudit(tx, {
        action: "artifact.purge",
        actorUserId: null,
        targetType: "org",
        data: { artifacts: row.artifacts, publicLinks: row.public_links },
      }),
    );
  }
  const orgs = await withTenant(pool, {}, async (tx) => {
    const { rows } = await tx.execute<{ org_id: string }>(sql`select org_id from hive.artifact_orgs()`);
    return rows.map((r) => r.org_id);
  });
  for (const orgId of orgs) {
    // Mỗi tổ chức một transaction: lỗi của một tổ chức (hook đích hỏng) không chặn phần còn lại.
    try {
      await withTenant(pool, { orgId }, async (tx) => {
        result.orphanLinks += await purgeOrphanLinks(tx);
        result.ownerLeftLinks += await revokeOwnerLeftLinks(tx, deps);
      });
    } catch (error) {
      console.error(`Dọn artifact của tổ chức ${orgId} lỗi:`, error);
    }
  }
  return result;
}

export async function registerArtifactPurgeWorker(
  jobs: Jobs,
  deps: { pool: pg.Pool; publicUrl?: string | undefined },
  opts: { pollingIntervalSeconds?: number } = {},
): Promise<void> {
  await jobs.work(
    ARTIFACT_PURGE_QUEUE,
    async () => {
      const r = await purgeArtifacts(deps.pool, { jobs, publicUrl: deps.publicUrl });
      if (r.artifacts + r.publicLinks + r.orphanLinks + r.ownerLeftLinks > 0)
        console.info(
          `Dọn artifact: ${r.artifacts} artifact, ${r.publicLinks} link hết hạn, ${r.orphanLinks} liên kết mồ côi, ${r.ownerLeftLinks} link của người đã rời tổ chức.`,
        );
    },
    opts,
  );
  await jobs.schedule(ARTIFACT_PURGE_QUEUE, ARTIFACT_PURGE_CRON);
}
