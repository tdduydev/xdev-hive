/** Cấu hình bot sau khi giải mã. Telegram có thêm secret hub tự sinh để kiểm header webhook. */
export type StoredBotConfig =
  | { kind: "telegram"; botToken: string; webhookSecret: string }
  | { kind: "slack"; botToken: string; signingSecret: string };

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ChatApiDeps {
  /** Test thay fetch giả. */
  fetch?: FetchLike | undefined;
  /** Địa chỉ API Telegram; test trỏ sang máy chủ giả. */
  telegramApi?: string | undefined;
  /** Địa chỉ API Slack (có `/api` cuối); test trỏ sang máy chủ giả. */
  slackApi?: string | undefined;
}

/**
 * Lỗi gửi. `permanent`: thử lại cũng không khỏi (token sai, chat không có), nên đánh dấu failed ngay thay vì tốn thêm
 * lượt thử.
 */
export class ChatSendError extends Error {
  override readonly name = "ChatSendError";
  readonly permanent: boolean;

  constructor(message: string, permanent: boolean) {
    super(message);
    this.permanent = permanent;
  }
}

export interface OutButton {
  label: string;
  /** Giá trị gửi lại khi bấm (`o:<outboxId>:<chỉ số>`). Nút liên kết dùng `url`. */
  callback?: string;
  url?: string;
}

export interface OutMessage {
  title?: string;
  text: string;
  buttons?: OutButton[];
}

const TIMEOUT_MS = 15_000;
const trimSlash = (s: string) => s.replace(/\/+$/, "");
const escapeHtml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Token không bao giờ được lọt vào thông báo lỗi lưu trong bảng hay trả cho API. */
function redact(message: string, config: StoredBotConfig): string {
  const secrets = [config.botToken, config.kind === "telegram" ? config.webhookSecret : config.signingSecret];
  let out = message;
  for (const s of secrets) if (s.length >= 4) out = out.replaceAll(s, "***");
  return out.slice(0, 500);
}

const TELEGRAM_PERMANENT = new Set([400, 401, 403, 404]);
const SLACK_PERMANENT = new Set([
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "not_authed",
  "channel_not_found",
  "user_not_found",
  "not_in_channel",
  "is_archived",
  "missing_scope",
  "cannot_dm_bot",
  "invalid_blocks",
  "msg_too_long",
]);

async function post(
  url: string,
  init: { headers?: Record<string, string>; body: string },
  config: StoredBotConfig,
  deps: ChatApiDeps,
): Promise<Response> {
  const doFetch = deps.fetch ?? fetch;
  try {
    return await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...init.headers },
      body: init.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e instanceof Error ? e.name : "lỗi mạng");
    throw new ChatSendError(
      redact(`Không kết nối được tới ${config.kind === "telegram" ? "Telegram" : "Slack"} (${cause}).`, config),
      false,
    );
  }
}

export async function telegramCall<T = unknown>(
  config: Extract<StoredBotConfig, { kind: "telegram" }>,
  method: string,
  body: Record<string, unknown>,
  deps: ChatApiDeps,
): Promise<T> {
  const api = trimSlash(deps.telegramApi ?? "https://api.telegram.org");
  const res = await post(`${api}/bot${config.botToken}/${method}`, { body: JSON.stringify(body) }, config, deps);
  const json = (await res.json().catch(() => null)) as {
    ok?: boolean;
    result?: T;
    description?: string;
    error_code?: number;
  } | null;
  if (res.ok && json?.ok) return json.result as T;
  const code = json?.error_code ?? res.status;
  throw new ChatSendError(
    redact(`Telegram ${code}: ${json?.description ?? "lỗi không rõ"}`, config),
    TELEGRAM_PERMANENT.has(code),
  );
}

