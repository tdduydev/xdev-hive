import { sql } from "drizzle-orm";
import type pg from "pg";
import { type Jobs, withTenant } from "../platform/index.ts";
import type { DeliveryDeps } from "./deps.ts";
import { DELIVERY_LOG_RETENTION_QUEUE } from "./queues.ts";

/** 03:17 UTC mỗi ngày, lệch khỏi đầu giờ để không đụng các job dọn khác. */
export const DELIVERY_LOG_RETENTION_CRON = "17 3 * * *";

/**
 * Xoá log triển khai quá hạn của mọi tổ chức qua `hive.purge_deploy_logs()` (SECURITY DEFINER, vì job không có tổ chức
 * trong context). Hạn giữ theo chính sách của từng tổ chức, ít nhất 30 ngày. Chạy lại bao nhiêu lần cũng được; trả số
 * dòng đã xoá.
 */
export async function purgeDeployLogs(pool: pg.Pool): Promise<number> {
  return withTenant(pool, {}, async (tx) => {
    const { rows } = await tx.execute<{ purged: string | number }>(sql`select hive.purge_deploy_logs() as purged`);
    return Number(rows[0]?.purged ?? 0);
  });
}

/**
 * Không có pool thì không có gì để dọn (hub chạy không database, hoặc test dựng khung): bỏ qua thay vì ném lỗi lúc khởi
 * động.
 */
export async function registerRetention(
  jobs: Jobs,
  deps: DeliveryDeps,
  opts: { pollingIntervalSeconds?: number } = {},
): Promise<void> {
  const { pool } = deps;
  if (!pool) return;
  await jobs.work(
    DELIVERY_LOG_RETENTION_QUEUE,
    async () => {
      const purged = await purgeDeployLogs(pool);
      if (purged > 0) console.info(`Đã xoá ${purged} đoạn log triển khai quá hạn.`);
    },
    opts,
  );
  await jobs.schedule(DELIVERY_LOG_RETENTION_QUEUE, DELIVERY_LOG_RETENTION_CRON);
}
