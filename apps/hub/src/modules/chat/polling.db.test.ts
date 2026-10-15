import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { createPool, parseMasterKey, withTenant } from "../platform/index.ts";
import type { FetchLike } from "./adapters.ts";
import { createBot, findChatBot, saveTelegramOffset, updateBot } from "./bots.ts";
import type { ChatDeps } from "./deps.ts";
import { pollTelegramBot, startTelegramPolling } from "./polling.ts";
import { messageLimiter } from "./rate-limit.ts";
import { handleTelegramWebhook } from "./webhooks.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
// Một slot vẫn phục vụ được lệnh trong khi kết nối riêng đang giữ khoá polling.
const pool = createPool(appUrl, 1);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
let org: OrgFixture & { user: (n: string) => string };
let botId: string;
const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
let batches: unknown[][] = [];
let fail = false;
const running: Array<{ stop: () => Promise<void> }> = [];

const fetchFake: FetchLike = async (url, init) => {
  const method = String(url).split("/").at(-1) ?? "";
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  calls.push({ method, body });
  let result: unknown = true;
  if (method === "getUpdates") {
    if (fail) {
      fail = false;
      return Response.json({ ok: false, error_code: 500, description: "lỗi tạm" }, { status: 500 });
    }
    const batch = batches.shift();
    if (!batch) {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) reject(new Error("đã huỷ"));
        else signal?.addEventListener("abort", () => reject(new Error("đã huỷ")), { once: true });
      });
    }
    result = batch;
  }
  return Response.json({ ok: true, result });
};

const deps = (): ChatDeps => ({ pool, masterKey, publicUrl: "http://localhost:3000", fetch: fetchFake });
const update = (id: number) => ({
  update_id: id,
  message: { text: "/help", chat: { id: 123, type: "private" }, from: { id: 123 } },
});
const gets = () => calls.filter((c) => c.method === "getUpdates");
const sent = () => calls.filter((c) => c.method === "sendMessage");
const start = () => {
  const controller = new AbortController();
  const loop = pollTelegramBot(deps(), botId, controller.signal);
  const runner = {
    stop: async () => {
      controller.abort();
      await loop;
    },
  };
  running.push(runner);
  return runner;
};

beforeAll(async () => {
  org = await seedOrg(admin, `chatpoll-${randomUUID()}`);
});
beforeEach(async () => {
  calls.length = 0;
  batches = [];
  fail = false;
  messageLimiter.reset();
  const bot = await withTenant(pool, { orgId: org.orgId, userId: org.user("admin") }, (tx) =>
    createBot(tx, masterKey, org.user("admin"), {
      name: randomUUID(),
      config: { kind: "telegram", botToken: `123456:${randomUUID().replaceAll("-", "")}` },
    }),
  );
  botId = bot.id;
  await admin.query(
    "insert into hive.chat_links (org_id, bot_id, user_id, external_user_id, chat_id, events) values ($1, $2, $3, '123', '123', '{}')",
    [org.orgId, botId, org.user("tmember")],
  );
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.stop()));
});
afterAll(async () => {
  await Promise.all([admin.end(), pool.end()]);
});

