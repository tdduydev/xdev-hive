import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { type OutMessage, sendChat, slackBlocks, telegramCall } from "./adapters.ts";
import { findChatBot, type ResolvedBot } from "./bots.ts";
import { handleAction, handleMessage } from "./commands.ts";
import type { ChatDeps } from "./deps.ts";

const MAX_BODY = 256 * 1024;
const SLACK_MAX_SKEW_SEC = 300;

/** So sánh không lộ độ dài hay vị trí khác biệt qua thời gian. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function readBody(req: Request): Promise<string | null> {
  const text = await req.text();
  return text.length > MAX_BODY ? null : text;
}

const label = (u: { username?: string; first_name?: string; last_name?: string }) =>
  u.username ? `@${u.username}` : [u.first_name, u.last_name].filter(Boolean).join(" ");

// ---- Telegram --------------------------------------------------------------------------------------------------

interface TelegramUpdate {
  message?: {
    text?: string;
    chat: { id: number; type: string };
    from?: { id: number; is_bot?: boolean; username?: string; first_name?: string; last_name?: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number; is_bot?: boolean };
    message?: { message_id: number; chat: { id: number; type: string } };
  };
}

/**
 * Webhook Telegram. Luôn trả 200 sau khi đã xác thực: lỗi xử lý (database, gửi tin) chỉ ghi log, vì Telegram thử lại
 * khi nhận mã khác 2xx và sẽ dội cùng một update liên tục.
 */
export async function handleTelegramWebhook(deps: ChatDeps, botId: string, req: Request): Promise<Response> {
  const bot = await findChatBot(deps.pool, deps.masterKey, botId);
  if (!bot || bot.config.kind !== "telegram") return json({ error: "not_found" }, 404);
  const secret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!safeEqual(secret, bot.config.webhookSecret)) return json({ error: "forbidden" }, 403);
  if (!bot.enabled) return json({ ok: true });
  const raw = await readBody(req);
  if (raw === null) return json({ error: "too_large" }, 413);
  let update: TelegramUpdate;
  try {
    update = JSON.parse(raw) as TelegramUpdate;
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  try {
    await processTelegram(deps, bot, update);
  } catch (e) {
    console.error("Lỗi xử lý update Telegram:", e instanceof Error ? e.message : e);
  }
  return json({ ok: true });
}

async function processTelegram(deps: ChatDeps, bot: ResolvedBot, update: TelegramUpdate): Promise<void> {
  const config = bot.config;
  if (config.kind !== "telegram") return;
  const reply = async (chatId: string | number, messages: OutMessage[]) => {
    for (const m of messages) {
      try {
        await sendChat(config, String(chatId), m, deps);
      } catch (e) {
        console.warn("Không gửi được tin trả lời Telegram:", e instanceof Error ? e.message : e);
      }
    }
  };

  const msg = update.message;
  if (msg?.text && msg.from && !msg.from.is_bot) {
    const messages = await handleMessage(deps, bot, {
      externalUserId: String(msg.from.id),
      chatId: String(msg.chat.id),
      label: label(msg.from),
      chatType: msg.chat.type === "private" ? "private" : "group",
      text: msg.text,
    });
    await reply(msg.chat.id, messages);
    return;
  }

  const cb = update.callback_query;
  if (cb?.data && cb.message && !cb.from.is_bot) {
    // Trả lời callback ngay để Telegram tắt vòng xoay trên nút; kết quả nói bằng tin riêng.
    await telegramCall(config, "answerCallbackQuery", { callback_query_id: cb.id }, deps).catch(() => undefined);
    const { messages, ok } = await handleAction(deps, bot, {
      externalUserId: String(cb.from.id),
      chatType: cb.message.chat.type === "private" ? "private" : "group",
      data: cb.data,
    });
    // Xong việc thì gỡ nút để không bấm lại; lỗi thì giữ nút (có thể do mạng hay quyền, người dùng thử lại được).
    if (ok) {
      await telegramCall(
        config,
        "editMessageReplyMarkup",
        { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } },
        deps,
      ).catch(() => undefined);
    }
    await reply(cb.message.chat.id, messages);
  }
}

// ---- Slack -----------------------------------------------------------------------------------------------------

type SlackRoute = "events" | "commands" | "interact";

function verifySlack(req: Request, raw: string, signingSecret: string, now = Date.now()): boolean {
  const ts = req.headers.get("x-slack-request-timestamp") ?? "";
  const sig = req.headers.get("x-slack-signature") ?? "";
  const seconds = Number(ts);
  if (!Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > SLACK_MAX_SKEW_SEC) return false;
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${ts}:${raw}`).digest("hex")}`;
  return safeEqual(sig, expected);
}

/** DM của Slack có id kênh bắt đầu bằng D; kênh công khai là C, riêng tư và nhóm DM là G. */
const slackChatType = (channel: string | undefined) => (channel?.startsWith("D") ? "private" : "group");

