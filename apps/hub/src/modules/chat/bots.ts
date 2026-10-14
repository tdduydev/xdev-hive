import { randomBytes, randomUUID } from "node:crypto";
import {
  type ChatBot,
  type ChatBotCreateInput,
  type ChatBotKind,
  type ChatBotUpdateInput,
  type ChatSettings,
  type ChatSettingsPatch,
  chatBotConfig,
  chatBotCreateInput,
  chatBotUpdateInput,
  chatSettingsPatch,
  DEFAULT_CHAT_SETTINGS,
} from "@xdev-hive/contracts";
import { asc, eq, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import {
  BadRequestError,
  ConflictError,
  decryptSecret,
  encryptSecret,
  type MasterKey,
  NotFoundError,
  type Tx,
  withTenant,
} from "../platform/index.ts";
import { requireOrgRole } from "../tenancy/index.ts";
import type { StoredBotConfig } from "./adapters.ts";
import { chatBots, chatOrgSettings } from "./schema.ts";

export interface BotRecord {
  id: string;
  kind: ChatBotKind;
  name: string;
  target: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResolvedBot extends BotRecord {
  orgId: string;
  config: StoredBotConfig;
}

// Ngữ cảnh mã hoá gắn với id dòng: chép config_enc sang dòng khác sẽ không giải mã được.
const secretContext = (id: string) => `chat_bots:${id}`;

const botColumns = {
  id: chatBots.id,
  kind: chatBots.kind,
  name: chatBots.name,
  target: chatBots.target,
  enabled: chatBots.enabled,
  createdAt: chatBots.createdAt,
  updatedAt: chatBots.updatedAt,
};

const UNIQUE_VIOLATION = "23505";
/** Drizzle bọc lỗi của pg trong `cause`. */
const pgCode = (e: unknown) => (((e as { cause?: unknown }).cause ?? e) as { code?: string }).code;

const notFound = () => new NotFoundError("CHAT_BOT_NOT_FOUND", "Không tìm thấy bot chat.");
const nameTaken = (name: string) => new ConflictError("CHAT_BOT_NAME_TAKEN", `Tổ chức đã có bot chat tên "${name}".`);

export function decryptBotConfig(master: MasterKey, id: string, enc: string): StoredBotConfig {
  return JSON.parse(decryptSecret(master, enc, secretContext(id))) as StoredBotConfig;
}

/** Địa chỉ webhook của bot trên hub; Slack cần ba địa chỉ, Telegram một (hub tự đặt bằng setWebhook). */
export function webhookUrls(publicUrl: string, bot: { id: string; kind: ChatBotKind }) {
  const base = `${publicUrl.replace(/\/+$/, "")}/hooks/chat/${bot.kind}/${bot.id}`;
  return bot.kind === "telegram"
    ? [{ label: "Webhook Telegram (hub tự đặt khi bấm Kiểm tra và kết nối)", url: base }]
    : [
        { label: "Event Subscriptions → Request URL", url: `${base}/events` },
        { label: "Slash Commands (/hive) → Request URL", url: `${base}/commands` },
        { label: "Interactivity → Request URL", url: `${base}/interact` },
      ];
}

export const botView =
  (publicUrl: string) =>
  (b: BotRecord): ChatBot => ({
    id: b.id,
    kind: b.kind,
    name: b.name,
    target: b.target,
    enabled: b.enabled,
    webhooks: webhookUrls(publicUrl, b),
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  });

/** Dữ liệu không bí mật cho nhật ký audit. */
const auditData = (b: { kind: string; name: string; target: string; enabled: boolean }) => ({
  kind: b.kind,
  name: b.name,
  target: b.target,
  enabled: b.enabled,
});

/** Cấu hình lưu: Telegram thêm secret webhook do hub sinh; giữ nguyên secret cũ khi chỉ đổi token. */
function storedConfig(input: ReturnType<typeof chatBotConfig.parse>, previous?: StoredBotConfig): StoredBotConfig {
  if (input.kind === "slack") return input;
  return {
    kind: "telegram",
    botToken: input.botToken,
    webhookSecret: previous?.kind === "telegram" ? previous.webhookSecret : randomBytes(24).toString("base64url"),
  };
}

const initialTarget = (kind: ChatBotKind) => (kind === "telegram" ? "Telegram bot" : "Slack app");

/** Bot chứa token nên chỉ quản trị tổ chức xem được. */
export async function listBots(tx: Tx, userId: string): Promise<BotRecord[]> {
  await requireOrgRole(tx, userId, "admin");
  return tx.select(botColumns).from(chatBots).orderBy(asc(chatBots.name));
}

/** Bot đang bật để thành viên chọn khi liên kết; không có cấu hình. */
export async function availableBots(tx: Tx, userId: string): Promise<BotRecord[]> {
  await requireOrgRole(tx, userId, "member");
  return tx.select(botColumns).from(chatBots).where(eq(chatBots.enabled, true)).orderBy(asc(chatBots.name));
}

export async function createBot(
  tx: Tx,
  master: MasterKey,
  userId: string,
  raw: ChatBotCreateInput,
): Promise<BotRecord> {
  await requireOrgRole(tx, userId, "admin");
  const input = chatBotCreateInput.parse(raw);
  const id = randomUUID();
  const config = storedConfig(input.config);
  let row: BotRecord | undefined;
  try {
    [row] = await tx
      .insert(chatBots)
      .values({
        id,
        orgId: sql`hive.ctx_org()`,
        kind: config.kind,
        name: input.name,
        target: initialTarget(config.kind),
        enabled: input.enabled,
        configEnc: encryptSecret(master, JSON.stringify(config), secretContext(id)),
        createdBy: userId,
      })
      .returning(botColumns);
  } catch (e) {
    if (pgCode(e) === UNIQUE_VIOLATION) throw nameTaken(input.name);
    throw e;
  }
  if (!row) throw new Error("Không tạo được bot chat.");
  await recordAudit(tx, {
    action: "chat_bot.create",
    targetType: "chat_bot",
    targetId: id,
    data: auditData(row),
  });
  return row;
}

export async function updateBot(
  tx: Tx,
  master: MasterKey,
  userId: string,
  raw: ChatBotUpdateInput,
): Promise<BotRecord> {
  await requireOrgRole(tx, userId, "admin");
  const input = chatBotUpdateInput.parse(raw);
  const [current] = await tx
    .select({ ...botColumns, configEnc: chatBots.configEnc })
    .from(chatBots)
    .where(eq(chatBots.id, input.id))
    .for("update");
  if (!current) throw notFound();
  const next = input.config ? chatBotConfig.parse(input.config) : undefined;
  if (next && next.kind !== current.kind) {
    throw new BadRequestError("CHAT_BOT_KIND_FIXED", "Không đổi được loại bot; hãy tạo bot mới với loại khác.");
  }
  const config = next ? storedConfig(next, decryptBotConfig(master, input.id, current.configEnc)) : undefined;
  let row: BotRecord | undefined;
  try {
    [row] = await tx
      .update(chatBots)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        // Token mới có thể thuộc bot khác nên phần nhận diện cũ không còn đúng tới khi kiểm tra lại.
        ...(config
          ? {
              configEnc: encryptSecret(master, JSON.stringify(config), secretContext(input.id)),
              target: initialTarget(config.kind),
            }
          : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(chatBots.id, input.id))
      .returning(botColumns);
  } catch (e) {
    if (pgCode(e) === UNIQUE_VIOLATION) throw nameTaken(input.name ?? current.name);
    throw e;
  }
  if (!row) throw notFound();
  await recordAudit(tx, {
    action: "chat_bot.update",
    targetType: "chat_bot",
    targetId: row.id,
    // Ghi có đổi cấu hình hay không, không ghi cấu hình.
    data: { ...auditData(row), configChanged: Boolean(config) },
  });
  return row;
}

export async function removeBot(tx: Tx, userId: string, id: string): Promise<void> {
  await requireOrgRole(tx, userId, "admin");
  const [row] = await tx.delete(chatBots).where(eq(chatBots.id, id)).returning(botColumns);
  if (!row) throw notFound();
  await recordAudit(tx, {
    action: "chat_bot.remove",
    targetType: "chat_bot",
    targetId: id,
    data: auditData(row),
  });
}

/** Bot kèm cấu hình để kiểm tra kết nối; đòi quyền quản trị và ghi audit lần thử. */
export async function loadBotForProbe(tx: Tx, master: MasterKey, userId: string, id: string): Promise<ResolvedBot> {
  await requireOrgRole(tx, userId, "admin");
  const [row] = await tx
    .select({ ...botColumns, orgId: chatBots.orgId, configEnc: chatBots.configEnc })
    .from(chatBots)
    .where(eq(chatBots.id, id));
  if (!row) throw notFound();
  const { configEnc, ...rest } = row;
  await recordAudit(tx, {
    action: "chat_bot.test",
    targetType: "chat_bot",
    targetId: id,
    data: { name: rest.name, target: rest.target },
  });
  return { ...rest, config: decryptBotConfig(master, id, configEnc) };
}

/** Ghi lại tên bot/workspace sau khi kiểm tra kết nối thành công. */
export async function saveBotTarget(tx: Tx, userId: string, id: string, target: string): Promise<void> {
  await requireOrgRole(tx, userId, "admin");
  await tx.update(chatBots).set({ target, updatedAt: sql`now()` }).where(eq(chatBots.id, id));
}

/**
 * Webhook chưa biết tổ chức: đặt id bot vào app.chat_bot_id để policy chat_bots_webhook_lookup cho thấy đúng dòng đó
 * (cùng cách module catalog tra dự án cho webhook Git). Trả null khi không có bot hay không giải mã được.
 */
export async function findChatBot(
  pool: pg.Pool,
  master: MasterKey | undefined,
  botId: string,
): Promise<ResolvedBot | null> {
  if (!master || !/^[0-9a-f-]{36}$/i.test(botId)) return null;
  const [row] = await withTenant(pool, {}, async (tx) => {
    await tx.execute(sql`select set_config('app.chat_bot_id', ${botId}, true)`);
    return tx
      .select({ ...botColumns, orgId: chatBots.orgId, configEnc: chatBots.configEnc })
      .from(chatBots)
      .where(eq(chatBots.id, botId));
  });
  if (!row) return null;
  const { configEnc, ...rest } = row;
  try {
    return { ...rest, config: decryptBotConfig(master, botId, configEnc) };
  } catch {
    return null;
  }
}

/** Cài đặt của tổ chức trong context, trộn với mặc định. Không kiểm vai trò: webhook và gửi tin cần đọc. */
export async function loadSettings(tx: Tx): Promise<ChatSettings> {
  const [row] = await tx.select().from(chatOrgSettings).where(eq(chatOrgSettings.orgId, sql`hive.ctx_org()`));
  if (!row) return { ...DEFAULT_CHAT_SETTINGS };
  return {
    allowGroups: row.allowGroups,
    userDailyLimit: row.userDailyLimit,
    orgDailyLimit: row.orgDailyLimit,
    leaderModel: row.leaderModel,
  };
}

export async function getSettings(tx: Tx, userId: string): Promise<ChatSettings> {
  await requireOrgRole(tx, userId, "admin");
  return loadSettings(tx);
}

export async function updateSettings(tx: Tx, userId: string, raw: ChatSettingsPatch): Promise<ChatSettings> {
  await requireOrgRole(tx, userId, "admin");
  const patch = chatSettingsPatch.parse(raw);
  const current = await loadSettings(tx);
  const next: ChatSettings = {
    allowGroups: patch.allowGroups ?? current.allowGroups,
    userDailyLimit: patch.userDailyLimit ?? current.userDailyLimit,
    orgDailyLimit: patch.orgDailyLimit ?? current.orgDailyLimit,
    // null là giá trị hợp lệ (theo cấu hình dự án) nên phân biệt với "không đổi" bằng undefined.
    leaderModel: patch.leaderModel === undefined ? current.leaderModel : patch.leaderModel,
  };
  await tx
    .insert(chatOrgSettings)
    .values({ orgId: sql`hive.ctx_org()`, ...next, updatedBy: userId })
    .onConflictDoUpdate({ target: chatOrgSettings.orgId, set: { ...next, updatedBy: userId, updatedAt: sql`now()` } });
  await recordAudit(tx, { action: "chat_settings.update", targetType: "chat_settings", data: { ...next } });
  return next;
}
