import type { ChatAction } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgRole,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// Khai báo lại schema và role thay vì lấy từ module khác: module chỉ được import module khác qua index.ts.
const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();

const inOrg = sql`org_id = hive.ctx_org()`;
const orgScoped = (name: string) => pgPolicy(`${name}_rw`, { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg });

export const chatBotKind = hive.enum("chat_bot_kind", ["telegram", "slack"]);
export const chatOutboxStatus = hive.enum("chat_outbox_status", ["queued", "sent", "failed"]);

/**
 * Bot Telegram hoặc Slack app của một tổ chức. Token và secret nằm trong config_enc; `target` là phần không bí mật
 * (vd. @tên_bot) để quản trị nhận ra bot mà không phải giải mã.
 */
export const chatBots = hive
  .table(
    "chat_bots",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      kind: chatBotKind("kind").notNull(),
      name: text("name").notNull(),
      target: text("target").notNull(),
      enabled: boolean("enabled").notNull().default(true),
      /** JSON cấu hình, mã hoá envelope với ngữ cảnh là id dòng. */
      configEnc: text("config_enc").notNull(),
      createdBy: text("created_by").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("chat_bots_org_name").on(t.orgId, t.name),
      unique("chat_bots_id_org").on(t.id, t.orgId),
      index("chat_bots_org").on(t.orgId),
      orgScoped("chat_bots"),
      // Webhook chưa biết tổ chức: chỉ đọc được đúng bot có id trong app.chat_bot_id (bots.ts findChatBot).
      pgPolicy("chat_bots_webhook_lookup", { for: "select", to: hiveApp, using: sql`id = hive.ctx_chat_bot()` }),
    ],
  )
  .enableRLS();

/** Cài đặt chat của tổ chức; chưa có dòng thì dùng mặc định trong contracts (DEFAULT_CHAT_SETTINGS). */
export const chatOrgSettings = hive
  .table(
    "chat_org_settings",
    {
      orgId: uuid("org_id").primaryKey(),
      allowGroups: boolean("allow_groups").notNull().default(false),
      userDailyLimit: integer("user_daily_limit").notNull().default(30),
      orgDailyLimit: integer("org_daily_limit").notNull().default(300),
      leaderModel: text("leader_model"),
      updatedBy: text("updated_by").notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    () => [orgScoped("chat_org_settings")],
  )
  .enableRLS();

/** Mã liên kết dùng một lần; chỉ lưu băm SHA-256 của mã. */
export const chatLinkCodes = hive
  .table(
    "chat_link_codes",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      botId: uuid("bot_id").notNull(),
      userId: text("user_id").notNull(),
      codeHash: text("code_hash").notNull(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
      usedAt: timestamp("used_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      foreignKey({ columns: [t.botId, t.orgId], foreignColumns: [chatBots.id, chatBots.orgId] }).onDelete("cascade"),
      unique("chat_link_codes_bot_hash").on(t.botId, t.codeHash),
      index("chat_link_codes_user").on(t.orgId, t.userId),
      orgScoped("chat_link_codes"),
    ],
  )
  .enableRLS();

/**
 * Một tài khoản chat gắn với một người dùng Hive. `externalUserId` là id bất biến của nền tảng (Telegram user id,
 * Slack user id); `label` chỉ để hiển thị và không bao giờ dùng để nhận diện.
 */
export const chatLinks = hive
  .table(
    "chat_links",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      botId: uuid("bot_id").notNull(),
      userId: text("user_id").notNull(),
      externalUserId: text("external_user_id").notNull(),
      /** Nơi gửi thông báo: chat riêng với bot (Telegram chat id, Slack user id). */
      chatId: text("chat_id").notNull(),
      label: text("label").notNull().default(""),
      /** Loại sự kiện notify người dùng muốn nhận qua liên kết này. */
      events: text("events").array().notNull(),
      /** Dự án và cuộc trò chuyện Leader hiện tại của liên kết (chọn bằng /project, /new). */
      projectId: uuid("project_id"),
      threadId: uuid("thread_id"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      foreignKey({ columns: [t.botId, t.orgId], foreignColumns: [chatBots.id, chatBots.orgId] }).onDelete("cascade"),
      unique("chat_links_id_org").on(t.id, t.orgId),
      unique("chat_links_bot_external").on(t.botId, t.externalUserId),
      unique("chat_links_bot_user").on(t.botId, t.userId),
      index("chat_links_org_user").on(t.orgId, t.userId),
      index("chat_links_thread").on(t.threadId),
      orgScoped("chat_links"),
    ],
  )
  .enableRLS();

/**
 * Tin chờ gửi tới một liên kết (thông báo, câu trả lời Leader) hoặc tin lệnh có nút. Hành động của nút nằm ở `actions`;
 * nút chỉ mang chỉ số, nên người nhận không đổi được hành động.
 */
export const chatOutbox = hive
  .table(
    "chat_outbox",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      linkId: uuid("link_id").notNull(),
      kind: text("kind").notNull(),
      event: text("event"),
      /** Chống gửi lặp một sự kiện tới một liên kết khi job nghiệp vụ chạy lại; null với tin không cần chống lặp. */
      dedupeKey: text("dedupe_key"),
      title: text("title").notNull().default(""),
      body: text("body").notNull(),
      url: text("url"),
      actions: jsonb("actions").$type<ChatAction[]>().notNull().default(sql`'[]'::jsonb`),
      status: chatOutboxStatus("status").notNull().default("queued"),
      attempts: integer("attempts").notNull().default(0),
      error: text("error"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      sentAt: timestamp("sent_at", { withTimezone: true }),
    },
    (t) => [
      foreignKey({ columns: [t.linkId, t.orgId], foreignColumns: [chatLinks.id, chatLinks.orgId] }).onDelete("cascade"),
      unique("chat_outbox_link_dedupe").on(t.linkId, t.dedupeKey),
      index("chat_outbox_link").on(t.linkId),
      index("chat_outbox_org_created").on(t.orgId, t.createdAt),
      orgScoped("chat_outbox"),
    ],
  )
  .enableRLS();

/**
 * Số tin tự do tới Leader trong ngày. `userId` rỗng là dòng tổng của tổ chức, để giới hạn tổ chức kiểm bằng một dòng
 * khoá được thay vì cộng cả bảng.
 */
export const chatUsage = hive
  .table(
    "chat_usage",
    {
      orgId: uuid("org_id").notNull(),
      userId: text("user_id").notNull(),
      day: date("day").notNull(),
      count: integer("count").notNull().default(0),
    },
    (t) => [primaryKey({ columns: [t.orgId, t.userId, t.day] }), orgScoped("chat_usage")],
  )
  .enableRLS();