describe("Telegram long polling", () => {
  it("gỡ webhook, dùng lệnh và callback chung, lưu offset rồi khôi phục sau restart", async () => {
    batches.push([
      update(10),
      {
        update_id: 11,
        callback_query: {
          id: "cb11",
          data: "không-hợp-lệ",
          from: { id: 123 },
          message: { message_id: 1, chat: { id: 123, type: "private" } },
        },
      },
    ]);
    const runner = start();
    await vi.waitFor(() => expect(gets()).toHaveLength(2));
    expect(calls[0]).toEqual({ method: "deleteWebhook", body: { drop_pending_updates: false } });
    expect(gets()[0]?.body).toMatchObject({ offset: 0, timeout: 30, allowed_updates: ["message", "callback_query"] });
    expect(gets()[1]?.body.offset).toBe(12);
    expect(sent()).toHaveLength(1);
    expect(calls.some((c) => c.method === "answerCallbackQuery")).toBe(true);
    expect((await findChatBot(pool, masterKey, botId))?.config).toMatchObject({ nextUpdateId: 12 });
    await runner.stop();
    calls.length = 0;
    batches.push([update(10), update(12)]);
    start();
    await vi.waitFor(() => expect(gets()).toHaveLength(2));
    expect(gets()[0]?.body.offset).toBe(12);
    expect(gets()[1]?.body.offset).toBe(13);
    expect(sent()).toHaveLength(1);
  });

  it("chỉ một poller giữ khoá cho cùng bot; dừng huỷ request và nhả khoá", async () => {
    const first = start();
    await vi.waitFor(() => expect(gets()).toHaveLength(1));
    const second = start();
    // Lấy khoá bằng kết nối khác cũng bị từ chối khi poller đang chờ mạng.
    const bot = await findChatBot(pool, masterKey, botId);
    const { rows } = await admin.query("select pg_try_advisory_lock(hashtextextended($1, 0)) as locked", [
      `chat.telegram:${bot?.config.botToken}`,
    ]);
    expect(rows[0].locked).toBe(false);
    await second.stop();
    expect(gets()).toHaveLength(1);
    await first.stop();
    const restarted = start();
    await vi.waitFor(() => expect(gets()).toHaveLength(2));
    await restarted.stop();
  });

  it("lỗi API thử lại với con trỏ đã lưu", async () => {
    const bot = await findChatBot(pool, masterKey, botId);
    if (!bot) throw new Error("Không có bot.");
    await saveTelegramOffset(pool, masterKey, bot, 40);
    fail = true;
    batches.push([update(40)]);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      start();
      await vi.waitFor(() => expect(gets()).toHaveLength(3), { timeout: 8000 });
      expect(gets().map((c) => c.body.offset)).toEqual([40, 40, 41]);
      expect(sent()).toHaveLength(1);
    } finally {
      warning.mockRestore();
    }
  });

  it("bot bị tắt trong khi chờ không xử lý batch và không tăng offset", async () => {
    const d = deps();
    d.fetch = async (url, init) => {
      if (String(url).endsWith("/getUpdates")) {
        await withTenant(pool, { orgId: org.orgId, userId: org.user("admin") }, (tx) =>
          updateBot(tx, masterKey, org.user("admin"), { id: botId, enabled: false }),
        );
        return Response.json({ ok: true, result: [update(1)] });
      }
      return fetchFake(url, init);
    };
    const runner = startTelegramPolling({ ...d, telegramPollingBotIds: [botId, botId] });
    running.push(runner);
    await vi.waitFor(async () => expect((await findChatBot(pool, masterKey, botId))?.enabled).toBe(false));
    await runner.stop();
    expect(sent()).toHaveLength(0);
    expect((await findChatBot(pool, masterKey, botId))?.config).not.toHaveProperty("nextUpdateId");
    expect(calls.filter((c) => c.method === "deleteWebhook")).toHaveLength(1);
  });

  it("webhook của bot polling không chạy lệnh; đổi cấu hình cùng token giữ offset, token mới xoá offset", async () => {
    const bot = await findChatBot(pool, masterKey, botId);
    if (bot?.config.kind !== "telegram") throw new Error("Không có bot Telegram.");
    await saveTelegramOffset(pool, masterKey, bot, 20);
    const response = await handleTelegramWebhook(
      { ...deps(), telegramPollingBotIds: [botId] },
      botId,
      new Request("http://hub/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": bot.config.webhookSecret },
        body: JSON.stringify(update(20)),
      }),
    );
    expect(response.status).toBe(200);
    expect(sent()).toHaveLength(0);
    await withTenant(pool, { orgId: org.orgId, userId: org.user("admin") }, (tx) =>
      updateBot(tx, masterKey, org.user("admin"), {
        id: botId,
        config: { kind: "telegram", botToken: bot.config.botToken },
      }),
    );
    expect((await findChatBot(pool, masterKey, botId))?.config).toMatchObject({ nextUpdateId: 20 });
    await withTenant(pool, { orgId: org.orgId, userId: org.user("admin") }, (tx) =>
      updateBot(tx, masterKey, org.user("admin"), {
        id: botId,
        config: { kind: "telegram", botToken: `123456:${randomUUID().replaceAll("-", "")}` },
      }),
    );
    expect((await findChatBot(pool, masterKey, botId))?.config).not.toHaveProperty("nextUpdateId");
  });
});
