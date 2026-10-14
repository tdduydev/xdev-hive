import { z } from "zod";
import { id, orgRoute } from "./common.ts";
import { notificationEvent } from "./notify.ts";

export const chatBotKind = z.enum(["telegram", "slack"]);
export type ChatBotKind = z.output<typeof chatBotKind>;

const name = z.string().trim().min(1, "Tên không được để trống.").max(80, "Tên dài tối đa 80 ký tự.");

export const telegramBotConfig = z.object({
  kind: z.literal("telegram"),
  /** Token của bot từ @BotFather, dạng `<số>:<chuỗi>`. */
  botToken: z
    .string()
    .trim()
    .regex(/^\d{3,20}:[\w-]{20,100}$/, "Token bot Telegram có dạng 123456:ABC..."),
});

export const slackBotConfig = z.object({
  kind: z.literal("slack"),
  /** Bot User OAuth Token của Slack app. */
  botToken: z
    .string()
    .trim()
    .regex(/^xoxb-[\w-]{10,200}$/, "Bot token Slack bắt đầu bằng xoxb-."),
  /** Signing Secret ở Basic Information của Slack app; hub dùng để kiểm chữ ký mọi request tới. */
  signingSecret: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{16,100}$/, "Signing secret Slack gồm chữ và số."),
});

export const chatBotConfig = z.discriminatedUnion("kind", [telegramBotConfig, slackBotConfig]);
export type ChatBotConfig = z.input<typeof chatBotConfig>;

export const chatBotCreateInput = z.object({
  name,
  enabled: z.boolean().default(true),
  config: chatBotConfig,
});
export type ChatBotCreateInput = z.input<typeof chatBotCreateInput>;

/** Bỏ trống trường nào thì giữ nguyên. `config` thay toàn bộ cấu hình (kể cả secret) và phải cùng loại bot. */
export const chatBotUpdateInput = z.object({
  id,
  name: name.optional(),
  enabled: z.boolean().optional(),
  config: chatBotConfig.optional(),
});
export type ChatBotUpdateInput = z.input<typeof chatBotUpdateInput>;

/** Không bao giờ chứa token hay signing secret. `webhooks` là URL quản trị dán vào Slack app (Telegram hub tự đặt). */
export const chatBot = z.object({
  id,
  kind: chatBotKind,
  name: z.string(),
  target: z.string(),
  enabled: z.boolean(),
  webhooks: z.array(z.object({ label: z.string(), url: z.string() })),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ChatBot = z.output<typeof chatBot>;

export const chatBotTestResult = z.object({ ok: z.boolean(), message: z.string() });
export type ChatBotTestResult = z.output<typeof chatBotTestResult>;

/** Cài đặt chat của tổ chức. Chưa có dòng thì dùng mặc định dưới đây. */
export const chatSettings = z.object({
  /** Cho bot nhận lệnh `/` trong nhóm; tin tự do cho Leader chỉ nhận trong chat riêng dù bật. */
  allowGroups: z.boolean(),
  /** Số tin tự do tới Leader mỗi người mỗi ngày; 0 là không cho. */
  userDailyLimit: z.number().int().min(0).max(1000),
  /** Số tin tự do tới Leader mỗi tổ chức mỗi ngày; 0 là không cho. */
  orgDailyLimit: z.number().int().min(0).max(100_000),
  /** Model của run Leader từ chat (chạy bằng Claude); null là theo cấu hình dự án. */
  leaderModel: z.string().trim().min(1).max(100).nullable(),
});
export type ChatSettings = z.output<typeof chatSettings>;
export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  allowGroups: false,
  userDailyLimit: 30,
  orgDailyLimit: 300,
  leaderModel: "sonnet",
};
export const chatSettingsPatch = chatSettings.partial();
export type ChatSettingsPatch = z.input<typeof chatSettingsPatch>;

/** Sự kiện một liên kết nhận mặc định: việc cần người; bỏ các tin chỉ để biết. */
export const CHAT_DEFAULT_EVENTS: z.output<typeof notificationEvent>[] = [
  "run.failed",
  "run.needs_review",
  "plan.awaiting_approval",
  "merge.failed",
  "review.awaiting",
  "review.overdue",
  "code_review.awaiting",
  "code_review.overdue",
  "code_review.returned",
  "code_review.approved",
  "sdlc.question",
  "sdlc.blocked",
];

/**
 * Hành động gắn vào nút của tin chat. Lưu trong chat_outbox; nút chỉ mang chỉ số tới danh sách này, nên người nhận tin
 * không đổi được hành động và callback_data của Telegram (64 byte) đủ chỗ.
 */
export const chatAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approval.approve"), approvalId: id }),
  z.object({ kind: z.literal("approval.reject"), approvalId: id }),
  z.object({ kind: z.literal("plan.approve"), taskId: id, planId: id }),
  z.object({ kind: z.literal("plan.reject"), taskId: id, planId: id }),
  z.object({ kind: z.literal("review.approve"), reviewId: id }),
  z.object({ kind: z.literal("review.changes"), reviewId: id }),
  z.object({ kind: z.literal("run.cancel"), runId: id }),
]);
export type ChatAction = z.output<typeof chatAction>;