export async function slackCall<T = Record<string, unknown>>(
  config: Extract<StoredBotConfig, { kind: "slack" }>,
  method: string,
  body: Record<string, unknown>,
  deps: ChatApiDeps,
): Promise<T> {
  const api = trimSlash(deps.slackApi ?? "https://slack.com/api");
  const res = await post(
    `${api}/${method}`,
    { headers: { authorization: `Bearer ${config.botToken}` }, body: JSON.stringify(body) },
    config,
    deps,
  );
  const json = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string } & T) | null;
  if (json?.ok) return json;
  const error = json?.error ?? `HTTP ${res.status}`;
  throw new ChatSendError(redact(`Slack: ${error}`, config), SLACK_PERMANENT.has(error));
}

const TELEGRAM_ROW = 3;

function telegramKeyboard(buttons: OutButton[]) {
  const rows: Array<Array<Record<string, string>>> = [];
  for (let i = 0; i < buttons.length; i += TELEGRAM_ROW) {
    rows.push(
      buttons
        .slice(i, i + TELEGRAM_ROW)
        .map((b) => (b.url ? { text: b.label, url: b.url } : { text: b.label, callback_data: b.callback ?? "" })),
    );
  }
  return { inline_keyboard: rows };
}

export function telegramText(m: OutMessage): string {
  const head = m.title ? `<b>${escapeHtml(m.title)}</b>\n\n` : "";
  return head + escapeHtml(m.text);
}

const slackEscape = escapeHtml;

export function slackBlocks(m: OutMessage) {
  const text = (m.title ? `*${slackEscape(m.title)}*\n` : "") + slackEscape(m.text);
  const blocks: Array<Record<string, unknown>> = [{ type: "section", text: { type: "mrkdwn", text } }];
  if (m.buttons?.length) {
    blocks.push({
      type: "actions",
      elements: m.buttons.map((b, i) => ({
        type: "button",
        text: { type: "plain_text", text: b.label },
        action_id: `hive_${i}`,
        ...(b.url ? { url: b.url } : { value: b.callback ?? "" }),
      })),
    });
  }
  return blocks;
}

/** Gửi một tin tới một chat của bot. */
export async function sendChat(
  config: StoredBotConfig,
  chatId: string,
  m: OutMessage,
  deps: ChatApiDeps,
): Promise<void> {
  if (config.kind === "telegram") {
    await telegramCall(
      config,
      "sendMessage",
      {
        chat_id: chatId,
        text: telegramText(m),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(m.buttons?.length ? { reply_markup: telegramKeyboard(m.buttons) } : {}),
      },
      deps,
    );
    return;
  }
  await slackCall(
    config,
    "chat.postMessage",
    { channel: chatId, text: m.title ?? m.text, blocks: slackBlocks(m), unfurl_links: false },
    deps,
  );
}

/**
 * Kiểm token và nối webhook. Telegram: getMe rồi setWebhook (chỉ khi URL là https, Telegram không nhận loại khác).
 * Slack: auth.test; URL webhook do quản trị dán vào Slack app.
 */
export async function probeBot(
  config: StoredBotConfig,
  webhookUrl: string | null,
  deps: ChatApiDeps,
): Promise<{ target: string; message: string }> {
  if (config.kind === "slack") {
    const who = await slackCall<{ team?: string; user?: string }>(config, "auth.test", {}, deps);
    const target = `${who.team ?? "Slack"}${who.user ? ` / @${who.user}` : ""}`;
    return { target, message: `Token Slack hợp lệ (${target}). Dán các URL webhook vào Slack app để nhận tin.` };
  }
  const me = await telegramCall<{ username?: string }>(config, "getMe", {}, deps);
  const target = me.username ? `@${me.username}` : "Telegram bot";
  if (!webhookUrl?.startsWith("https://")) {
    return {
      target,
      message: `Token hợp lệ (${target}) nhưng chưa nối webhook: Telegram cần địa chỉ hub dạng https (đặt HIVE_PUBLIC_URL).`,
    };
  }
  await telegramCall(
    config,
    "setWebhook",
    { url: webhookUrl, secret_token: config.webhookSecret, allowed_updates: ["message", "callback_query"] },
    deps,
  );
  return { target, message: `Đã nối ${target} với hub.` };
}
