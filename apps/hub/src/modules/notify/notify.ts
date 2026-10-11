import type { NotificationEvent } from "@xdev-hive/contracts";
import { and, asc, eq, sql } from "drizzle-orm";
import type pg from "pg";
import { type Jobs, type MasterKey, type Tx, withTenant } from "../platform/index.ts";
import { decryptConfig } from "./channels.ts";
import { notificationChannels, notifications } from "./schema.ts";
import { DeliveryError, type SendDeps, send } from "./send.ts";

export const NOTIFY_QUEUE = "notify.deliver";

/** Số lần gửi tối đa của một thông báo: lần đầu và 4 lần thử lại, cách nhau 30 giây rồi gấp đôi. */
export const MAX_ATTEMPTS = 5;

export const notifyQueue = {
  name: NOTIFY_QUEUE,
  retryLimit: MAX_ATTEMPTS - 1,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 120,
} as const;

export interface NotifyJob {
  orgId: string;
  notificationId: string;
}

export interface NotifyInput {
  orgId: string;
  event: NotificationEvent;
  title: string;
  body: string;
  /** Đường dẫn tới trang liên quan trên web Hive; chỉ nhận http(s). */
  link?: string | null | undefined;
}

export interface NotifyOptions {
  /** Không có thì thông báo nằm ở queued tới khi deliverPending chạy. */
  jobs?: Jobs | undefined;
}

const TITLE_MAX = 200;
const BODY_MAX = 10_000;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Link lạ (javascript:, data:) không được vào tin nhắn hay email. */
function safeLink(link: string | null | undefined): string | null {
  if (!link) return null;
  try {
    const u = new URL(link);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Gửi sự kiện cho nhóm quản trị: một dòng notifications cho mỗi kênh đang bật nhận loại sự kiện này, ghi trong cùng
 * transaction của nghiệp vụ. Job gửi chỉ thành hình khi transaction commit, nên nghiệp vụ rollback thì không ai nhận
 * thông báo về việc không xảy ra. Trả id các dòng đã ghi.
 */
export async function notify(tx: Tx, input: NotifyInput, opts: NotifyOptions = {}): Promise<string[]> {
  const channels = await tx
    .select({ id: notificationChannels.id })
    .from(notificationChannels)
    .where(
      and(eq(notificationChannels.enabled, true), sql`${notificationChannels.events} @> array[${input.event}]::text[]`),
    );
  if (channels.length === 0) return [];
  const rows = await tx
    .insert(notifications)
    .values(
      channels.map((c) => ({
        orgId: input.orgId,
        channelId: c.id,
        event: input.event,
        title: clip(input.title.trim(), TITLE_MAX),
        body: clip(input.body.trim(), BODY_MAX),
        link: safeLink(input.link),
      })),
    )
    .returning({ id: notifications.id });
  if (opts.jobs) {
    for (const r of rows) {
      await opts.jobs.enqueue(NOTIFY_QUEUE, { orgId: input.orgId, notificationId: r.id } satisfies NotifyJob, { tx });
    }
  }
  return rows.map((r) => r.id);
}

export interface DeliverDeps extends SendDeps {
  pool: pg.Pool;
  masterKey?: MasterKey | undefined;
}

export type DeliverOutcome = "sent" | "failed" | "retry" | "skipped";

/**
 * Gửi một thông báo. Đọc và ghi trạng thái trong hai transaction ngắn, còn gọi ra Telegram/SMTP thì ở giữa, ngoài
 * transaction. `retry`: lỗi tạm thời và còn lượt; người gọi (job) ném lỗi để pg-boss thử lại sau.
 */
export async function deliverNotification(
  deps: DeliverDeps,
  job: NotifyJob,
  logger: Pick<Console, "warn"> = console,
): Promise<DeliverOutcome> {
  const loaded = await withTenant(deps.pool, { orgId: job.orgId }, async (tx) => {
    const [row] = await tx
      .select({
        status: notifications.status,
        attempts: notifications.attempts,
        title: notifications.title,
        body: notifications.body,
        link: notifications.link,
        channelId: notificationChannels.id,
        enabled: notificationChannels.enabled,
        configEnc: notificationChannels.configEnc,
      })
      .from(notifications)
      .innerJoin(notificationChannels, eq(notificationChannels.id, notifications.channelId))
      .where(eq(notifications.id, job.notificationId));
    return row ?? null;
  });
  // Đã gửi hoặc đã bỏ (job chạy lại sau khi tiến trình chết giữa chừng), hoặc kênh đã bị xoá cùng dòng này.
  if (loaded?.status !== "queued") return "skipped";

  let error: DeliveryError | null = null;
  if (!loaded.enabled) error = new DeliveryError("Kênh đã tắt trước khi gửi.", true);
  else if (!deps.masterKey)
    error = new DeliveryError("Hub chưa cấu hình HIVE_MASTER_KEY nên không đọc được kênh.", true);
  else {
    try {
      const config = decryptConfig(deps.masterKey, loaded.channelId, loaded.configEnc);
      await send(config, { title: loaded.title, body: loaded.body, link: loaded.link }, deps);
    } catch (e) {
      error = e instanceof DeliveryError ? e : new DeliveryError(e instanceof Error ? e.message : String(e), false);
    }
  }

  const attempts = loaded.attempts + 1;
  const outcome: DeliverOutcome = !error ? "sent" : error.permanent || attempts >= MAX_ATTEMPTS ? "failed" : "retry";
  await withTenant(deps.pool, { orgId: job.orgId }, (tx) =>
    tx
      .update(notifications)
      .set({
        attempts,
        error: error?.message ?? null,
        ...(outcome === "sent" ? { status: "sent" as const, sentAt: sql`now()` } : {}),
        ...(outcome === "failed" ? { status: "failed" as const } : {}),
      })
      .where(and(eq(notifications.id, job.notificationId), eq(notifications.status, "queued"))),
  );
  if (outcome === "failed") logger.warn(`Bỏ thông báo ${job.notificationId} sau ${attempts} lần: ${error?.message}`);
  return outcome;
}

/**
 * Gửi mọi thông báo còn queued của một tổ chức, mỗi cái một lần. Dùng khi hub chạy không có hàng đợi, hoặc để gửi
 * lại tay; đường thường là job notify.deliver.
 */
export async function deliverPending(
  deps: DeliverDeps,
  orgId: string,
  logger: Pick<Console, "warn"> = console,
): Promise<Record<DeliverOutcome, number>> {
  const ids = await withTenant(deps.pool, { orgId }, (tx) =>
    tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.status, "queued"))
      .orderBy(asc(notifications.createdAt)),
  );
  const counts: Record<DeliverOutcome, number> = { sent: 0, failed: 0, retry: 0, skipped: 0 };
  for (const { id } of ids) counts[await deliverNotification(deps, { orgId, notificationId: id }, logger)] += 1;
  return counts;
}

/** Đăng ký xử lý job notify.deliver ở tiến trình có vai trò `jobs`. */
export async function registerNotifyWorker(
  jobs: Jobs,
  deps: DeliverDeps,
  opts: { pollingIntervalSeconds?: number } = {},
): Promise<void> {
  await jobs.work<NotifyJob>(
    NOTIFY_QUEUE,
    async (job) => {
      const outcome = await deliverNotification(deps, job.data);
      if (outcome === "retry") throw new Error(`Chưa gửi được thông báo ${job.data.notificationId}, sẽ thử lại.`);
    },
    opts,
  );
}
