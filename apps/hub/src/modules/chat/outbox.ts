import type { ChatAction, NotificationEvent } from "@xdev-hive/contracts";
import { chatAction } from "@xdev-hive/contracts";
import { and, eq, sql } from "drizzle-orm";
import { type Jobs, type Tx, withTenant } from "../platform/index.ts";
import { ChatSendError, type OutButton, type OutMessage, sendChat } from "./adapters.ts";
import { decryptBotConfig } from "./bots.ts";
import type { ChatDeps } from "./deps.ts";
import { CHAT_REPLY_MAX, forChat } from "./sanitize.ts";
import { chatBots, chatLinks, chatOutbox } from "./schema.ts";

export const CHAT_QUEUE = "chat.deliver";

/** Số lần gửi tối đa của một tin: lần đầu và 4 lần thử lại, cách nhau 30 giây rồi gấp đôi. */
export const CHAT_MAX_ATTEMPTS = 5;

export const chatQueue = {
  name: CHAT_QUEUE,
  retryLimit: CHAT_MAX_ATTEMPTS - 1,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 120,
} as const;

export interface ChatJob {
  orgId: string;
  outboxId: string;
}

/** Nút bấm hết hạn sau ngần này: đề xuất, kế hoạch đã cũ thì người dùng nên mở web xem lại. */
export const ACTION_TTL_MS = 7 * 24 * 3600 * 1000;

export const ACTION_LABEL: Record<ChatAction["kind"], string> = {
  "approval.approve": "Duyệt",
  "approval.reject": "Từ chối",
  "plan.approve": "Duyệt",
  "plan.reject": "Trả lại",
  "review.approve": "Duyệt",
  "review.changes": "Trả lại",
  "code_review.approve": "Duyệt code",
  "code_review.changes": "Trả lại code",
  "run.cancel": "Huỷ run",
};

export interface OutboxInput {
  kind: "notification" | "leader" | "command";
  event?: NotificationEvent | undefined;
  dedupeKey?: string | undefined;
  title?: string | undefined;
  body: string;
  url?: string | null | undefined;
  actions?: ChatAction[] | undefined;
}

type LinkRef = { id: string };

/** Chữ trong outbox đã che bí mật và bỏ code: dữ liệu nằm trong database cũng là dữ liệu đã làm sạch. */
function row(link: LinkRef, input: OutboxInput, status: "queued" | "sent") {
  return {
    orgId: sql`hive.ctx_org()`,
    linkId: link.id,
    kind: input.kind,
    event: input.event ?? null,
    dedupeKey: input.dedupeKey ?? null,
    title: forChat(input.title ?? "", 200),
    body: forChat(input.body, input.kind === "leader" ? CHAT_REPLY_MAX : undefined),
    url: input.url ?? null,
    actions: input.actions ?? [],
    status,
    ...(status === "sent" ? { sentAt: sql`now()` } : {}),
  };
}

/** Xếp một tin vào hàng gửi của một liên kết, cùng transaction với nghiệp vụ. Trả id, hoặc null nếu đã gửi rồi. */
export async function enqueueOutbox(
  tx: Tx,
  jobs: Jobs | undefined,
  orgId: string,
  link: LinkRef,
  input: OutboxInput,
): Promise<string | null> {
  const [inserted] = await tx
    .insert(chatOutbox)
    .values(row(link, input, "queued"))
    .onConflictDoNothing()
    .returning({
      id: chatOutbox.id,
    });
  if (!inserted) return null;
  if (jobs) await jobs.enqueue(CHAT_QUEUE, { orgId, outboxId: inserted.id } satisfies ChatJob, { tx });
  return inserted.id;
}

/** Lưu tin trả lời lệnh để nút của nó có chỗ nhớ hành động; tin này được gửi ngay nên ghi là đã gửi. */
export async function storeSent(tx: Tx, link: LinkRef, input: OutboxInput): Promise<string> {
  const [inserted] = await tx
    .insert(chatOutbox)
    .values(row(link, input, "sent"))
    .returning({ id: chatOutbox.id });
  if (!inserted) throw new Error("Không lưu được tin chat.");
  return inserted.id;
}

/**
 * Dựng tin gửi đi từ dòng outbox. Telegram từ chối nút URL không phải https (vd. hub chạy ở localhost khi dev) và
 * hỏng cả tin, nên với Telegram thì đưa URL đó vào chữ.
 */