interface SlackEventEnvelope {
  type?: string;
  challenge?: string;
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    user?: string;
    text?: string;
    channel?: string;
    channel_type?: string;
  };
}

/**
 * Webhook Slack (Events API, slash command, nút bấm). Chữ ký v0 kiểm trên thân thô trước khi đọc gì khác. Slack gửi lại
 * (`x-slack-retry-num`) khi quá 3 giây hay lỗi; xử lý lại sẽ lặp lệnh, nên bỏ qua bản gửi lại.
 */
export async function handleSlackWebhook(
  deps: ChatDeps,
  botId: string,
  route: SlackRoute,
  req: Request,
): Promise<Response> {
  const bot = await findChatBot(deps.pool, deps.masterKey, botId);
  if (!bot || bot.config.kind !== "slack") return json({ error: "not_found" }, 404);
  const raw = await readBody(req);
  if (raw === null) return json({ error: "too_large" }, 413);
  if (!verifySlack(req, raw, bot.config.signingSecret)) return json({ error: "forbidden" }, 401);
  if (!bot.enabled) return json({ ok: true });
  try {
    if (route === "events") return await slackEvents(deps, bot, req, raw);
    if (route === "commands") return await slackCommand(deps, bot, raw);
    return await slackInteract(deps, bot, raw);
  } catch (e) {
    console.error("Lỗi xử lý request Slack:", e instanceof Error ? e.message : e);
    return json({ ok: true });
  }
}

async function slackEvents(deps: ChatDeps, bot: ResolvedBot, req: Request, raw: string): Promise<Response> {
  const config = bot.config;
  if (config.kind !== "slack") return json({ ok: true });
  let body: SlackEventEnvelope;
  try {
    body = JSON.parse(raw) as SlackEventEnvelope;
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (body.type === "url_verification") return json({ challenge: body.challenge ?? "" });
  if (req.headers.get("x-slack-retry-num")) return json({ ok: true });
  const ev = body.event;
  if (body.type !== "event_callback" || !ev?.user || ev.bot_id || ev.subtype || typeof ev.text !== "string") {
    return json({ ok: true });
  }
  const isMention = ev.type === "app_mention";
  if (ev.type !== "message" && !isMention) return json({ ok: true });
  // Tin trong kênh chỉ vào được qua @mention (và chỉ lệnh); tin thường của kênh không thuộc về bot.
  const type = slackChatType(ev.channel);
  if (type === "group" && !isMention) return json({ ok: true });
  const text = isMention ? `/${ev.text.replace(/<@[A-Z0-9]+>/g, "").trim()}` : ev.text;
  const messages = await handleMessage(deps, bot, {
    externalUserId: ev.user,
    chatId: ev.user,
    label: `Slack ${ev.user}`,
    chatType: type,
    text,
  });
  for (const m of messages) {
    try {
      await sendChat(config, ev.channel ?? ev.user, m, deps);
    } catch (e) {
      console.warn("Không gửi được tin trả lời Slack:", e instanceof Error ? e.message : e);
    }
  }
  return json({ ok: true });
}

const ephemeral = (messages: OutMessage[]) => ({
  response_type: "ephemeral",
  text: messages[0]?.title ?? messages[0]?.text ?? "",
  blocks: messages.flatMap((m) => slackBlocks(m)),
});

async function slackCommand(deps: ChatDeps, bot: ResolvedBot, raw: string): Promise<Response> {
  const form = new URLSearchParams(raw);
  const user = form.get("user_id");
  if (!user) return json({ error: "bad_request" }, 400);
  const text = `/${(form.get("text") ?? "").trim() || "help"}`;
  const messages = await handleMessage(deps, bot, {
    externalUserId: user,
    chatId: user,
    label: form.get("user_name") ? `@${form.get("user_name")}` : `Slack ${user}`,
    chatType: slackChatType(form.get("channel_id") ?? undefined),
    text,
  });
  return json(messages.length ? ephemeral(messages) : { response_type: "ephemeral", text: "…" });
}

async function slackInteract(deps: ChatDeps, bot: ResolvedBot, raw: string): Promise<Response> {
  const payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "{}") as {
    type?: string;
    user?: { id?: string };
    channel?: { id?: string };
    response_url?: string;
    actions?: Array<{ value?: string }>;
  };
  const value = payload.actions?.[0]?.value;
  if (payload.type !== "block_actions" || !payload.user?.id || !value) return json({ ok: true });
  const { messages, ok } = await handleAction(deps, bot, {
    externalUserId: payload.user.id,
    chatType: slackChatType(payload.channel?.id),
    data: value,
  });
  if (payload.response_url && messages.length) {
    // Thành công thì thay chính tin có nút bằng kết quả (hết nút); lỗi thì chỉ nhắc riêng người bấm.
    const doFetch = deps.fetch ?? fetch;
    await doFetch(payload.response_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        ok
          ? { replace_original: true, text: messages[0]?.text ?? "", blocks: messages.flatMap((m) => slackBlocks(m)) }
          : ephemeral(messages),
      ),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }
  return json({ ok: true });
}