export const chatLink = z.object({
  id,
  botId: id,
  botName: z.string(),
  kind: chatBotKind,
  /** Tên hiển thị do nền tảng chat báo; chỉ để người dùng nhận ra tài khoản, hub không tin vào nó. */
  label: z.string(),
  events: z.array(notificationEvent),
  createdAt: z.iso.datetime(),
});
export type ChatLink = z.output<typeof chatLink>;

export const chatAvailableBot = z.object({ id, kind: chatBotKind, name: z.string(), target: z.string() });
export type ChatAvailableBot = z.output<typeof chatAvailableBot>;

export const chatLinkCode = z.object({
  /** Dạng `ABCD-EFGH`; người dùng gửi cho bot. */
  code: z.string(),
  expiresAt: z.iso.datetime(),
  /** Câu lệnh đầy đủ để dán vào chat. */
  command: z.string(),
});
export type ChatLinkCode = z.output<typeof chatLinkCode>;

export const chatContract = {
  bots: {
    list: orgRoute("GET", "/v1/chat/bots", "Bot Telegram/Slack của tổ chức (quản trị tổ chức)", "chat").output(
      z.array(chatBot),
    ),
    create: orgRoute("POST", "/v1/chat/bots", "Thêm bot chat (quản trị tổ chức)", "chat")
      .input(chatBotCreateInput)
      .output(chatBot),
    update: orgRoute("PATCH", "/v1/chat/bots/{id}", "Sửa bot chat (quản trị tổ chức)", "chat")
      .input(chatBotUpdateInput)
      .output(chatBot),
    remove: orgRoute("DELETE", "/v1/chat/bots/{id}", "Xoá bot chat (quản trị tổ chức)", "chat")
      .input(z.object({ id }))
      .output(z.object({ id })),
    test: orgRoute(
      "POST",
      "/v1/chat/bots/{id}/test",
      "Kiểm tra token và kết nối webhook của bot (quản trị tổ chức)",
      "chat",
    )
      .input(z.object({ id }))
      .output(chatBotTestResult),
  },
  settings: {
    get: orgRoute("GET", "/v1/chat/settings", "Cài đặt chat của tổ chức (quản trị tổ chức)", "chat").output(
      chatSettings,
    ),
    update: orgRoute("PATCH", "/v1/chat/settings", "Đổi cài đặt chat của tổ chức (quản trị tổ chức)", "chat")
      .input(chatSettingsPatch)
      .output(chatSettings),
  },
  links: {
    available: orgRoute("GET", "/v1/chat/available", "Bot đang bật mà thành viên có thể liên kết", "chat").output(
      z.array(chatAvailableBot),
    ),
    list: orgRoute("GET", "/v1/chat/links", "Tài khoản chat đã liên kết của tôi", "chat").output(z.array(chatLink)),
    createCode: orgRoute("POST", "/v1/chat/links/code", "Tạo mã liên kết một lần cho một bot", "chat")
      .input(z.object({ botId: id }))
      .output(chatLinkCode),
    update: orgRoute("PATCH", "/v1/chat/links/{id}", "Chọn sự kiện nhận qua một liên kết", "chat")
      .input(z.object({ id, events: z.array(notificationEvent).max(notificationEvent.options.length) }))
      .output(chatLink),
    remove: orgRoute("DELETE", "/v1/chat/links/{id}", "Tách tài khoản chat", "chat")
      .input(z.object({ id }))
      .output(z.object({ id })),
  },
};
