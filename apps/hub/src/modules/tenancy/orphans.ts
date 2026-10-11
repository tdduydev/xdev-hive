import { sql } from "drizzle-orm";
import type pg from "pg";
import { type Jobs, withTenant } from "../platform/index.ts";

export const ORPHAN_USERS_QUEUE = "tenancy-orphan-users";
export const orphanUsersQueue = {
  name: ORPHAN_USERS_QUEUE,
  // Lần chạy sau làm lại được hết phần còn sót, nên không cần chồng nhiều lần chạy hay thử lại dồn dập.
  policy: "singleton",
  retryLimit: 3,
  retryDelay: 300,
} as const;
/** Mỗi ngày một lần, giờ ít người dùng (UTC). */
export const ORPHAN_USERS_CRON = "17 20 * * *";

/**
 * Xoá tài khoản tạo quá 7 ngày mà không thuộc tổ chức nào và không có lời mời đang chờ (hive.purge_orphan_users).
 * Hub chỉ nhận người được mời nhưng vẫn có thể còn những tài khoản như vậy, vd. lời mời bị thu hồi sau khi tài khoản
 * GitHub/GitLab đã được tạo nhờ nó. Email trong keepEmails (HIVE_ORG_CREATORS) được giữ: người quản trị hub có thể chưa
 * tạo tổ chức. Chạy lại bao nhiêu lần cũng được; trả số tài khoản đã xoá.
 */
export async function purgeOrphanUsers(
  pool: pg.Pool,
  opts: { keepEmails?: string[] | undefined } = {},
): Promise<number> {
  const keep = (opts.keepEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  return withTenant(pool, {}, async (tx) => {
    const { rows } = await tx.execute<{ purged: number }>(
      sql`select hive.purge_orphan_users(array[${sql.join(
        keep.map((e) => sql`${e}`),
        sql`, `,
      )}]::text[]) as purged`,
    );
    return Number(rows[0]?.purged ?? 0);
  });
}

export async function registerOrphanUsersWorker(
  jobs: Jobs,
  deps: { pool: pg.Pool; keepEmails?: string[] | undefined },
  opts: { pollingIntervalSeconds?: number } = {},
): Promise<void> {
  await jobs.work(
    ORPHAN_USERS_QUEUE,
    async () => {
      const purged = await purgeOrphanUsers(deps.pool, { keepEmails: deps.keepEmails });
      if (purged > 0) console.info(`Đã xoá ${purged} tài khoản không thuộc tổ chức nào, không có lời mời đang chờ.`);
    },
    opts,
  );
  await jobs.schedule(ORPHAN_USERS_QUEUE, ORPHAN_USERS_CRON);
}