export function toOutMessage(
  kind: "telegram" | "slack",
  r: { id: string; title: string; body: string; url: string | null; actions: ChatAction[] },
): OutMessage {
  const buttons: OutButton[] = r.actions.map((a, i) => ({ label: ACTION_LABEL[a.kind], callback: `o:${r.id}:${i}` }));
  let text = r.body;
  if (r.url) {
    if (kind === "slack" || r.url.startsWith("https://")) buttons.push({ label: "Mở trên web", url: r.url });
    else text = `${text}\n\n${r.url}`;
  }
  return { ...(r.title ? { title: r.title } : {}), text, ...(buttons.length ? { buttons } : {}) };
}

export type DeliverOutcome = "sent" | "failed" | "retry" | "skipped";

/**
 * Gửi một tin trong outbox. Đọc và ghi trạng thái trong hai transaction ngắn, còn gọi ra Telegram/Slack thì ở giữa,
 * ngoài transaction. `retry`: lỗi tạm thời và còn lượt; job ném lỗi để pg-boss thử lại sau.
 */
export async function deliverOutbox(
  deps: ChatDeps,
  job: ChatJob,
  logger: Pick<Console, "warn"> = console,
): Promise<DeliverOutcome> {
  const loaded = await withTenant(deps.pool, { orgId: job.orgId }, async (tx) => {
    const [r] = await tx
      .select({
        id: chatOutbox.id,
        status: chatOutbox.status,
        attempts: chatOutbox.attempts,
        title: chatOutbox.title,
        body: chatOutbox.body,
        url: chatOutbox.url,
        actions: chatOutbox.actions,
        chatId: chatLinks.chatId,
        enabled: chatBots.enabled,
        botId: chatBots.id,
        configEnc: chatBots.configEnc,
      })
      .from(chatOutbox)
      .innerJoin(chatLinks, and(eq(chatLinks.id, chatOutbox.linkId), eq(chatLinks.orgId, chatOutbox.orgId)))
      .innerJoin(chatBots, and(eq(chatBots.id, chatLinks.botId), eq(chatBots.orgId, chatLinks.orgId)))
      .where(eq(chatOutbox.id, job.outboxId));
    return r ?? null;
  });
  // Đã gửi hoặc đã bỏ (job chạy lại), hoặc liên kết/bot đã bị xoá cùng dòng này.
  if (loaded?.status !== "queued") return "skipped";

  let error: ChatSendError | null = null;
  if (!loaded.enabled) error = new ChatSendError("Bot đã tắt trước khi gửi.", true);
  else if (!deps.masterKey)
    error = new ChatSendError("Hub chưa cấu hình HIVE_MASTER_KEY nên không đọc được bot.", true);
  else {
    try {
      const config = decryptBotConfig(deps.masterKey, loaded.botId, loaded.configEnc);
      const actions = (loaded.actions as unknown[]).flatMap((a) => {
        const parsed = chatAction.safeParse(a);
        return parsed.success ? [parsed.data] : [];
      });
      await sendChat(config, loaded.chatId, toOutMessage(config.kind, { ...loaded, actions }), deps);
    } catch (e) {
      error = e instanceof ChatSendError ? e : new ChatSendError(e instanceof Error ? e.message : String(e), false);
    }
  }

  const attempts = loaded.attempts + 1;
  const outcome: DeliverOutcome = !error
    ? "sent"
    : error.permanent || attempts >= CHAT_MAX_ATTEMPTS
      ? "failed"
      : "retry";
  await withTenant(deps.pool, { orgId: job.orgId }, (tx) =>
    tx
      .update(chatOutbox)
      .set({
        attempts,
        error: error?.message ?? null,
        ...(outcome === "sent" ? { status: "sent" as const, sentAt: sql`now()` } : {}),
        ...(outcome === "failed" ? { status: "failed" as const } : {}),
      })
      .where(and(eq(chatOutbox.id, job.outboxId), eq(chatOutbox.status, "queued"))),
  );
  if (outcome === "failed") logger.warn(`Bỏ tin chat ${job.outboxId} sau ${attempts} lần: ${error?.message}`);
  return outcome;
}

/** Đăng ký xử lý job chat.deliver ở tiến trình có vai trò `jobs`. */
export async function registerChatWorker(
  jobs: Jobs,
  deps: ChatDeps,
  opts: { pollingIntervalSeconds?: number } = {},
): Promise<void> {
  await jobs.work<ChatJob>(
    CHAT_QUEUE,
    async (job) => {
      const outcome = await deliverOutbox(deps, job.data);
      if (outcome === "retry") throw new Error(`Chưa gửi được tin chat ${job.data.outboxId}, sẽ thử lại.`);
    },
    opts,
  );
}
