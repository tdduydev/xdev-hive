import { sql } from "drizzle-orm";
import type pg from "pg";
import { type Jobs, withTenant } from "../platform/index.ts";

export const RUN_LOG_RETENTION_QUEUE = "runs-log-retention";
export const runLogRetentionQueue = {
  name: RUN_LOG_RETENTION_QUEUE,
  // Lần chạy sau xoá nốt phần còn sót, nên không chồng nhiều lần chạy.
  policy: "singleton",
  retryLimit: 3,
  retryDelay: 300,
} as const;
/** Mỗi ngày một lần, giờ ít người dùng (UTC). */
export const RUN_LOG_RETENTION_CRON = "41 19 * * *";

/** Xoá log run quá số ngày giữ log của từng tổ chức (Chính sách agent, mặc định 365 ngày). Trả số đoạn log đã xoá. */
export async function purgeRunLogs(pool: pg.Pool): Promise<number> {
  return withTenant(pool, {}, async (tx) => {
    const { rows } = await tx.execute<{ purged: string }>(sql`select hive.purge_run_logs() as purged`);
    return Number(rows[0]?.purged ?? 0);
  });
}

/**
 * Bản ghi phiên terminal theo cùng số ngày giữ log (specs/010). Gọi hàm SQL thay vì import module terminal vì job này
 * không có tổ chức trong context, chỉ hàm SECURITY DEFINER xoá được.
 */
export async function purgeTerminalChunks(pool: pg.Pool): Promise<number> {
  return withTenant(pool, {}, async (tx) => {
    const { rows } = await tx.execute<{ purged: string }>(sql`select hive.purge_terminal_chunks() as purged`);
    return Number(rows[0]?.purged ?? 0);
  });
}

export async function registerRunLogRetentionWorker(jobs: Jobs, pool: pg.Pool): Promise<void> {
  await jobs.work(RUN_LOG_RETENTION_QUEUE, async () => {
    const purged = await purgeRunLogs(pool);
    if (purged > 0) console.info(`Đã xoá ${purged} đoạn log run quá hạn giữ.`);
    const chunks = await purgeTerminalChunks(pool);
    if (chunks > 0) console.info(`Đã xoá ${chunks} đoạn bản ghi terminal quá hạn giữ.`);
  });
  await jobs.schedule(RUN_LOG_RETENTION_QUEUE, RUN_LOG_RETENTION_CRON);
}
