import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type FakeChatApis, startFakeChatApis } from "../../../test/chat-fakes.ts";
import { ChatSendError, probeBot, type StoredBotConfig, sendChat, slackBlocks, telegramText } from "./adapters.ts";

let fake: FakeChatApis;
beforeAll(async () => {
  fake = await startFakeChatApis();
});
afterAll(() => fake.close());
beforeEach(() => fake.reset());

const telegram: StoredBotConfig = {
  kind: "telegram",
  botToken: "123456:ABCdefGhIJKlmnOPQrstUVwxyz0123456789",
  webhookSecret: "secret-webhook-123",
};
const slack: StoredBotConfig = { kind: "slack", botToken: "xoxb-1234567890-abcdef", signingSecret: "abcdef0123456789" };
const apis = () => ({ telegramApi: fake.telegramApi, slackApi: fake.slackApi });

describe("Telegram", () => {
  it("gửi tin HTML đã thoát ký tự, kèm nút callback và nút URL", async () => {
    await sendChat(
      telegram,
      "42",
      {
        title: "Kế hoạch <PAY-1>",
        text: "a & b",
        buttons: [
          { label: "Duyệt", callback: "o:x:0" },
          { label: "Mở trên web", url: "https://hive.example/tasks/PAY-1" },
        ],
      },
      apis(),
    );
    const [call] = fake.sent("telegram");
    expect(call?.body).toMatchObject({
      chat_id: "42",
      text: "<b>Kế hoạch &lt;PAY-1&gt;</b>\n\na &amp; b",
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Duyệt", callback_data: "o:x:0" },
            { text: "Mở trên web", url: "https://hive.example/tasks/PAY-1" },
          ],
        ],
      },
    });
  });

  it("lỗi 403 là vĩnh viễn, 500 là tạm thời, và token không lọt vào thông báo lỗi", async () => {
    fake.failTelegram(403, 500);
    const permanent = await sendChat(telegram, "42", { text: "x" }, apis()).catch((e) => e);
    expect(permanent).toBeInstanceOf(ChatSendError);
    expect(permanent.permanent).toBe(true);
    const transient = await sendChat(telegram, "42", { text: "x" }, apis()).catch((e) => e);
    expect(transient.permanent).toBe(false);
    expect(`${permanent.message}${transient.message}`).not.toContain(telegram.botToken);
  });

  it("mất kết nối là lỗi tạm thời và không lộ token trong địa chỉ", async () => {
    const err = await sendChat(telegram, "42", { text: "x" }, { telegramApi: "http://127.0.0.1:1" }).catch((e) => e);
    expect(err).toBeInstanceOf(ChatSendError);
    expect(err.permanent).toBe(false);
    expect(err.message).not.toContain(telegram.botToken);
  });

  it("probeBot: getMe rồi setWebhook kèm secret, chỉ với địa chỉ https", async () => {
    const result = await probeBot(telegram, "https://hive.example/hooks/chat/telegram/abc", apis());
    expect(result.target).toBe("@hive_test_bot");
    const hook = fake.calls.find((c) => c.method === "setWebhook");
    expect(hook?.body).toMatchObject({
      url: "https://hive.example/hooks/chat/telegram/abc",
      secret_token: "secret-webhook-123",
      allowed_updates: ["message", "callback_query"],
    });
    fake.reset();
    const http = await probeBot(telegram, "http://localhost:4000/hooks/chat/telegram/abc", apis());
    expect(http.message).toContain("https");
    expect(fake.calls.some((c) => c.method === "setWebhook")).toBe(false);
  });

  it("telegramText không để thẻ HTML lạ lọt qua", () => {
    expect(telegramText({ text: "<script>x</script>" })).toBe("&lt;script&gt;x&lt;/script&gt;");
  });
});

describe("Slack", () => {
  it("chat.postMessage mang Bearer token, khối section và nút", async () => {
    await sendChat(
      slack,
      "U1",
      {
        title: "Duyệt?",
        text: "a < b",
        buttons: [
          { label: "Duyệt", callback: "o:x:0" },
          { label: "Web", url: "https://h" },
        ],
      },
      apis(),
    );
    const [call] = fake.sent("slack");
    expect(call?.headers.authorization).toBe(`Bearer ${slack.botToken}`);
    expect(call?.body.channel).toBe("U1");
    const blocks = call?.body.blocks as Array<{ type: string; elements?: Array<Record<string, unknown>> }>;
    expect(blocks[0]).toMatchObject({ type: "section", text: { type: "mrkdwn", text: "*Duyệt?*\na &lt; b" } });
    expect(blocks[1]?.elements).toEqual([
      { type: "button", text: { type: "plain_text", text: "Duyệt" }, action_id: "hive_0", value: "o:x:0" },
      { type: "button", text: { type: "plain_text", text: "Web" }, action_id: "hive_1", url: "https://h" },
    ]);
  });

  it("invalid_auth là vĩnh viễn, ratelimited là tạm thời", async () => {
    fake.failSlack("invalid_auth", "ratelimited");
    const a = await sendChat(slack, "U1", { text: "x" }, apis()).catch((e) => e);
    const b = await sendChat(slack, "U1", { text: "x" }, apis()).catch((e) => e);
    expect([a.permanent, b.permanent]).toEqual([true, false]);
  });

  it("probeBot dùng auth.test và nhắc dán URL webhook", async () => {
    const result = await probeBot(slack, null, apis());
    expect(result.target).toBe("Acme / @hive");
    expect(result.message).toContain("webhook");
  });

  it("slackBlocks không có khối nút khi không có nút", () => {
    expect(slackBlocks({ text: "x" })).toHaveLength(1);
  });
});
