import type { InboxItem, InboxListInput, NotificationEvent } from "@xdev-hive/contracts";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type pg from "pg";
import { type Jobs, type Tx, withTenant } from "../platform/index.ts";
import { inboxItems } from "./schema.ts";

export const INBOX_CLEANUP_QUEUE = "notify.inbox-cleanup";
export const inboxCleanupQueue = {
  name: INBOX_CLEANUP_QUEUE,
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 120,
} as const;

interface InboxCleanupJob {
  orgId: string;
  userId: string;
}

const ownInbox = () => and(eq(inboxItems.orgId, sql`hive.ctx_org()`), eq(inboxItems.userId, sql`hive.ctx_user()`));
const view = (row: typeof inboxItems.$inferSelect): InboxItem => ({
  id: row.id,
  event: row.event as NotificationEvent,
  title: row.title,
  body: row.body,
  link: row.link,
  createdAt: row.createdAt.toISOString(),
  readAt: row.readAt?.toISOString() ?? null,
});

export async function listInbox(tx: Tx, input: InboxListInput) {
  const cursor = input.cursor?.split("~");
  const rows = await tx
    .select()
    .from(inboxItems)
    .where(
      and(
        ownInbox(),
        input.unreadOnly ? isNull(inboxItems.readAt) : undefined,
        cursor
          ? sql`(${inboxItems.createdAt}, ${inboxItems.id}) < (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(inboxItems.createdAt), desc(inboxItems.id))
    .limit(input.limit + 1);
  const items = rows.slice(0, input.limit).map(view);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > input.limit && last ? `${last.createdAt}~${last.id}` : null,
  };
}

export async function unreadInboxCount(tx: Tx): Promise<{ count: number }> {
  const [row] = await tx
    .select({ count: count() })
    .from(inboxItems)
    .where(and(ownInbox(), isNull(inboxItems.readAt)));
  return { count: row?.count ?? 0 };
}

/** Không đổi read_at khi gọi lại: giữ đúng thời điểm đọc đầu tiên và hạn giữ 90 ngày. */
export async function markInboxRead(tx: Tx, ids?: string[], jobs?: Jobs): Promise<{ count: number }> {
  if (ids?.length === 0) return { count: 0 };
  const rows = await tx
    .update(inboxItems)
    .set({ readAt: sql`now()` })
    .where(and(ownInbox(), isNull(inboxItems.readAt), ids ? inArray(inboxItems.id, [...new Set(ids)]) : undefined))
    .returning({ orgId: inboxItems.orgId, userId: inboxItems.userId, readAt: inboxItems.readAt });
  const row = rows[0];
  // Job và dấu đã đọc cùng commit; không cần giữ pool hay hẹn giờ trong bộ nhớ suốt 90 ngày.
  if (jobs && row?.readAt) {
    await jobs.enqueue<InboxCleanupJob>(
      INBOX_CLEANUP_QUEUE,
      { orgId: row.orgId, userId: row.userId },
      {
        tx,
        startAfter: new Date(row.readAt.getTime() + 90 * 24 * 60 * 60 * 1000),
      },
    );
  }
  return { count: rows.length };
}

/** Chạy lại job chỉ xoá những mục còn đủ hạn; mục chưa đọc không hết hạn. */
export async function cleanupInbox(pool: pg.Pool, job: InboxCleanupJob): Promise<void> {
  await withTenant(pool, job, (tx) =>
    tx
      .delete(inboxItems)
      .where(and(ownInbox(), sql`${inboxItems.readAt} <= now() - interval '2160 hours'`))
      .then(() => {}),
  );
}

export async function registerInboxCleanupWorker(jobs: Jobs, pool: pg.Pool): Promise<void> {
  await jobs.work<InboxCleanupJob>(INBOX_CLEANUP_QUEUE, (job) => cleanupInbox(pool, job.data));
}
