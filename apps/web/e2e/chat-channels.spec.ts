import { expect, type Page, test } from "@playwright/test";
import { type ChatBot, type ChatLink, type ChatSettings, DEFAULT_CHAT_SETTINGS } from "@xdev-hive/contracts";
import { fakeHub, ok, type RpcHandler } from "./fake-hub.ts";

const at = "2026-10-14T08:00:00.000Z";
const orgId = "00000000-0000-4000-8000-000000000001";
const botId = "00000000-0000-4000-8000-0000000000b1";
const linkId = "00000000-0000-4000-8000-0000000000c1";

const bot: ChatBot = {
  id: botId,
  kind: "slack",
  name: "Hive Slack",
  target: "T0123 · hive-bot",
  enabled: true,
  webhooks: [{ label: "Request URL (Events, Interactivity, /hive)", url: "https://hive.example.com/v1/chat/slack/b1" }],
  createdAt: at,
  updatedAt: at,
};

const link: ChatLink = {
  id: linkId,
  botId,
  botName: bot.name,
  kind: "slack",
  label: "duy.tran",
  events: ["run.failed", "plan.awaiting_approval"],
  createdAt: at,
};

async function setup(page: Page, role: string, rpc: Record<string, RpcHandler> = {}) {
  return fakeHub(page, {
    signedIn: true,
    rpc: {
      "orgs/mine": () =>
        ok({
          orgs: [{ id: orgId, slug: "example", name: "Đội phát triển", role, emailDomain: null, createdAt: at }],
          canCreateOrg: false,
        }),
      "notificationChannels/list": () => ok([]),
      "inbox/list": () => ok({ items: [], nextCursor: null }),
      "inbox/unreadCount": () => ok({ count: 0 }),
      "chat/links/list": () => ok([]),
      "chat/links/available": () => ok([{ id: botId, kind: "slack", name: bot.name, target: bot.target }]),
      ...rpc,
    },
  });
}

test("member links a chat account with a one-time code and picks events; admin-only sections stay hidden", async ({
  page,
}) => {
  let links: ChatLink[] = [];
  const hub = await setup(page, "member", {
    "chat/links/list": () => ok(links),
    "chat/links/createCode": () =>
      ok({ code: "ABCD-EFGH", expiresAt: "2026-10-14T08:10:00.000Z", command: "/hive link ABCD-EFGH" }),
    "chat/links/update": (raw) => {
      const input = raw as { events: ChatLink["events"] };
      links = links.map((item) => ({ ...item, events: input.events }));
      return ok(links[0]);
    },
    "chat/links/remove": () => {
      links = [];
      return ok({ id: linkId });
    },
  });
  await page.goto("/notifications");
  const section = page.getByRole("region", { name: "Chat Telegram và Slack" });
  await expect(section.getByRole("heading", { name: "Chưa liên kết chat" })).toBeVisible();
  await section.getByRole("button", { name: "Tạo mã liên kết" }).click();
  await expect(section.getByRole("status")).toContainText("/hive link ABCD-EFGH");
  expect(hub.rpcCalls.find((call) => call.path === "chat/links/createCode")?.input).toEqual({ botId });

  links = [link];
  await page.reload();
  const events = page.getByRole("group", { name: "Sự kiện nhận qua duy.tran" });
  await expect(events.getByLabel("Run thất bại")).toBeChecked();
  await events.getByLabel("Merge thất bại").check();
  await page.getByRole("button", { name: "Lưu sự kiện" }).click();
  await expect
    .poll(() => hub.rpcCalls.find((call) => call.path === "chat/links/update")?.input)
    .toEqual({ id: linkId, events: ["run.failed", "plan.awaiting_approval", "merge.failed"] });

  await page.getByRole("button", { name: "Tách duy.tran" }).click();
  expect(hub.rpcCalls.some((call) => call.path === "chat/links/remove")).toBe(false);
  await page.getByRole("dialog").getByRole("button", { name: "Tách liên kết" }).click();
  await expect(section.getByRole("heading", { name: "Chưa liên kết chat" })).toBeVisible();

  await expect(section.getByRole("heading", { name: "Bot chat của tổ chức" })).toHaveCount(0);
  expect(
    hub.rpcCalls.some((call) => call.path.startsWith("chat/bots/") || call.path.startsWith("chat/settings/")),
  ).toBe(false);
  expect(hub.rpcCalls.filter((call) => call.path.startsWith("chat/")).every((call) => call.org === orgId)).toBe(true);
});

