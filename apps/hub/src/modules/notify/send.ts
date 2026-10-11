import type { NotificationChannelConfig } from "@xdev-hive/contracts";
import nodemailer from "nodemailer";

/** Cấu hình kênh sau khi qua zod (đã có giá trị mặc định). */
export type TelegramConfig = Extract<NotificationChannelConfig, { kind: "telegram" }>;
export type EmailConfig = Required<Pick<Extract<NotificationChannelConfig, { kind: "email" }>, "port" | "tls">> &
  Omit<Extract<NotificationChannelConfig, { kind: "email" }>, "port" | "tls">;
export type ChannelConfig = TelegramConfig | EmailConfig;

export interface Message {
  title: string;
  body: string;
  link: string | null;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SendDeps {
  /** Test thay fetch giả cho Telegram. */
  fetch?: FetchLike | undefined;
  /** Địa chỉ API Telegram; test trỏ sang máy chủ giả. */
  telegramApi?: string | undefined;
}

/**
 * Lỗi gửi. `permanent`: thử lại cũng không khỏi (token sai, chat không có, địa chỉ nhận bị từ chối), nên đánh dấu
 * failed ngay thay vì tốn thêm lượt thử.
 */
export class DeliveryError extends Error {
  override readonly name = "DeliveryError";
  readonly permanent: boolean;

  constructor(message: string, permanent: boolean) {
    super(message);
    this.permanent = permanent;
  }
}

const TELEGRAM_LIMIT = 4096;
const TIMEOUT_MS = 15_000;

/** Telegram parse_mode HTML chỉ cần thoát ba ký tự này trong nội dung; trong thuộc tính thêm dấu nháy kép. */
export const escapeHtml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttr = (s: string) => escapeHtml(s).replaceAll('"', "&quot;");

/** Secret không bao giờ được lọt vào thông báo lỗi lưu trong bảng notifications hay trả cho API. */
function redact(message: string, config: ChannelConfig): string {
  const secrets = config.kind === "telegram" ? [config.botToken] : [config.password ?? ""];
  let out = message;
  for (const s of secrets) if (s.length >= 4) out = out.replaceAll(s, "***");
  return out.slice(0, 1000);
}

/** Thoát HTML rồi cắt cho vừa `room` ký tự; cắt trên chuỗi gốc để không cắt giữa một thực thể như &amp;. */
function clipEscaped(s: string, room: number): string {
  if (escapeHtml(s).length <= room) return escapeHtml(s);
  let cut = s.slice(0, room - 1);
  // Một ký tự thoát dài tối đa 5 ký tự ("&amp;"): bỏ dần phần dư tới khi vừa, chừa một chỗ cho dấu "…".
  while (escapeHtml(cut).length > room - 1)
    cut = cut.slice(0, cut.length - Math.ceil((escapeHtml(cut).length - room + 1) / 5));
  return `${escapeHtml(cut)}…`;
}

export function telegramText(m: Message): string {
  const head = `<b>${escapeHtml(m.title)}</b>\n\n`;
  const tail = m.link ? `\n\n<a href="${escapeAttr(m.link)}">Mở trong xDev Hive</a>` : "";
  return head + clipEscaped(m.body, TELEGRAM_LIMIT - head.length - tail.length) + tail;
}

async function sendTelegram(config: TelegramConfig, m: Message, deps: SendDeps): Promise<void> {
  const doFetch = deps.fetch ?? fetch;
  const api = (deps.telegramApi ?? "https://api.telegram.org").replace(/\/+$/, "");
  let res: Response;
  try {
    res = await doFetch(`${api}/bot${config.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: telegramText(m),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e instanceof Error ? e.name : "lỗi mạng");
    throw new DeliveryError(`Telegram: không kết nối được (${cause}).`, false);
  }
  if (res.ok) return;
  const data = (await res.json().catch(() => ({}))) as { description?: string };
  const detail = data.description ? `: ${data.description}` : "";
  // 429 và 5xx là tạm thời; 4xx khác (token sai, bot bị chặn, chat không có) thử lại cũng vậy.
  const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
  throw new DeliveryError(`Telegram trả ${res.status}${detail}`, permanent);
}

function emailText(m: Message): string {
  return m.link ? `${m.body}\n\nMở trong xDev Hive: ${m.link}\n` : `${m.body}\n`;
}

async function sendEmail(config: EmailConfig, m: Message): Promise<void> {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.tls === "implicit",
    // Có mật khẩu thì không gửi qua kênh trần: starttls bắt buộc nâng cấp, không lặng lẽ gửi plaintext khi máy chủ
    // không hỗ trợ.
    requireTLS: config.tls === "starttls",
    ignoreTLS: config.tls === "none",
    auth: config.user ? { user: config.user, pass: config.password ?? "" } : undefined,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
  try {
    await transport.sendMail({
      from: config.from,
      to: config.to,
      subject: m.title,
      text: emailText(m),
    });
  } catch (e) {
    const err = e as { code?: string; responseCode?: number; message?: string };
    // 5xx của SMTP và sai tài khoản là vĩnh viễn; 4xx và lỗi kết nối là tạm thời.
    const permanent = err.code === "EAUTH" || (err.responseCode !== undefined && err.responseCode >= 500);
    const what = err.responseCode ? `${err.responseCode}` : (err.code ?? "lỗi");
    throw new DeliveryError(`SMTP ${config.host}:${config.port} báo ${what}: ${err.message ?? ""}`.trim(), permanent);
  } finally {
    transport.close();
  }
}

export async function send(config: ChannelConfig, m: Message, deps: SendDeps = {}): Promise<void> {
  try {
    if (config.kind === "telegram") await sendTelegram(config, m, deps);
    else await sendEmail(config, m);
  } catch (e) {
    const err = e instanceof DeliveryError ? e : new DeliveryError(e instanceof Error ? e.message : String(e), false);
    throw new DeliveryError(redact(err.message, config), err.permanent);
  }
}

/** Phần không bí mật của cấu hình, để người quản trị nhận ra kênh. */
export function targetOf(config: ChannelConfig): string {
  if (config.kind === "telegram") return `Telegram ${config.chatId}`;
  return `${config.to.join(", ")} qua ${config.host}:${config.port}`;
}
