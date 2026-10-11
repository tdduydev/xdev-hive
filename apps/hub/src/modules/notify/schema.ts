import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgPolicy,
  pgRole,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// Khai báo lại schema và role thay vì lấy từ tenancy: module chỉ được import module khác qua index.ts.
const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();

const inOrg = sql`org_id = hive.ctx_org()`;

export const notificationChannelKind = hive.enum("notification_channel_kind", ["telegram", "email"]);
export const notificationStatus = hive.enum("notification_status", ["queued", "sent", "failed"]);

/**
 * Kênh thông báo của nhóm quản trị một tổ chức. Toàn bộ cấu hình gửi (token bot, mật khẩu SMTP, người nhận) nằm trong
 * config_enc; `target` là phần không bí mật để người quản trị nhận ra kênh mà không phải giải mã.
 */
export const notificationChannels = hive
  .table(
    "notification_channels",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      kind: notificationChannelKind("kind").notNull(),
      name: text("name").notNull(),
      /** Loại sự kiện kênh nhận (contracts notificationEvent). */
      events: text("events").array().notNull(),
      enabled: boolean("enabled").notNull().default(true),
      target: text("target").notNull(),
      /** JSON cấu hình, mã hoá envelope với ngữ cảnh là id dòng. */
      configEnc: text("config_enc").notNull(),
      createdBy: text("created_by").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("notification_channels_org_name").on(t.orgId, t.name),
      // Khoá kép để notifications không trỏ được tới kênh của tổ chức khác.
      unique("notification_channels_id_org").on(t.id, t.orgId),
      index("notification_channels_org").on(t.orgId),
      pgPolicy("notification_channels_rw", { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg }),
    ],
  )
  .enableRLS();

const ownInbox = sql`org_id = hive.ctx_org() and user_id = hive.ctx_user()`;

export const inboxItems = hive
  .table(
    "inbox_items",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      userId: text("user_id").notNull(),
      event: text("event").notNull(),
      eventKey: text("event_key").notNull(),
      title: text("title").notNull(),
      body: text("body").notNull(),
      link: text("link"),
      // Con trỏ dùng Date của JavaScript, nên độ chính xác trong DB cũng phải là mili giây để không mất mục.
      createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
      readAt: timestamp("read_at", { withTimezone: true, precision: 3 }),
    },
    (t) => [
      unique("inbox_items_recipient_event").on(t.orgId, t.userId, t.event, t.eventKey),
      index("inbox_items_recipient_created").on(t.orgId, t.userId, t.createdAt, t.id),
      index("inbox_items_recipient_unread").on(t.orgId, t.userId).where(sql`read_at is null`),
      index("inbox_items_read_at").on(t.readAt).where(sql`read_at is not null`),
      pgPolicy("inbox_items_rw", { for: "all", to: hiveApp, using: ownInbox, withCheck: ownInbox }),
      // Nghiệp vụ và job ghi cho người nhận khác người thao tác; quyền đọc/sửa vẫn chỉ thuộc người nhận.
      pgPolicy("inbox_items_insert", { for: "insert", to: hiveApp, withCheck: inOrg }),
    ],
  )
  .enableRLS();

/**
 * Mỗi lần gửi một sự kiện qua một kênh. Ghi cùng transaction với nghiệp vụ phát sự kiện; việc gửi thật chạy sau bằng
 * job notify.deliver, nên GitHub/Telegram/SMTP chậm hay lỗi không làm nghiệp vụ rollback.
 */
export const notifications = hive
  .table(
    "notifications",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      channelId: uuid("channel_id").notNull(),
      event: text("event").notNull(),
      title: text("title").notNull(),
      body: text("body").notNull(),
      link: text("link"),
      status: notificationStatus("status").notNull().default("queued"),
      attempts: integer("attempts").notNull().default(0),
      error: text("error"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      sentAt: timestamp("sent_at", { withTimezone: true }),
    },
    (t) => [
      index("notifications_org_created").on(t.orgId, t.createdAt),
      index("notifications_channel").on(t.channelId),
      pgPolicy("notifications_rw", { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg }),
    ],
  )
  .enableRLS();