test("admin adds a Slack bot, sees webhook URL, tests the connection, saves settings and removes the bot", async ({
  page,
}) => {
  let bots: ChatBot[] = [];
  let settings: ChatSettings = DEFAULT_CHAT_SETTINGS;
  const hub = await setup(page, "admin", {
    "chat/bots/list": () => ok(bots),
    "chat/bots/create": () => {
      bots = [bot];
      return ok(bot);
    },
    "chat/bots/test": () => ok({ ok: false, message: "Slack từ chối token bot. Kiểm tra lại cấu hình." }),
    "chat/bots/remove": () => {
      bots = [];
      return ok({ id: botId });
    },
    "chat/settings/get": () => ok(settings),
    "chat/settings/update": (raw) => {
      settings = { ...settings, ...(raw as Partial<ChatSettings>) };
      return ok(settings);
    },
  });
  await page.goto("/notifications");
  await expect(page.getByRole("heading", { name: "Chưa có bot chat" })).toBeVisible();

  await page.getByRole("button", { name: "Thêm bot" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Tên bot").fill(bot.name);
  await dialog.getByLabel("Loại bot").selectOption("slack");
  await dialog.getByLabel("Bot token Slack").fill("not-a-token");
  await dialog.getByLabel("Signing secret Slack").fill("0123456789abcdef0123456789abcdef");
  await dialog.getByRole("button", { name: "Lưu bot" }).click();
  await expect(dialog.getByRole("alert")).toContainText("xoxb-");
  expect(hub.rpcCalls.some((call) => call.path === "chat/bots/create")).toBe(false);
  await dialog.getByLabel("Bot token Slack").fill("xoxb-1234567890-abcdefghij");
  await dialog.getByRole("button", { name: "Lưu bot" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(hub.rpcCalls.find((call) => call.path === "chat/bots/create")?.input).toMatchObject({
    name: bot.name,
    enabled: true,
    config: {
      kind: "slack",
      botToken: "xoxb-1234567890-abcdefghij",
      signingSecret: "0123456789abcdef0123456789abcdef",
    },
  });
  await expect(page.getByText("https://hive.example.com/v1/chat/slack/b1")).toBeVisible();
  await expect(page.getByText("xoxb-1234567890-abcdefghij")).toHaveCount(0);

  await page.getByRole("button", { name: `Kiểm tra bot ${bot.name}` }).click();
  await expect(page.getByRole("alert")).toContainText("Slack từ chối token bot");

  const form = page.getByRole("form", { name: "Cài đặt chat" });
  await expect(form.getByLabel("Số tin Leader mỗi người mỗi ngày")).toHaveValue("30");
  await form.getByLabel("Cho bot nhận lệnh trong nhóm").check();
  await form.getByLabel("Số tin Leader mỗi người mỗi ngày").fill("10");
  await form.getByRole("button", { name: "Lưu cài đặt" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đã lưu cài đặt chat." })).toBeVisible();
  expect(hub.rpcCalls.find((call) => call.path === "chat/settings/update")?.input).toEqual({
    allowGroups: true,
    userDailyLimit: 10,
    orgDailyLimit: 300,
    leaderModel: "sonnet",
  });

  await page.getByRole("button", { name: `Xoá bot ${bot.name}` }).click();
  expect(hub.rpcCalls.some((call) => call.path === "chat/bots/remove")).toBe(false);
  await page.getByRole("dialog").getByRole("button", { name: "Xoá bot" }).click();
  await expect(page.getByRole("heading", { name: "Chưa có bot chat" })).toBeVisible();
});
