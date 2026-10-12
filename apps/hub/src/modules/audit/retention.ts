import { AUDIT_RETENTION_DEFAULT_DAYS, type AuditRetention, type AuditRetentionInput } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { type Jobs, type Tx, withTenant } from "../platform/index.ts";
import { recordAudit } from "./record.ts";
import { auditSettings } from "./schema.ts";

export const AUDIT_RETENTION_QUEUE = "audit-retention";
export const auditRetentionQueue = {
  name: AUDIT_RETENTION_QUEUE,
  // Lần chạy sau xoá nốt phần còn sót, nên không cần chồng nhiều lần chạy hay thử lại dồn dập.
  policy: "singleton",
  retryLimit: 3,
  retryDelay: 300,
} as const;
/** Mỗi ngày một lần, giờ ít người dùng (UTC), lệch giờ với job dọn tài khoản. */
export const AUDIT_RETENTION_CRON = "41 20 * * *";

/** Thời hạn lưu của tổ chức trong context; chưa cấu hình thì là mặc định. */
export async function getAuditRetention(tx: Tx): Promise<AuditRetention> {
  const [row] = await tx.select().from(auditSettings);
  return row
    ? { retentionDays: row.retentionDays, updatedAt: row.updatedAt.toISOString() }
    : { retentionDays: AUDIT_RETENTION_DEFAULT_DAYS, updatedAt: null };
}

/**
 * Đổi thời hạn lưu và ghi audit kèm giá trị trước/sau trong cùng transaction. Giá trị dưới sàn bị hợp đồng API và CHECK
 * của bảng chặn. Quyền do nơi gọi kiểm (composition root), vì audit không được phụ thuộc tenancy.
 */
export async function setAuditRetention(tx: Tx, input: AuditRetentionInput): Promise<AuditRetention> {
  // Hai lần đổi cùng lúc phải nối đuôi nhau để giá trị "trước" trong audit đúng, kể cả khi tổ chức chưa có dòng nào.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('audit:retention:' || hive.ctx_org()::text, 0))`);
  const before = await getAuditRetention(tx);
  if (before.retentionDays === input.retentionDays) return before;
  const [row] = await tx
    .insert(auditSettings)
    .values({ orgId: sql`hive.ctx_org()`, retentionDays: input.retentionDays, updatedBy: sql`hive.ctx_user()` })
    .onConflictDoUpdate({
      target: auditSettings.orgId,
      set: { retentionDays: input.retentionDays, updatedBy: sql`hive.ctx_user()`, updatedAt: sql`now()` },
    })
    .returning();
  if (!row) throw new Error("Không lưu được thời hạn lưu nhật ký.");
  await recordAudit(tx, {
    action: "audit.retention.update",
    targetType: "audit_settings",
    data: { before: { retentionDays: before.retentionDays }, after: { retentionDays: row.retentionDays } },
  });
  return { retentionDays: row.retentionDays, updatedAt: row.updatedAt.toISOString() };
}

/**
 * Xoá nhật ký quá thời hạn lưu của mọi tổ chức (hive.purge_expired_audit_log). Hàm trong database tự quyết dòng nào hết
 * hạn và ghi audit.purge cho từng tổ chức; chạy lại bao nhiêu lần cũng được. Trả số dòng đã xoá.
 */
export async function purgeExpiredAudit(pool: pg.Pool): Promise<number> {
  return withTenant(pool, {}, async (tx) => {
    const { rows } = await tx.execute<{ purged: number }>(sql`select hive.purge_expired_audit_log() as purged`);
    return Number(rows[0]?.purged ?? 0);
  });
}

export async function registerAuditRetentionWorker(
  jobs: Jobs,
  deps: { pool: pg.Pool },
  opts: { pollingIntervalSeconds?: number } = {},
): Promise<void> {
  await jobs.work(
    AUDIT_RETENTION_QUEUE,
    async () => {
      const purged = await purgeExpiredAudit(deps.pool);
      if (purged > 0) console.info(`Đã xoá ${purged} dòng nhật ký quá thời hạn lưu.`);
    },
    opts,
  );
  await jobs.schedule(AUDIT_RETENTION_QUEUE, AUDIT_RETENTION_CRON);
}
