import { createHash, randomInt } from "node:crypto";
import { CHAT_DEFAULT_EVENTS, type ChatLink, type ChatLinkCode, type NotificationEvent } from "@xdev-hive/contracts";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { ConflictError, NotFoundError, type Tx } from "../platform/index.ts";
import { requireOrgRole } from "../tenancy/index.ts";
import { chatBots, chatLinkCodes, chatLinks } from "./schema.ts";

export const LINK_CODE_TTL_SEC = 600;
// Bỏ 0/O và 1/I/L cho dễ đọc; 32 ký tự × 8 = 40 bit.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

const hashCode = (code: string) => createHash("sha256").update(code).digest("hex");

/** Người dùng gõ có dấu gạch, chữ thường, khoảng trắng: gom về một dạng. */
export function normalizeCode(raw: string): string | null {
  const code = raw.replace(/[\s-]/g, "").toUpperCase();
  return code.length === CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}

const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

export type LinkRow = typeof chatLinks.$inferSelect;

const linkView = (row: LinkRow & { botName: string; botKind: "telegram" | "slack" }): ChatLink => ({
  id: row.id,
  botId: row.botId,
  botName: row.botName,
  kind: row.botKind,
  label: row.label,
  events: row.events as NotificationEvent[],
  createdAt: row.createdAt.toISOString(),
});

/** Tạo mã mới; mã chưa dùng cũ của cùng người và bot bị thay, nên chỉ có một mã sống một lúc. */
export async function createLinkCode(tx: Tx, userId: string, botId: string): Promise<ChatLinkCode> {
  await requireOrgRole(tx, userId, "member");
  const [bot] = await tx
    .select({ kind: chatBots.kind, enabled: chatBots.enabled })
    .from(chatBots)
    .where(eq(chatBots.id, botId));
  if (!bot) throw new NotFoundError("CHAT_BOT_NOT_FOUND", "Không tìm thấy bot chat.");
  if (!bot.enabled) throw new ConflictError("CHAT_BOT_DISABLED", "Bot này đang tắt.");
  await tx
    .delete(chatLinkCodes)
    .where(and(eq(chatLinkCodes.botId, botId), eq(chatLinkCodes.userId, userId), isNull(chatLinkCodes.usedAt)));
  const code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_SEC * 1000);
  await tx.insert(chatLinkCodes).values({
    orgId: sql`hive.ctx_org()`,
    botId,
    userId,
    codeHash: hashCode(code),
    expiresAt,
  });
  await recordAudit(tx, {
    action: "chat_link.code_create",
    targetType: "chat_bot",
    targetId: botId,
    data: { kind: bot.kind },
  });
  const shown = formatCode(code);
  return {
    code: shown,
    expiresAt: expiresAt.toISOString(),
    command: bot.kind === "telegram" ? `/link ${shown}` : `/hive link ${shown}`,
  };
}

export interface ExternalAccount {
  userId: string;
  chatId: string;
  label: string;
}

/** Người sở hữu mã còn hiệu lực; bước đầu của đổi mã (đọc trong context chỉ có tổ chức, chưa biết người dùng). */
export async function codeOwner(tx: Tx, botId: string, raw: string): Promise<string | null> {
  const code = normalizeCode(raw);
  if (!code) return null;
  const [row] = await tx
    .select({ userId: chatLinkCodes.userId })
    .from(chatLinkCodes)
    .where(
      and(
        eq(chatLinkCodes.botId, botId),
        eq(chatLinkCodes.codeHash, hashCode(code)),
        isNull(chatLinkCodes.usedAt),
        gt(chatLinkCodes.expiresAt, sql`now()`),
      ),
    );
  return row?.userId ?? null;
}

/**
 * Đổi mã lấy liên kết, trong context của người sở hữu mã. Mã dùng một lần: đánh dấu đã dùng ngay trong transaction.
 * Tài khoản chat đã gắn người khác thì từ chối (không chiếm được tài khoản đã liên kết).
 */
