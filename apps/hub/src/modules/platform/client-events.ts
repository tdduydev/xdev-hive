import type { ClientEventResult, ClientSource } from "@xdev-hive/contracts";
import { and, eq, sql } from "drizzle-orm";
import type pg from "pg";
import { type TenantContext, type Tx, withTenant } from "./db.ts";
import type { Jobs } from "./jobs.ts";
import { clientEvents } from "./schema.ts";

/** Thông tin của một lần ghi từ client (specs/027 FR-001). Danh tính (máy, người) do lớp xác thực điền, không lấy từ body. */
export interface ClientEventMeta {
  key: string;
  source: ClientSource;
  kind: string;
  machineId?: string | undefined;
  userId?: string | undefined;
  targetType?: string | undefined;
  targetId?: string | undefined;
  clientCreatedAt?: Date | undefined;
}

/**
 * Hub không nhận lần ghi vì trạng thái hiện tại (specs/027 FR-003). Khác lỗi tạm: client không gửi lại mà hiện lý do cho
 * người dùng. `code` ổn định để client phân biệt.
 */
export class ClientEventRejected extends Error {
  override readonly name = "ClientEventRejected";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ClientEventOutcome<T> extends ClientEventResult {
  /** Kết quả của lần ghi; với `duplicate` là kết quả đã lưu của lần đầu. */
  response: T | null;
}

/**
 * Chạy lần ghi `fn` đúng một lần cho mỗi khoá (specs/027 R1). Dòng `client_events` được chèn trước, trong cùng
 * transaction với `fn`: hai lần gửi cùng lúc thì lần sau chờ khoá dòng rồi thấy dòng đã có, nên `fn` không chạy hai lần.
 * `fn` ném `ClientEventRejected` thì transaction rollback rồi ghi lần từ chối ở transaction riêng, để gửi lại cùng khoá
 * nhận đúng lần từ chối đó thay vì chạy lại ở trạng thái đã khác. Lỗi khác (database, lập trình) ném ra như thường.
 */
export async function withClientEvent<T>(
  pool: pg.Pool,
  ctx: TenantContext & { orgId: string },
  meta: ClientEventMeta,
  fn: (tx: Tx) => Promise<T>,
): Promise<ClientEventOutcome<T>> {
  const values = {
    orgId: ctx.orgId,
    idempotencyKey: meta.key,
    source: meta.source,
    kind: meta.kind,
    machineId: meta.machineId ?? null,
    userId: meta.userId ?? null,
    targetType: meta.targetType ?? null,
    targetId: meta.targetId ?? null,
    clientCreatedAt: meta.clientCreatedAt ?? null,
  };
  let rejected: ClientEventRejected | null = null;
  const done = await withTenant(pool, ctx, async (tx) => {
    const [row] = await tx
      .insert(clientEvents)
      .values({ ...values, outcome: "accepted" })
      .onConflictDoNothing()
      .returning({ id: clientEvents.id, receivedAt: clientEvents.receivedAt });
    if (!row) return duplicateOf<T>(tx, ctx.orgId, meta.key);
    let response: T;
    try {
      response = await fn(tx);
    } catch (error) {
      if (!(error instanceof ClientEventRejected)) throw error;
      rejected = error;
      // Ném lại để withTenant rollback cả dòng vừa chèn lẫn phần fn đã ghi.
      throw error;
    }
    await tx
      .update(clientEvents)
      .set({ response: response === undefined ? null : (response as object) })
      .where(eq(clientEvents.id, row.id));
    return { key: meta.key, outcome: "accepted", receivedAt: row.receivedAt.toISOString(), response } as const;
  }).catch((error: unknown) => {
    if (error === rejected && rejected) return null;
    throw error;
  });
  if (done) return done;
  const reason = rejected as ClientEventRejected | null;
  if (!reason) throw new Error("Không ghi được sự kiện client.");
  return withTenant(pool, ctx, async (tx) => {
    const [row] = await tx
      .insert(clientEvents)
      .values({ ...values, outcome: "rejected", reasonCode: reason.code, reason: reason.message.slice(0, 500) })
      .onConflictDoNothing()
      .returning({ receivedAt: clientEvents.receivedAt });
    // Một lần gửi khác cùng khoá vừa ghi trước: trả theo dòng đó.
    if (!row) return duplicateOf<T>(tx, ctx.orgId, meta.key);
    return {
      key: meta.key,
      outcome: "rejected",
      code: reason.code,
      reason: reason.message.slice(0, 500),
      receivedAt: row.receivedAt.toISOString(),
      response: null,
    } as const;
  });
}

async function duplicateOf<T>(tx: Tx, orgId: string, key: string): Promise<ClientEventOutcome<T>> {
  const [prev] = await tx
    .select()
    .from(clientEvents)
    .where(and(eq(clientEvents.orgId, orgId), eq(clientEvents.idempotencyKey, key)));
  if (!prev) throw new Error("Sự kiện client vừa trùng khoá nhưng không đọc lại được.");
  return {
    key,
    outcome: "duplicate",
    ...(prev.outcome === "rejected" ? { code: prev.reasonCode ?? undefined, reason: prev.reason ?? undefined } : {}),
    receivedAt: prev.receivedAt.toISOString(),
    response: (prev.response as T | null) ?? null,
  };
}

/** Xoá sự kiện client quá 30 ngày (hàm SQL SECURITY DEFINER vì job không có tổ chức trong context). */
export async function purgeClientEvents(pool: pg.Pool): Promise<number> {
  return withTenant(pool, {}, async (tx) => {
    const { rows } = await tx.execute<{ purged: string }>(sql`select hive.purge_client_events() as purged`);
    return Number(rows[0]?.purged ?? 0);
  });
}

export const CLIENT_EVENT_RETENTION_QUEUE = "client-event-retention";
export const clientEventRetentionQueue = {
  name: CLIENT_EVENT_RETENTION_QUEUE,
  policy: "singleton",
  retryLimit: 3,
  retryDelay: 300,
} as const;
/** Mỗi ngày một lần, giờ ít người dùng (UTC), lệch giờ với các job dọn khác. */
export const CLIENT_EVENT_RETENTION_CRON = "47 19 * * *";

export async function registerClientEventRetentionWorker(jobs: Jobs, pool: pg.Pool): Promise<void> {
  await jobs.work(CLIENT_EVENT_RETENTION_QUEUE, async () => {
    const purged = await purgeClientEvents(pool);
    if (purged > 0) console.info(`Đã xoá ${purged} sự kiện client quá 30 ngày.`);
  });
  await jobs.schedule(CLIENT_EVENT_RETENTION_QUEUE, CLIENT_EVENT_RETENTION_CRON);
}
