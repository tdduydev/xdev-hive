import { randomUUID } from "node:crypto";
import {
  type NotificationChannelCreateInput,
  type NotificationChannelKind,
  type NotificationChannelUpdateInput,
  type NotificationEvent,
  notificationChannelConfig,
  notificationChannelCreateInput,
  notificationChannelUpdateInput,
} from "@xdev-hive/contracts";
import { asc, eq, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import {
  BadRequestError,
  ConflictError,
  decryptSecret,
  encryptSecret,
  type MasterKey,
  NotFoundError,
  type Tx,
} from "../platform/index.ts";
import { requireOrgRole } from "../tenancy/index.ts";
import { notificationChannels } from "./schema.ts";
import { type ChannelConfig, targetOf } from "./send.ts";
import { PrivateSmtpHostError, resolveSmtpHost, type SmtpHostDeps } from "./smtp-host.ts";

export interface ChannelRecord {
  id: string;
  kind: NotificationChannelKind;
  name: string;
  events: NotificationEvent[];
  enabled: boolean;
  target: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Kênh kèm cấu hình đã giải mã. Chỉ sống trong bộ nhớ, đủ lâu để gửi. */
export interface ResolvedChannel extends ChannelRecord {
  config: ChannelConfig;
}

// Ngữ cảnh mã hoá gắn với id dòng: chép config_enc sang dòng khác sẽ không giải mã được.
const secretContext = (id: string) => `notification_channels:${id}`;

export const channelColumns = {
  id: notificationChannels.id,
  kind: notificationChannels.kind,
  name: notificationChannels.name,
  events: sql<NotificationEvent[]>`${notificationChannels.events}`,
  enabled: notificationChannels.enabled,
  target: notificationChannels.target,
  createdAt: notificationChannels.createdAt,
  updatedAt: notificationChannels.updatedAt,
};

const UNIQUE_VIOLATION = "23505";
/** Drizzle bọc lỗi của pg trong `cause`. */
const pgCode = (e: unknown) => (((e as { cause?: unknown }).cause ?? e) as { code?: string }).code;

const notFound = () => new NotFoundError("NOTIFICATION_CHANNEL_NOT_FOUND", "Không tìm thấy kênh thông báo.");
const nameTaken = (name: string) =>
  new ConflictError("NOTIFICATION_CHANNEL_NAME_TAKEN", `Tổ chức đã có kênh thông báo tên "${name}".`);

export function decryptConfig(master: MasterKey, id: string, enc: string): ChannelConfig {
  return JSON.parse(decryptSecret(master, enc, secretContext(id))) as ChannelConfig;
}

/** Dữ liệu không bí mật cho nhật ký audit. */
const auditData = (c: { kind: string; name: string; events: string[]; enabled: boolean; target: string }) => ({
  kind: c.kind,
  name: c.name,
  events: c.events,
  enabled: c.enabled,
  target: c.target,
});

/** Kênh chứa nơi nhận (chat, email) nên chỉ quản trị tổ chức xem được. */
export async function listChannels(tx: Tx, userId: string): Promise<ChannelRecord[]> {
  await requireOrgRole(tx, userId, "admin");
  return tx.select(channelColumns).from(notificationChannels).orderBy(asc(notificationChannels.name));
}

async function validateSmtpHost(config: ChannelConfig, deps: SmtpHostDeps): Promise<void> {
  if (config.kind !== "email") return;
  try {
    await resolveSmtpHost(config.host, deps);
  } catch (e) {
    throw new BadRequestError(
      "NOTIFICATION_SMTP_HOST_INVALID",
      e instanceof PrivateSmtpHostError ? e.message : "Không phân giải được máy chủ SMTP",
    );
  }
}

export async function createChannel(
  tx: Tx,
  master: MasterKey,
  userId: string,
  raw: NotificationChannelCreateInput,
  deps: SmtpHostDeps = {},
): Promise<ChannelRecord> {
  await requireOrgRole(tx, userId, "admin");
  // Hàm public cho module khác: chạy lại zod để có giá trị mặc định (port, tls) dù người gọi không qua oRPC.
  const input = notificationChannelCreateInput.parse(raw);
  const id = randomUUID();
  const config = input.config as ChannelConfig;
  await validateSmtpHost(config, deps);
  let row: ChannelRecord | undefined;
  try {
    [row] = await tx
      .insert(notificationChannels)
      .values({
        id,
        orgId: sql`hive.ctx_org()`,
        kind: config.kind,
        name: input.name,
        events: input.events,
        enabled: input.enabled,
        target: targetOf(config),
        configEnc: encryptSecret(master, JSON.stringify(config), secretContext(id)),
        createdBy: userId,
      })
      .returning(channelColumns);
  } catch (e) {
    if (pgCode(e) === UNIQUE_VIOLATION) throw nameTaken(input.name);
    throw e;
  }
  if (!row) throw new Error("Không tạo được kênh thông báo.");
  await recordAudit(tx, {
    action: "notification_channel.create",
    targetType: "notification_channel",
    targetId: id,
    data: auditData(row),
  });
  return row;
}

export async function updateChannel(
  tx: Tx,
  master: MasterKey,
  userId: string,
  raw: NotificationChannelUpdateInput,
  deps: SmtpHostDeps = {},
): Promise<ChannelRecord> {
  await requireOrgRole(tx, userId, "admin");
  const input = notificationChannelUpdateInput.parse(raw);
  const [current] = await tx
    .select({ ...channelColumns, configEnc: notificationChannels.configEnc })
    .from(notificationChannels)
    .where(eq(notificationChannels.id, input.id))
    .for("update");
  if (!current) throw notFound();
  const config = input.config ? (notificationChannelConfig.parse(input.config) as ChannelConfig) : undefined;
  if (config && config.kind !== current.kind) {
    throw new BadRequestError(
      "NOTIFICATION_CHANNEL_KIND_FIXED",
      "Không đổi được loại kênh; hãy tạo kênh mới với loại khác.",
    );
  }
  await validateSmtpHost(config ?? decryptConfig(master, input.id, current.configEnc), deps);
  let row: ChannelRecord | undefined;
  try {
    [row] = await tx
      .update(notificationChannels)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.events !== undefined ? { events: input.events } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(config
          ? {
              target: targetOf(config),
              configEnc: encryptSecret(master, JSON.stringify(config), secretContext(input.id)),
            }
          : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(notificationChannels.id, input.id))
      .returning(channelColumns);
  } catch (e) {
    if (pgCode(e) === UNIQUE_VIOLATION) throw nameTaken(input.name ?? current.name);
    throw e;
  }
  if (!row) throw notFound();
  await recordAudit(tx, {
    action: "notification_channel.update",
    targetType: "notification_channel",
    targetId: row.id,
    // Ghi có đổi cấu hình hay không, không ghi cấu hình.
    data: { ...auditData(row), configChanged: Boolean(config) },
  });
  return row;
}

export async function removeChannel(tx: Tx, userId: string, id: string): Promise<void> {
  await requireOrgRole(tx, userId, "admin");
  const [row] = await tx.delete(notificationChannels).where(eq(notificationChannels.id, id)).returning(channelColumns);
  if (!row) throw notFound();
  await recordAudit(tx, {
    action: "notification_channel.remove",
    targetType: "notification_channel",
    targetId: id,
    data: auditData(row),
  });
}

/** Kênh kèm cấu hình để gửi tin thử; đòi quyền quản trị và ghi audit lần thử. */
export async function loadChannelForTest(
  tx: Tx,
  master: MasterKey,
  userId: string,
  id: string,
): Promise<ResolvedChannel> {
  await requireOrgRole(tx, userId, "admin");
  const [row] = await tx
    .select({ ...channelColumns, configEnc: notificationChannels.configEnc })
    .from(notificationChannels)
    .where(eq(notificationChannels.id, id));
  if (!row) throw notFound();
  const { configEnc, ...rest } = row;
  await recordAudit(tx, {
    action: "notification_channel.test",
    targetType: "notification_channel",
    targetId: id,
    data: { name: rest.name, target: rest.target },
  });
  return { ...rest, config: decryptConfig(master, id, configEnc) };
}
