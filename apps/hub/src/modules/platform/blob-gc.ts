import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type pg from "pg";
import { type Tx, withTenant } from "./db.ts";
import { BadRequestError } from "./errors.ts";
import type { Jobs } from "./jobs.ts";
import { blobs } from "./schema.ts";

export const BLOB_GC_QUEUE = "platform-blob-gc";
export const BLOB_GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
export type BlobRefs = (tx: Tx, ids: string[]) => Promise<ReadonlySet<string>>;
const refs = new Map<string, BlobRefs>();

export async function lockBlobStorage(tx: Tx, orgId: string): Promise<void> {
  const { rows } = await tx.execute<{ org_id: string | null }>(sql`select hive.ctx_org() as org_id`);
  if (rows[0]?.org_id !== orgId)
    throw new BadRequestError("BLOB_TENANT_REQUIRED", "Kho file cần đúng ngữ cảnh tổ chức.");
  // Cùng khoá cho tải lên và dọn rác: hạn mức và tham chiếu mới không đua với nhau.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`blob-storage:${orgId}`}, 0))`);
}

export function provideBlobRefs(name: string, provider: BlobRefs): () => void {
  refs.set(name, provider);
  return () => {
    if (refs.get(name) === provider) refs.delete(name);
  };
}

/** Composition root khai báo bảng tham chiếu, platform không phụ thuộc module sở hữu bảng. */
export function blobRefsIn(table: string, column = "blob_id"): BlobRefs {
  return async (tx, ids) => {
    if (!ids.length) return new Set();
    const { rows } = await tx.execute<{ id: string }>(
      sql`select distinct ${sql.identifier(column)} as id from ${sql.identifier("hive")}.${sql.identifier(table)} where ${sql.identifier(column)} in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
    );
    return new Set(rows.map((row) => row.id));
  };
}

export async function collectBlobs(
  tx: Tx,
  orgId: string,
  before = new Date(Date.now() - BLOB_GC_INTERVAL_MS),
): Promise<number> {
  // Chưa có module đăng ký thì chưa đủ bằng chứng rằng file không còn dùng.
  if (!refs.size) return 0;
  await lockBlobStorage(tx, orgId);
  let cursor: string | undefined;
  let removed = 0;
  for (;;) {
    const candidates = await tx
      .select({ id: blobs.id })
      .from(blobs)
      .where(and(eq(blobs.orgId, orgId), lt(blobs.createdAt, before), cursor ? gt(blobs.id, cursor) : undefined))
      .orderBy(asc(blobs.id))
      .limit(200)
      // File đang đọc hoặc đang được gắn tham chiếu có thể chờ lần dọn sau, tránh đảo thứ tự khoá với tải lên.
      .for("update", { skipLocked: true });
    if (!candidates.length) return removed;
    const ids = candidates.map((row) => row.id);
    const used = new Set<string>();
    for (const provider of refs.values()) for (const id of await provider(tx, ids)) used.add(id);
    const unused = ids.filter((id) => !used.has(id));
    if (unused.length)
      removed += (
        await tx
          .delete(blobs)
          .where(and(eq(blobs.orgId, orgId), inArray(blobs.id, unused)))
          .returning({ id: blobs.id })
      ).length;
    cursor = ids.at(-1);
  }
}

export async function queueBlobGc(jobs: Jobs, orgId: string, tx: Tx): Promise<string | null> {
  await lockBlobStorage(tx, orgId);
  // Queue singleton chỉ giới hạn job đang chạy, nên tự giữ tối đa một job chờ cho mỗi tổ chức.
  const { rows } = await tx.execute(
    sql`select id from pgboss.job where name = ${BLOB_GC_QUEUE} and singleton_key = ${orgId} and state in ('created', 'retry') limit 1`,
  );
  if (rows.length) return null;
  return jobs.enqueue(
    BLOB_GC_QUEUE,
    { orgId },
    { tx, singletonKey: orgId, startAfter: new Date(Date.now() + BLOB_GC_INTERVAL_MS) },
  );
}

/** Chuỗi job mang tenant, nên không cần quyền liệt kê dữ liệu xuyên tổ chức để chạy hằng ngày. */
export async function registerBlobGc(jobs: Jobs, deps: { pool: pg.Pool }): Promise<void> {
  await jobs.work<{ orgId: string }>(BLOB_GC_QUEUE, async ({ data }) => {
    await withTenant(deps.pool, { orgId: data.orgId }, async (tx) => {
      await collectBlobs(tx, data.orgId);
      await queueBlobGc(jobs, data.orgId, tx);
    });
  });
}