export async function redeemLinkCode(
  tx: Tx,
  botId: string,
  raw: string,
  account: ExternalAccount,
): Promise<LinkRow | null> {
  const code = normalizeCode(raw);
  if (!code) return null;
  const [row] = await tx
    .select()
    .from(chatLinkCodes)
    .where(
      and(
        eq(chatLinkCodes.botId, botId),
        eq(chatLinkCodes.codeHash, hashCode(code)),
        isNull(chatLinkCodes.usedAt),
        gt(chatLinkCodes.expiresAt, sql`now()`),
      ),
    )
    .for("update");
  if (!row) return null;
  // Thành viên đã rời tổ chức sau khi tạo mã thì không liên kết được nữa.
  await requireOrgRole(tx, row.userId, "member");
  const [taken] = await tx
    .select({ userId: chatLinks.userId })
    .from(chatLinks)
    .where(and(eq(chatLinks.botId, botId), eq(chatLinks.externalUserId, account.userId)));
  if (taken && taken.userId !== row.userId) {
    throw new ConflictError("CHAT_ACCOUNT_LINKED", "Tài khoản chat này đã liên kết với người dùng khác.");
  }
  // Mỗi người một liên kết trên mỗi bot: liên kết sang tài khoản chat mới thì bỏ cái cũ.
  await tx.delete(chatLinks).where(and(eq(chatLinks.botId, botId), eq(chatLinks.userId, row.userId)));
  const [link] = await tx
    .insert(chatLinks)
    .values({
      orgId: sql`hive.ctx_org()`,
      botId,
      userId: row.userId,
      externalUserId: account.userId,
      chatId: account.chatId,
      label: account.label.slice(0, 100),
      events: [...CHAT_DEFAULT_EVENTS],
    })
    .returning();
  await tx.update(chatLinkCodes).set({ usedAt: sql`now()` }).where(eq(chatLinkCodes.id, row.id));
  if (!link) throw new Error("Không tạo được liên kết chat.");
  await recordAudit(tx, {
    action: "chat_link.create",
    targetType: "chat_link",
    targetId: link.id,
    data: { botId },
  });
  return link;
}

export async function findLink(tx: Tx, botId: string, externalUserId: string): Promise<LinkRow | null> {
  const [row] = await tx
    .select()
    .from(chatLinks)
    .where(and(eq(chatLinks.botId, botId), eq(chatLinks.externalUserId, externalUserId)));
  return row ?? null;
}

const linkSelect = {
  id: chatLinks.id,
  orgId: chatLinks.orgId,
  botId: chatLinks.botId,
  userId: chatLinks.userId,
  externalUserId: chatLinks.externalUserId,
  chatId: chatLinks.chatId,
  label: chatLinks.label,
  events: chatLinks.events,
  projectId: chatLinks.projectId,
  threadId: chatLinks.threadId,
  createdAt: chatLinks.createdAt,
  botName: chatBots.name,
  botKind: chatBots.kind,
};

export async function listMyLinks(tx: Tx, userId: string): Promise<ChatLink[]> {
  await requireOrgRole(tx, userId, "member");
  const rows = await tx
    .select(linkSelect)
    .from(chatLinks)
    .innerJoin(chatBots, and(eq(chatBots.id, chatLinks.botId), eq(chatBots.orgId, chatLinks.orgId)))
    .where(eq(chatLinks.userId, userId))
    .orderBy(desc(chatLinks.createdAt));
  return rows.map(linkView);
}

export async function updateMyLinkEvents(
  tx: Tx,
  userId: string,
  id: string,
  events: NotificationEvent[],
): Promise<ChatLink> {
  await requireOrgRole(tx, userId, "member");
  const [updated] = await tx
    .update(chatLinks)
    .set({ events: [...new Set(events)] })
    .where(and(eq(chatLinks.id, id), eq(chatLinks.userId, userId)))
    .returning({ id: chatLinks.id });
  if (!updated) throw new NotFoundError("CHAT_LINK_NOT_FOUND", "Không tìm thấy liên kết chat.");
  const [row] = await tx
    .select(linkSelect)
    .from(chatLinks)
    .innerJoin(chatBots, and(eq(chatBots.id, chatLinks.botId), eq(chatBots.orgId, chatLinks.orgId)))
    .where(eq(chatLinks.id, id));
  if (!row) throw new NotFoundError("CHAT_LINK_NOT_FOUND", "Không tìm thấy liên kết chat.");
  await recordAudit(tx, {
    action: "chat_link.update",
    targetType: "chat_link",
    targetId: id,
    data: { events: row.events },
  });
  return linkView(row);
}

/** Tách liên kết của chính mình (trên web hoặc bằng /unlink). */
export async function removeMyLink(tx: Tx, userId: string, id: string, via: "web" | "chat"): Promise<void> {
  const [row] = await tx
    .delete(chatLinks)
    .where(and(eq(chatLinks.id, id), eq(chatLinks.userId, userId)))
    .returning({ id: chatLinks.id, botId: chatLinks.botId });
  if (!row) throw new NotFoundError("CHAT_LINK_NOT_FOUND", "Không tìm thấy liên kết chat.");
  await recordAudit(tx, {
    action: "chat_link.remove",
    targetType: "chat_link",
    targetId: id,
    data: { botId: row.botId, via },
  });
}
