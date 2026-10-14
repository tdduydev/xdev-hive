import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { telegramCall } from "./adapters.ts";
import { findChatBot, saveTelegramOffset } from "./bots.ts";
import type { ChatDeps } from "./deps.ts";
import { processTelegram, type TelegramUpdate } from "./webhooks.ts";

const RETRY_MS = 5_000;
const POLL_SEC = 30;

/** Một kết nối riêng giữ khoá phiên: không chiếm chỗ của pool phục vụ API trong lúc chờ Telegram. */
export async function pollTelegramBot(deps: ChatDeps, botId: string, stop: AbortSignal): Promise<void> {
  if (!deps.masterKey) return;
  while (!stop.aborted) {
    const session = new pg.Client({ ...deps.pool.options, connectionTimeoutMillis: 5_000 });
    const disconnected = new AbortController();
    const signal = AbortSignal.any([stop, disconnected.signal]);
    session.on("error", () => disconnected.abort());
    try {
      const initial = await findChatBot(deps.pool, deps.masterKey, botId);
      if (initial?.enabled && initial.config.kind === "telegram") {
        await session.connect();
        // Khoá theo token, kể cả khi hai dòng bot cùng trỏ tới một bot Telegram.
        const { rows } = await session.query<{ locked: boolean }>(
          "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
          [`chat.telegram:${initial.config.botToken}`],
        );
        if (rows[0]?.locked) {
          // Đọc lại sau khi lấy khoá: tiến trình trước có thể vừa ghi con trỏ rồi nhả khoá.
          let bot = await findChatBot(deps.pool, deps.masterKey, botId);
          if (bot?.enabled && bot.config.kind === "telegram" && bot.config.botToken === initial.config.botToken) {
            await telegramCall(bot.config, "deleteWebhook", { drop_pending_updates: false }, deps, { signal });
            let offset = bot.config.nextUpdateId ?? 0;
            while (!signal.aborted) {
              if (bot.config.kind !== "telegram") break;
              const updates = await telegramCall<TelegramUpdate[]>(
                bot.config,
                "getUpdates",
                {
                  offset,
                  timeout: POLL_SEC,
                  allowed_updates: ["message", "callback_query"],
                },
                deps,
                { signal, timeoutMs: (POLL_SEC + 10) * 1000 },
              );
              const current = await findChatBot(deps.pool, deps.masterKey, botId);
              if (
                !current?.enabled ||
                current.config.kind !== "telegram" ||
                current.config.botToken !== bot.config.botToken
              )
                break;
              bot = current;
              if (!Array.isArray(updates)) throw new Error("Telegram trả danh sách update không hợp lệ.");
              for (const update of updates) {
                if (signal.aborted) break;
                if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) {
                  throw new Error("Telegram trả mã update không hợp lệ.");
                }
                if (update.update_id < offset) continue;
                await processTelegram(deps, bot, update);
                // Chỉ xác nhận sau khi xử lý xong. Lỗi database giữ update để thử lại, kể cả sau khi hub khởi động lại.
                await saveTelegramOffset(deps.pool, deps.masterKey, bot, update.update_id + 1);
                offset = update.update_id + 1;
              }
            }
          }
        }
      }
    } catch {
      // Lỗi pg có thể kèm tham số chứa token; không đưa nguyên lỗi của kết nối khoá phiên vào log.
      if (!stop.aborted) console.warn(`Long polling Telegram của bot ${botId} gián đoạn; sẽ thử lại.`);
    } finally {
      // Đóng kết nối nhả advisory lock kể cả khi mất mạng hoặc bị huỷ.
      await session.end().catch(() => undefined);
    }
    await delay(RETRY_MS, undefined, { signal: stop }).catch(() => undefined);
  }
}

export function startTelegramPolling(deps: ChatDeps): { stop: () => Promise<void> } {
  const controller = new AbortController();
  const loops = [...new Set(deps.telegramPollingBotIds ?? [])].map((id) =>
    pollTelegramBot(deps, id, controller.signal),
  );
  return {
    async stop() {
      controller.abort();
      await Promise.all(loops);
    },
  };
}
