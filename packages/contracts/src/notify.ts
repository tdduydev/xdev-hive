import { z } from "zod";
import { id, orgRoute } from "./common.ts";

/** Sự kiện gửi cho nhóm quản trị. Module phát sự kiện chọn một loại; kênh chọn loại nào nó nhận. */
export const notificationEvent = z.enum([
  "run.failed",
  "run.needs_review",
  "project.provision_failed",
  "machine.offline",
  "member.pending",
  "merge.failed",
]);
export type NotificationEvent = z.output<typeof notificationEvent>;

export const notificationChannelKind = z.enum(["telegram", "email"]);
export type NotificationChannelKind = z.output<typeof notificationChannelKind>;

const name = z.string().trim().min(1, "Tên không được để trống.").max(80, "Tên dài tối đa 80 ký tự.");
const events = z
  .array(notificationEvent)
  .min(1, "Chọn ít nhất một loại sự kiện.")
  .max(notificationEvent.options.length)
  .transform((list) => [...new Set(list)]);

export const telegramConfig = z.object({
  kind: z.literal("telegram"),
  /** Token của bot từ @BotFather, dạng `<số>:<chuỗi>`. */
  botToken: z
    .string()
    .trim()
    .regex(/^\d{3,20}:[\w-]{20,100}$/, "Token bot Telegram có dạng 123456:ABC..."),
  /** Id cuộc trò chuyện hoặc nhóm (số, nhóm thường âm) hoặc `@tên_kênh`. */
  chatId: z
    .string()
    .trim()
    .regex(/^(-?\d{1,20}|@[A-Za-z]\w{3,63})$/, "Chat id là số (nhóm thường âm) hoặc @tên_kênh."),
});

/**
 * `tls`: `implicit` cho cổng 465, `starttls` (bắt buộc nâng cấp TLS) cho cổng 587, `none` chỉ cho máy chủ SMTP nội bộ
 * không có TLS.
 */
export const emailConfig = z.object({
  kind: z.literal("email"),
  host: z
    .string()
    .trim()
    .min(1, "Nhập địa chỉ máy chủ SMTP.")
    .max(253)
    .regex(/^[A-Za-z0-9.-]+$/, "Địa chỉ máy chủ SMTP chỉ gồm chữ, số, `.` và `-`."),
  port: z.number().int().min(1).max(65535).default(587),
  tls: z.enum(["implicit", "starttls", "none"]).default("starttls"),
  user: z.string().trim().max(200).optional(),
  password: z.string().max(500).optional(),
  from: z.email("Địa chỉ gửi không hợp lệ."),
  to: z
    .array(z.email("Địa chỉ nhận không hợp lệ."))
    .min(1, "Nhập ít nhất một địa chỉ nhận.")
    .max(20, "Tối đa 20 địa chỉ nhận."),
});

export const notificationChannelConfig = z.discriminatedUnion("kind", [telegramConfig, emailConfig]);
export type NotificationChannelConfig = z.input<typeof notificationChannelConfig>;

export const notificationChannelCreateInput = z.object({
  name,
  events,
  enabled: z.boolean().default(true),
  config: notificationChannelConfig,
});
export type NotificationChannelCreateInput = z.input<typeof notificationChannelCreateInput>;

/** Bỏ trống trường nào thì giữ nguyên. `config` thay toàn bộ cấu hình (kể cả secret) và phải cùng loại kênh. */
export const notificationChannelUpdateInput = z.object({
  id,
  name: name.optional(),
  events: events.optional(),
  enabled: z.boolean().optional(),
  config: notificationChannelConfig.optional(),
});
export type NotificationChannelUpdateInput = z.input<typeof notificationChannelUpdateInput>;

/** Không bao giờ chứa secret (token bot, mật khẩu SMTP). `target` mô tả nơi nhận để người quản trị nhận ra kênh. */
export const notificationChannel = z.object({
  id,
  kind: notificationChannelKind,
  name: z.string(),
  events: z.array(notificationEvent),
  enabled: z.boolean(),
  target: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type NotificationChannel = z.output<typeof notificationChannel>;

export const notificationTestResult = z.object({ ok: z.boolean(), message: z.string() });
export type NotificationTestResult = z.output<typeof notificationTestResult>;

export const notificationChannelsContract = {
  list: orgRoute("GET", "/v1/notification-channels", "Kênh thông báo của tổ chức (quản trị tổ chức)", "notify").output(
    z.array(notificationChannel),
  ),
  create: orgRoute("POST", "/v1/notification-channels", "Thêm kênh thông báo (quản trị tổ chức)", "notify")
    .input(notificationChannelCreateInput)
    .output(notificationChannel),
  update: orgRoute("PATCH", "/v1/notification-channels/{id}", "Sửa kênh thông báo (quản trị tổ chức)", "notify")
    .input(notificationChannelUpdateInput)
    .output(notificationChannel),
  remove: orgRoute("DELETE", "/v1/notification-channels/{id}", "Xoá kênh thông báo (quản trị tổ chức)", "notify")
    .input(z.object({ id }))
    .output(z.object({ id })),
  test: orgRoute("POST", "/v1/notification-channels/{id}/test", "Gửi tin thử qua kênh (quản trị tổ chức)", "notify")
    .input(z.object({ id }))
    .output(notificationTestResult),
};
