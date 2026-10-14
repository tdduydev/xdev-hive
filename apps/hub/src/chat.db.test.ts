// Telegram và Slack: bot, liên kết bằng mã một lần, thông báo tới chat, lệnh và nút bấm (kiểm quyền như web), Leader qua
// chat với giới hạn lượt, chặn nhóm, giới hạn tốc độ, audit. Adapter nói chuyện với máy chủ giả qua HTTP thật.
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { type FakeChatApis, slackHeaders, startFakeChatApis } from "../test/chat-fakes.ts";
import { type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import { seedProject } from "../test/project-fixture.ts";
import {
  availableBots,
  CHAT_QUEUE,
  type ChatDeps,
  chatQueue,
  createBot,
  createLinkCode,
  decryptBotConfig,
  deliverOutbox,
  getSettings,
  handleSlackWebhook,
  handleTelegramWebhook,
  installChatHooks,
  linkAttemptLimiter,
  listBots,
  listMyLinks,
  messageLimiter,
  registerChatWorker,
  removeMyLink,
  updateBot,
  updateMyLinkEvents,
  updateSettings,
} from "./modules/chat/index.ts";
import {
  appendLeaderSystemMessage,
  registerMcpTools as leaderMcpTools,
  queuedLeaderPrompt,
} from "./modules/leader/index.ts";
import { type McpPrincipal, McpToolRegistry } from "./modules/mcp/index.ts";
import { notify } from "./modules/notify/index.ts";
import { createJobs, createPool, parseMasterKey, type Tx, withTenant } from "./modules/platform/index.ts";
import { createRunsEngine, type RunsEngine } from "./modules/runs/index.ts";
import { createMemoryProvider } from "./modules/scm/index.ts";
import { createTask } from "./modules/tasks/index.ts";

const { adminUrl, appUrl, jobsUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const PUBLIC = "https://hive.test";
const TOKEN = "123456:ABCdefGhIJKlmnOPQrstUVwxyz0123456789";
const SIGNING = "abcdef0123456789abcdef0123456789";

let org: OrgFixture & { user: (n: string) => string };
let fake: FakeChatApis;
let engine: RunsEngine;
let deps: ChatDeps;
let projectId = "";
let projectKey = "";
let tgBot: { id: string };
let tgSecret = "";
let slackBot: { id: string };

const asUser = <T>(name: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(pool, { userId: org.user(name), orgId: org.orgId }, fn);

// ---- Telegram ------------------------------------------------------------------------------------------------

let seq = 1;
const tgRequest = (update: unknown, opts: { botId?: string; secret?: string; raw?: string } = {}) =>
  new Request(`http://hub/hooks/chat/telegram/${opts.botId ?? tgBot.id}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": opts.secret ?? tgSecret },
    body: opts.raw ?? JSON.stringify(update),
  });
const chatOf = (from: number, type = "private") => ({ id: type === "private" ? from : -1000 - from, type });

/** Gửi một tin Telegram từ tài khoản `from` và trả các tin bot gửi lại (đã gửi qua máy chủ giả). */
async function say(from: number, text: string, type = "private", d: ChatDeps = deps) {
  fake.reset();
  const res = await handleTelegramWebhook(
    d,
    tgBot.id,
    tgRequest({
      update_id: seq++,
      message: { message_id: seq, from: { id: from, first_name: "Ai đó" }, chat: chatOf(from, type), text },
    }),
  );
  expect(res.status).toBe(200);
  return fake.sent("telegram");
}

/** Bấm nút `data` ở tin bất kỳ của `from`. */
async function press(from: number, data: string, type = "private") {
  fake.reset();
  const res = await handleTelegramWebhook(
    deps,
    tgBot.id,
    tgRequest({
      update_id: seq++,
      callback_query: {
        id: `cb-${seq}`,
        data,
        from: { id: from },
        message: { message_id: 77, chat: chatOf(from, type) },
      },
    }),
  );
  expect(res.status).toBe(200);
  return fake.sent("telegram");
}

const texts = (calls: { body: Record<string, unknown> }[]) => calls.map((c) => String(c.body.text));
const keyboard = (call: { body: Record<string, unknown> } | undefined) =>
  (
    (call?.body.reply_markup as { inline_keyboard: Array<Array<Record<string, string>>> } | undefined)
      ?.inline_keyboard ?? []
  ).flat();
const callbacks = (call: { body: Record<string, unknown> } | undefined) =>
  keyboard(call).flatMap((b) => (b.callback_data ? [b.callback_data] : []));

async function link(user: string, ext: number) {
  const code = await asUser(user, (tx) => createLinkCode(tx, org.user(user), tgBot.id));
  const sent = await say(ext, `/link ${code.code}`);
  expect(texts(sent)[0]).toContain("Đã liên kết");
}

const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await admin.query(sql, params)).rows[0] as T;
const count = async (sql: string, params: unknown[] = []) =>
  Number((await one<{ n: string }>(`select count(*) as n from (${sql}) q`, params)).n);

async function seedApproval(createdBy: string, title: string, userForThread = createdBy) {
  const thread = await one<{ id: string }>(
    "insert into hive.chat_threads (org_id, project_id, created_by, title) values ($1, $2, $3, 'Đề xuất') returning id",
    [org.orgId, projectId, org.user(userForThread)],
  );
  const approval = await one<{ id: string }>(
    "insert into hive.approvals (org_id, thread_id, action, expires_at) values ($1, $2, $3, now() + interval '1 day') returning id",
    [org.orgId, thread.id, JSON.stringify({ type: "task.create", projectId, title, body: "" })],
  );
  void createdBy;
  return approval.id;
}

beforeAll(async () => {
  fake = await startFakeChatApis();
  org = await seedOrg(admin, `chat-${tag}`);
  projectKey = `CH${tag}`.toUpperCase();
  const project = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: projectKey,
  });
  projectId = project.projectId;
  const provider = createMemoryProvider("gitlab", ["xdev-team"]);
  provider.seedRepo({ owner: project.owner, name: project.repo });
  engine = createRunsEngine({
    pool,
    publicUrl: PUBLIC,
    authSecret: "test-secret-0123456789abcdef-0123456789",
    masterKey,
    providerFactory: () => provider,
    logger: quiet,
    leaderMessage: appendLeaderSystemMessage,
    leaderQueuedPrompt: queuedLeaderPrompt,
  });
  deps = { pool, masterKey, runs: engine, publicUrl: PUBLIC, telegramApi: fake.telegramApi, slackApi: fake.slackApi };
  const admin1 = org.user("admin");
  tgBot = await withTenant(pool, { userId: admin1, orgId: org.orgId }, (tx) =>
    createBot(tx, masterKey, admin1, { name: "tg", config: { kind: "telegram", botToken: TOKEN } }),
  );
  const row = await one<{ config_enc: string }>("select config_enc from hive.chat_bots where id = $1", [tgBot.id]);
  const config = decryptBotConfig(masterKey, tgBot.id, row.config_enc);
  if (config.kind !== "telegram") throw new Error("sai loại bot");
  tgSecret = config.webhookSecret;
  slackBot = await withTenant(pool, { userId: admin1, orgId: org.orgId }, (tx) =>
    createBot(tx, masterKey, admin1, {
      name: "slack",
      config: { kind: "slack", botToken: "xoxb-1234567890-abcdefghij", signingSecret: SIGNING },
    }),
  );
  installChatHooks({ publicUrl: PUBLIC });
});

beforeEach(() => {
  messageLimiter.reset();
  linkAttemptLimiter.reset();
  fake.reset();
});

afterAll(async () => {
  installChatHooks(undefined);
  await fake.close();
  engine.stop();
  await Promise.all([admin.end(), pool.end()]);
});

describe("bot và cài đặt", () => {
  it("chỉ quản trị tổ chức tạo và xem bot; thành viên chỉ thấy bot đang bật, không có cấu hình", async () => {
    await expect(asUser("tmember", (tx) => listBots(tx, org.user("tmember")))).rejects.toMatchObject({
      name: "ForbiddenError",
    });
    await expect(
      asUser("tmember", (tx) =>
        createBot(tx, masterKey, org.user("tmember"), { name: "x", config: { kind: "telegram", botToken: TOKEN } }),
      ),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
    const all = await asUser("admin", (tx) => listBots(tx, org.user("admin")));
    expect(all.map((b) => b.name).sort()).toEqual(["slack", "tg"]);
    const open = await asUser("tmember", (tx) => availableBots(tx, org.user("tmember")));
    expect(open.map((b) => b.name).sort()).toEqual(["slack", "tg"]);
    expect(JSON.stringify(open)).not.toContain(TOKEN);
  });

  it("tên bot không trùng; đổi token giữ nguyên secret webhook; không đổi loại bot", async () => {
    await expect(
      asUser("admin", (tx) =>
        createBot(tx, masterKey, org.user("admin"), { name: "tg", config: { kind: "telegram", botToken: TOKEN } }),
      ),
    ).rejects.toMatchObject({ name: "ConflictError", code: "CHAT_BOT_NAME_TAKEN" });
    const newToken = "654321:ZYXwvuTSRqponMLKjihGFEdcba9876543210";
    await asUser("admin", (tx) =>
      updateBot(tx, masterKey, org.user("admin"), { id: tgBot.id, config: { kind: "telegram", botToken: newToken } }),
    );
    const row = await one<{ config_enc: string }>("select config_enc from hive.chat_bots where id = $1", [tgBot.id]);
    expect(decryptBotConfig(masterKey, tgBot.id, row.config_enc)).toMatchObject({
      botToken: newToken,
      webhookSecret: tgSecret,
    });
    await expect(
      asUser("admin", (tx) =>
        updateBot(tx, masterKey, org.user("admin"), {
          id: tgBot.id,
          config: { kind: "slack", botToken: "xoxb-1234567890-abcdefghij", signingSecret: SIGNING },
        }),
      ),
    ).rejects.toMatchObject({ code: "CHAT_BOT_KIND_FIXED" });
    // Trả token cũ để các test sau gọi đúng server giả (server giả không kiểm token).
    await asUser("admin", (tx) =>
      updateBot(tx, masterKey, org.user("admin"), { id: tgBot.id, config: { kind: "telegram", botToken: TOKEN } }),
    );
  });

  it("audit ghi tạo bot không kèm token", async () => {
    const rows = await admin.query("select data from hive.audit_log where org_id = $1 and action like 'chat_bot.%'", [
      org.orgId,
    ]);
    expect(rows.rowCount).toBeGreaterThan(0);
    expect(JSON.stringify(rows.rows)).not.toContain("123456:");
  });

  it("cài đặt mặc định, chỉ quản trị đổi được, và đổi từng phần", async () => {
    expect(await asUser("admin", (tx) => getSettings(tx, org.user("admin")))).toEqual({
      allowGroups: false,
      userDailyLimit: 30,
      orgDailyLimit: 300,
      leaderModel: "sonnet",
    });
    await expect(
      asUser("tmember", (tx) => updateSettings(tx, org.user("tmember"), { allowGroups: true })),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
    const next = await asUser("admin", (tx) => updateSettings(tx, org.user("admin"), { userDailyLimit: 5 }));
    expect(next).toMatchObject({ allowGroups: false, userDailyLimit: 5, orgDailyLimit: 300, leaderModel: "sonnet" });
    const unset = await asUser("admin", (tx) => updateSettings(tx, org.user("admin"), { leaderModel: null }));
    expect(unset.leaderModel).toBeNull();
    await asUser("admin", (tx) => updateSettings(tx, org.user("admin"), { userDailyLimit: 30, leaderModel: "sonnet" }));
  });
});

describe("xác thực webhook", () => {
  it("Telegram: sai secret 403, bot lạ 404, JSON hỏng 400, bot tắt thì bỏ qua", async () => {
    const wrong = await handleTelegramWebhook(deps, tgBot.id, tgRequest({}, { secret: "sai" }));
    expect(wrong.status).toBe(403);
    const missing = await handleTelegramWebhook(deps, randomUUID(), tgRequest({}, { botId: randomUUID() }));
    expect(missing.status).toBe(404);
    const slackAsTelegram = await handleTelegramWebhook(deps, slackBot.id, tgRequest({}, { botId: slackBot.id }));
    expect(slackAsTelegram.status).toBe(404);
    const bad = await handleTelegramWebhook(deps, tgBot.id, tgRequest({}, { raw: "{không phải json" }));
    expect(bad.status).toBe(400);

    await asUser("admin", (tx) => updateBot(tx, masterKey, org.user("admin"), { id: tgBot.id, enabled: false }));
    expect(await say(5000, "/help")).toEqual([]);
    await asUser("admin", (tx) => updateBot(tx, masterKey, org.user("admin"), { id: tgBot.id, enabled: true }));
    expect(texts(await say(5000, "/help"))[0]).toContain("chưa liên kết");
  });

  const slackReq = (route: string, body: string, headers: Record<string, string>, type = "application/json") =>
    new Request(`http://hub/hooks/chat/slack/${slackBot.id}/${route}`, {
      method: "POST",
      headers: { "content-type": type, ...headers },
      body,
    });
  const slackCall = (route: "events" | "commands" | "interact", body: string, type = "application/json", o = {}) =>
    handleSlackWebhook(deps, slackBot.id, route, slackReq(route, body, slackHeaders(SIGNING, body, o), type));

  it("Slack: chữ ký sai hoặc giờ lệch quá 5 phút bị từ chối; url_verification trả challenge", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const bad = await handleSlackWebhook(
      deps,
      slackBot.id,
      "events",
      slackReq("events", body, slackHeaders("secret-khac-0123456789", body)),
    );
    expect(bad.status).toBe(401);
    const stale = await slackCall("events", body, "application/json", { ts: Math.floor(Date.now() / 1000) - 600 });
    expect(stale.status).toBe(401);
    const ok = await slackCall("events", body);
    expect(await ok.json()).toEqual({ challenge: "abc123" });
    const noSig = await handleSlackWebhook(deps, slackBot.id, "events", slackReq("events", body, {}));
    expect(noSig.status).toBe(401);
  });
});

describe("liên kết tài khoản", () => {
  it("mã có dạng ABCD-EFGH, chỉ lưu băm, và tạo mã mới thì mã cũ hết hiệu lực", async () => {
    const first = await asUser("tviewer", (tx) => createLinkCode(tx, org.user("tviewer"), tgBot.id));
    expect(first.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(first.command).toBe(`/link ${first.code}`);
    const stored = await admin.query("select code_hash from hive.chat_link_codes where user_id = $1", [
      org.user("tviewer"),
    ]);
    expect(JSON.stringify(stored.rows)).not.toContain(first.code.replace("-", ""));
    const second = await asUser("tviewer", (tx) => createLinkCode(tx, org.user("tviewer"), tgBot.id));
    expect(await count("select 1 from hive.chat_link_codes where user_id = $1", [org.user("tviewer")])).toBe(1);
    expect(texts(await say(2002, `/link ${first.code}`))[0]).toContain("Mã không đúng");
    expect(texts(await say(2002, `/link ${second.code}`))[0]).toContain("Đã liên kết");
    // Tài khoản chat 2002 là tviewer: dùng cho các test sau.
  });

  it("liên kết theo id tài khoản chat, không theo tên hiển thị", async () => {
    const code = await asUser("tmember", (tx) => createLinkCode(tx, org.user("tmember"), tgBot.id));
    // Người lạ tự xưng tên "admin" vẫn không liên kết và không lấy được quyền của ai.
    fake.reset();
    await handleTelegramWebhook(
      deps,
      tgBot.id,
      tgRequest({
        update_id: seq++,
        message: {
          message_id: 1,
          from: { id: 3001, username: "admin", first_name: "admin" },
          chat: { id: 3001, type: "private" },
          text: "/pending",
        },
      }),
    );
    expect(texts(fake.sent("telegram"))[0]).toContain("chưa liên kết");
    expect(texts(await say(1001, `/link ${code.code.toLowerCase()}`))[0]).toContain("Đã liên kết");
    const row = await one<{ user_id: string; external_user_id: string; events: string[] }>(
      "select user_id, external_user_id, events from hive.chat_links where bot_id = $1 and external_user_id = '1001'",
      [tgBot.id],
    );
    expect(row.user_id).toBe(org.user("tmember"));
    expect(row.events).toContain("run.failed");
    expect(row.events).toContain("plan.awaiting_approval");
  });

  it("mã dùng một lần, mã sai, mã hết hạn, và tài khoản chat đã gắn người khác", async () => {
    const used = await asUser("admin", (tx) => createLinkCode(tx, org.user("admin"), tgBot.id));
    expect(texts(await say(1001, `/link ${used.code}`))[0]).toContain("đã liên kết với người dùng khác");
    expect(await count("select 1 from hive.chat_links where user_id = $1", [org.user("admin")])).toBe(0);
    expect(texts(await say(1003, `/link ${used.code}`))[0]).toContain("Đã liên kết");
    expect(texts(await say(1003, `/link ${used.code}`))[0]).toContain("Mã không đúng");
    expect(texts(await say(1003, "/link AAAA-AAAA"))[0]).toContain("Mã không đúng");
    expect(texts(await say(1003, "/link"))[0]).toContain("Gửi kèm mã");

    const old = await asUser("loner", (tx) => createLinkCode(tx, org.user("loner"), tgBot.id));
    await admin.query("update hive.chat_link_codes set expires_at = now() - interval '1 minute' where user_id = $1", [
      org.user("loner"),
    ]);
    expect(texts(await say(1004, `/link ${old.code}`))[0]).toContain("Mã không đúng");
    await link("loner", 1004);
  });

  it("dò mã: quá 5 lần sai trong 10 phút thì bị chặn, kể cả khi sau đó nhập đúng", async () => {
    const code = await asUser("oadmin", (tx) => createLinkCode(tx, org.user("oadmin"), tgBot.id));
    for (let i = 0; i < 5; i++) expect(texts(await say(4001, `/link BBBB-BBB${i}`))[0]).toContain("Mã không đúng");
    expect(texts(await say(4001, "/link BBBB-BBB9"))[0]).toContain("quá nhiều lần");
    expect(texts(await say(4001, `/link ${code.code}`))[0]).toContain("quá nhiều lần");
    expect(await count("select 1 from hive.chat_links where user_id = $1", [org.user("oadmin")])).toBe(0);
  });

  it("người đã rời tổ chức không liên kết được bằng mã còn hạn", async () => {
    const gone = `gone-${tag}`;
    await admin.query(`insert into auth."user" (id, name, email) values ($1, $1, $1 || '@seed.test')`, [gone]);
    await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [
      org.orgId,
      gone,
    ]);
    const code = await withTenant(pool, { userId: gone, orgId: org.orgId }, (tx) => createLinkCode(tx, gone, tgBot.id));
    await admin.query("delete from hive.org_members where org_id = $1 and user_id = $2", [org.orgId, gone]);
    expect(texts(await say(4100, `/link ${code.code}`))[0]).toContain("Bạn không phải thành viên");
    expect(await count("select 1 from hive.chat_links where user_id = $1", [gone])).toBe(0);
  });

  it("danh sách, đổi sự kiện nhận, và tách liên kết trên web hoặc bằng /unlink", async () => {
    const links = await asUser("tviewer", (tx) => listMyLinks(tx, org.user("tviewer")));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ kind: "telegram", botName: "tg" });
    const updated = await asUser("tviewer", (tx) =>
      updateMyLinkEvents(tx, org.user("tviewer"), links[0]?.id ?? "", ["merge.failed", "merge.failed"]),
    );
    expect(updated.events).toEqual(["merge.failed"]);
    // Không đổi được liên kết của người khác.
    const mine = await asUser("tmember", (tx) => listMyLinks(tx, org.user("tmember")));
    await expect(
      asUser("tviewer", (tx) => updateMyLinkEvents(tx, org.user("tviewer"), mine[0]?.id ?? "", ["run.failed"])),
    ).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(
      asUser("tviewer", (tx) => removeMyLink(tx, org.user("tviewer"), mine[0]?.id ?? "", "web")),
    ).rejects.toMatchObject({ name: "NotFoundError" });

    const code = await asUser("oadmin", (tx) => createLinkCode(tx, org.user("oadmin"), tgBot.id));
    expect(texts(await say(4200, `/link ${code.code}`))[0]).toContain("Đã liên kết");
    expect(texts(await say(4200, "/unlink"))[0]).toContain("Đã tách");
    expect(texts(await say(4200, "/help"))[0]).toContain("chưa liên kết");
    const audit = await count("select 1 from hive.audit_log where org_id = $1 and action = 'chat_link.remove'", [
      org.orgId,
    ]);
    expect(audit).toBe(1);
  });
});

describe("lệnh, nút bấm và quyền", () => {
  it("/help và lệnh lạ; người chưa liên kết chỉ được hướng dẫn liên kết", async () => {
    expect(texts(await say(1001, "/help"))[0]).toContain("/pending");
    expect(texts(await say(1001, "/foo"))[0]).toContain("Không có lệnh “foo”");
    expect(texts(await say(1001, "/help@hive_test_bot"))[0]).toContain("/pending");
    const guest = texts(await say(9000, "/pending"))[0];
    expect(guest).toContain("chưa liên kết");
    expect(guest).toContain("/link MÃ");
    // Tin tự do của người chưa liên kết không tới Leader.
    expect(texts(await say(9000, "Tạo giúp tôi một task"))[0]).toContain("chưa liên kết");
    expect(await count("select 1 from hive.chat_threads where org_id = $1 and title like 'Chat %'", [org.orgId])).toBe(
      0,
    );
  });

  it("/pending kèm nút; chỉ chính người nhận bấm được; viewer bấm Duyệt bị từ chối đúng quyền; thành viên duyệt được", async () => {
    expect(texts(await say(1001, "/pending"))[0]).toContain("Không có đề xuất");
    const approvalId = await seedApproval("tmember", "Thêm hoàn tiền");

    const shown = await say(1001, "/pending");
    expect(shown).toHaveLength(1);
    expect(String(shown[0]?.body.text)).toContain("Thêm hoàn tiền");
    const [approveBtn, rejectBtn] = callbacks(shown[0]);
    expect(approveBtn).toMatch(/^o:[0-9a-f-]{36}:0$/);
    expect(rejectBtn).toMatch(/^o:[0-9a-f-]{36}:1$/);
    expect(keyboard(shown[0]).find((b) => b.url)?.url).toBe(`${PUBLIC}/leader`);
    expect(keyboard(shown[0]).map((b) => b.text)).toEqual(["Duyệt", "Từ chối", "Mở trên web"]);

    // Người khác (viewer đã liên kết) cầm nút của tmember: bị từ chối, đề xuất còn nguyên.
    const stolen = await press(2002, approveBtn ?? "");
    expect(texts(stolen)[0]).toContain("không dành cho tài khoản của bạn");
    expect(
      (await one<{ status: string }>("select status from hive.approvals where id = $1", [approvalId])).status,
    ).toBe("pending");

    // Viewer có nút riêng của mình nhưng không đủ quyền tạo việc: lỗi nghiệp vụ như web, không tạo gì.
    const viewerShown = await say(2002, "/pending");
    const viewerApprove = callbacks(viewerShown[0])[0] ?? "";
    const denied = await press(2002, viewerApprove);
    expect(texts(denied)[0]).toMatch(/^⚠️/);
    expect(
      (await one<{ status: string }>("select status from hive.approvals where id = $1", [approvalId])).status,
    ).toBe("pending");
    expect(await count("select 1 from hive.tasks where project_id = $1", [projectId])).toBe(0);
    // Lỗi thì giữ nút: không gỡ bàn phím.
    expect(fake.calls.some((c) => c.method === "editMessageReplyMarkup")).toBe(false);
    const deniedAudit = await one<{ data: { ok: boolean; name: string } }>(
      "select data from hive.audit_log where org_id = $1 and action = 'chat.action' and actor_user_id = $2",
      [org.orgId, org.user("tviewer")],
    );
    expect(deniedAudit.data).toMatchObject({ ok: false, name: "approval.approve", channel: "telegram" });

    // Thành viên đội bấm Duyệt: tạo việc, gỡ nút, báo kết quả.
    const done = await press(1001, approveBtn ?? "");
    expect(texts(done)[0]).toContain("Đã duyệt");
    const row = await one<{ status: string; decided_by: string }>(
      "select status, decided_by from hive.approvals where id = $1",
      [approvalId],
    );
    expect(row).toEqual({ status: "approved", decided_by: org.user("tmember") });
    expect(
      await count("select 1 from hive.tasks where project_id = $1 and title = 'Thêm hoàn tiền'", [projectId]),
    ).toBe(1);
    expect(fake.calls.some((c) => c.method === "answerCallbackQuery")).toBe(true);
    expect(fake.calls.find((c) => c.method === "editMessageReplyMarkup")?.body).toMatchObject({
      reply_markup: { inline_keyboard: [] },
    });
    const audit = await one<{ data: Record<string, unknown> }>(
      "select data from hive.audit_log where org_id = $1 and action = 'chat.action' and actor_user_id = $2 and data->>'ok' = 'true'",
      [org.orgId, org.user("tmember")],
    );
    expect(audit.data).toMatchObject({ channel: "telegram", name: "approval.approve" });

    // Bấm lại: đề xuất không còn chờ.
    expect(texts(await press(1001, approveBtn ?? ""))[0]).toContain("không còn chờ");
  });

  it("nút hết hạn, nút hỏng và nút trỏ tới hành động không có", async () => {
    const approvalId = await seedApproval("tmember", "Việc hết hạn");
    const shown = await say(1001, "/pending");
    const btn = callbacks(shown.find((c) => String(c.body.text).includes("Việc hết hạn")))[0] ?? "";
    expect(approvalId).toBeTruthy();
    expect(texts(await press(1001, "o:không-phải-uuid:0"))).toEqual([]);
    expect(texts(await press(1001, btn.replace(/:0$/, ":9")))[0]).toContain("không còn hiệu lực");
    const id = btn.split(":")[1] ?? "";
    await admin.query("update hive.chat_outbox set created_at = now() - interval '8 days' where id = $1", [id]);
    expect(texts(await press(1001, btn))[0]).toContain("hết hạn");
    await admin.query("update hive.approvals set status = 'rejected' where id = $1", [approvalId]);
  });

  it("/approve và /reject theo 8 ký tự đầu của id; từ chối ghi lý do", async () => {
    const a = await seedApproval("tmember", "Việc A");
    const b = await seedApproval("tmember", "Việc B");
    expect(texts(await say(1001, "/approve"))[0]).toContain("Cách dùng");
    expect(texts(await say(1001, "/approve zzzz"))[0]).toContain("Cách dùng");
    expect(texts(await say(1001, "/approve 00000000"))[0]).toContain("Không thấy");
    expect(texts(await say(1001, `/approve ${a.slice(0, 8)}`))[0]).toContain("Đã duyệt");
    expect(texts(await say(1001, `/reject ${b.slice(0, 8)} chưa rõ phạm vi`))[0]).toContain("Đã từ chối");
    const rejected = await one<{ status: string; reason: string }>(
      "select status, reason from hive.approvals where id = $1",
      [b],
    );
    expect(rejected).toEqual({ status: "rejected", reason: "chưa rõ phạm vi" });
    // Viewer thì /approve bị từ chối theo quyền, đề xuất còn chờ.
    const c = await seedApproval("tmember", "Việc C");
    expect(texts(await say(2002, `/approve ${c.slice(0, 8)}`))[0]).toMatch(/^⚠️/);
    expect((await one<{ status: string }>("select status from hive.approvals where id = $1", [c])).status).toBe(
      "pending",
    );
    await admin.query("update hive.approvals set status = 'rejected' where id = $1", [c]);
  });

  it("/runs, /run, /task, /cancel: xem trạng thái, huỷ run theo quyền", async () => {
    expect(texts(await say(1001, "/runs"))[0]).toContain("chưa có run");
    const task = await asUser("tmember", (tx) =>
      createTask(tx, org.user("tmember"), { projectId, title: "Sửa lỗi thanh toán", body: "" } as never),
    );
    const info = texts(await say(1001, `/task ${task.key.toLowerCase()}`))[0];
    expect(info).toContain("Sửa lỗi thanh toán");
    expect(info).toContain("chưa làm");
    expect(texts(await say(1001, "/task"))[0]).toContain("Cách dùng");
    expect(texts(await say(1004, `/task ${task.key}`))[0]).toMatch(/^⚠️/);

    const started = await asUser("tmember", (tx) => engine.startRun(tx, org.user("tmember"), { taskId: task.id }));
    const short = started.run.id.slice(0, 8);
    expect(texts(await say(1001, "/runs"))[0]).toContain(`${short} ${task.key} – đang chờ máy`);
    const detail = await say(1001, `/run ${short}`);
    expect(texts(detail)[0]).toContain("đang chờ máy");
    expect(keyboard(detail[0]).map((b) => b.text)).toContain("Huỷ run");

    // Viewer xem được run nhưng không huỷ được.
    expect(texts(await say(2002, `/cancel ${short}`))[0]).toMatch(/^⚠️/);
    expect((await one<{ state: string }>("select state from hive.runs where id = $1", [started.run.id])).state).toBe(
      "queued",
    );

    const cancelBtn = callbacks(detail[0])[0] ?? "";
    expect(texts(await press(1001, cancelBtn))[0]).toContain("Đã huỷ");
    expect((await one<{ state: string }>("select state from hive.runs where id = $1", [started.run.id])).state).toBe(
      "cancelled",
    );
    expect(texts(await say(1001, `/run ${short}`))[0]).toContain("đã huỷ");
    expect(texts(await say(1001, "/run xyz"))[0]).toContain("Mã run");
    expect(texts(await say(1001, "/cancel 00000000"))[0]).toContain("Không thấy");
  });

  it("/quota đọc tóm tắt tài khoản CLI trên máy của chính người dùng", async () => {
    expect(texts(await say(1001, "/quota"))[0]).toContain("chưa có máy");
    const accounts = [
      {
        id: "a1",
        cli: "claude",
        label: "Gói cá nhân",
        roles: [],
        enabled: true,
        loggedIn: true,
        sessionPct: 42,
        weekPct: 10,
        resetsAt: new Date(Date.now() + 135 * 60_000).toISOString(),
        stopAtSession: 0,
        stopAtWeek: 0,
        inUse: 0,
      },
    ];
    await admin.query(
      "insert into hive.machines (org_id, team_id, name, os, version, clis, capacity, registered_by, accounts) values ($1, $2, 'mac-mini', 'macos', '1', '{claude}', 2, $3, $4)",
      [org.orgId, org.teamId, org.user("tmember"), JSON.stringify(accounts)],
    );
    const quota = texts(await say(1001, "/quota"))[0] ?? "";
    expect(quota).toContain("mac-mini");
    expect(quota).toContain("phiên 42% · tuần 10%");
    expect(quota).toMatch(/đặt lại sau 2g\d\dp/);
    // Máy của người khác không lộ.
    expect(texts(await say(2002, "/quota"))[0]).toContain("chưa có máy");
  });

  it("/project chọn dự án theo đội của mình; người không thuộc đội không thấy dự án", async () => {
    const listed = texts(await say(1001, "/project"))[0] ?? "";
    expect(listed).toContain(projectKey);
    expect(texts(await say(1001, "/project NOPE"))[0]).toMatch(/^⚠️/);
    expect(texts(await say(1001, `/project ${projectKey.toLowerCase()}`))[0]).toContain(`Đã chọn dự án ${projectKey}`);
    expect(
      (await one<{ project_id: string }>("select project_id from hive.chat_links where external_user_id = '1001'"))
        .project_id,
    ).toBe(projectId);
    expect(texts(await say(1004, "/project"))[0]).toContain("chưa thuộc dự án nào");
    expect(texts(await say(1004, `/project ${projectKey}`))[0]).toMatch(/^⚠️/);
  });

  it("thành viên bị gỡ khỏi tổ chức thì liên kết còn nhưng lệnh bị từ chối và có audit", async () => {
    const gone = `gone2-${tag}`;
    await admin.query(`insert into auth."user" (id, name, email) values ($1, $1, $1 || '@seed.test')`, [gone]);
    await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [
      org.orgId,
      gone,
    ]);
    const code = await withTenant(pool, { userId: gone, orgId: org.orgId }, (tx) => createLinkCode(tx, gone, tgBot.id));
    expect(texts(await say(4300, `/link ${code.code}`))[0]).toContain("Đã liên kết");
    await admin.query("delete from hive.org_members where org_id = $1 and user_id = $2", [org.orgId, gone]);
    expect(texts(await say(4300, "/help"))[0]).toMatch(/^⚠️/);
    expect(texts(await say(4300, "/pending"))[0]).toMatch(/^⚠️/);
    const denied = await count(
      "select 1 from hive.audit_log where org_id = $1 and actor_user_id = $2 and data->>'ok' = 'false'",
      [org.orgId, gone],
    );
    expect(denied).toBe(2);
  });

  it("audit ghi mọi lệnh, kể cả lệnh chỉ đọc, kèm kênh và tên lệnh", async () => {
    await say(1001, "/help");
    const row = await one<{ data: Record<string, unknown> }>(
      "select data from hive.audit_log where org_id = $1 and action = 'chat.command' and actor_user_id = $2 order by created_at desc limit 1",
      [org.orgId, org.user("tmember")],
    );
    expect(row.data).toEqual({ channel: "telegram", name: "help", ok: true });
  });

  it("nút kế hoạch và review gọi hàm hub: không có đối tượng thì báo lỗi nghiệp vụ, không sập", async () => {
    const link = await one<{ id: string }>("select id from hive.chat_links where external_user_id = '1001'");
    const outbox = await one<{ id: string }>(
      `insert into hive.chat_outbox (org_id, link_id, kind, title, body, actions, status) values ($1, $2, 'command', 'x', 'y', $3, 'sent') returning id`,
      [
        org.orgId,
        link.id,
        JSON.stringify([
          { kind: "plan.approve", taskId: randomUUID(), planId: randomUUID() },
          { kind: "plan.reject", taskId: randomUUID(), planId: randomUUID() },
          { kind: "review.approve", reviewId: randomUUID() },
          { kind: "review.changes", reviewId: randomUUID() },
          { kind: "run.cancel", runId: randomUUID() },
          { kind: "approval.reject", approvalId: randomUUID() },
        ]),
      ],
    );
    for (let i = 0; i < 6; i++) {
      expect(texts(await press(1001, `o:${outbox.id}:${i}`))[0]).toMatch(/^⚠️/);
    }
  });
});

describe("chat nhóm và giới hạn tốc độ", () => {
  it("nhóm bị chặn khi tổ chức chưa bật; bật rồi chỉ nhận lệnh, không nhận tin tự do hay liên kết", async () => {
    const blocked = await say(1001, "/help", "supergroup");
    expect(texts(blocked)[0]).toContain("chưa bật chat nhóm");
    expect(blocked[0]?.body.chat_id).toBe("-2001");
    // Tin thường trong nhóm: im lặng, không tốn gì.
    expect(await say(1001, "xin chào mọi người", "supergroup")).toEqual([]);
    const pressed = await press(1001, "o:00000000-0000-0000-0000-000000000000:0", "supergroup");
    expect(texts(pressed)[0]).toContain("không dành cho");

    await asUser("admin", (tx) => updateSettings(tx, org.user("admin"), { allowGroups: true }));
    try {
      expect(texts(await say(1001, "/help", "supergroup"))[0]).toContain("/pending");
      expect(await say(1001, "Tạo task giúp tôi", "supergroup")).toEqual([]);
      expect(
        await count("select 1 from hive.chat_threads where org_id = $1 and title like 'Chat %'", [org.orgId]),
      ).toBe(0);
      const code = await asUser("admin", (tx) => createLinkCode(tx, org.user("admin"), tgBot.id));
      expect(texts(await say(7000, `/link ${code.code}`, "supergroup"))[0]).toContain("chat riêng");
    } finally {
      await asUser("admin", (tx) => updateSettings(tx, org.user("admin"), { allowGroups: false }));
    }
  });

  it("quá 20 tin một phút từ một tài khoản thì bị nhắc chậm lại, không chạy lệnh", async () => {
    let last: string[] = [];
    for (let i = 0; i < 21; i++) last = texts(await say(8000, "/help"));
    expect(last[0]).toContain("quá nhanh");
    // Tài khoản khác không bị ảnh hưởng.
    expect(texts(await say(8001, "/help"))[0]).toContain("chưa liên kết");
  });
});

describe("Leader qua chat", () => {
  const leaderUser = "tadmin";
  const ext = 1010;
  const usage = (userId: string) =>
    count("select 1 from hive.chat_usage where org_id = $1 and user_id = $2 and count > 0", [org.orgId, userId]);
  const usageCount = async (userId: string) =>
    Number(
      (
        await one<{ count: number }>(
          "select coalesce(sum(count), 0) as count from hive.chat_usage where org_id = $1 and user_id = $2",
          [org.orgId, userId],
        )
      ).count,
    );

  beforeAll(async () => {
    await link(leaderUser, ext);
  });

  it("tin tự do vào phiên Leader của người đó với model theo cài đặt; tin sau dùng lại phiên", async () => {
    const first = texts(await say(ext, "Tạo task hoàn tiền giúp mình"))[0] ?? "";
    expect(first).toContain(`Đã chuyển cho Leader (${projectKey})`);
    expect(first).toContain("Còn 29 lượt");
    const thread = await one<{ id: string; created_by: string; project_id: string; title: string }>(
      "select id, created_by, project_id, title from hive.chat_threads where created_by = $1 and title like 'Chat %'",
      [org.user(leaderUser)],
    );
    expect(thread).toMatchObject({ created_by: org.user(leaderUser), project_id: projectId });
    expect(thread.title).toContain("Telegram");
    const run = await one<{ kind: string; state: string; model: string; cli: string; created_by: string }>(
      "select kind, state, model, cli, created_by from hive.runs where leader_thread_id = $1",
      [thread.id],
    );
    expect(run).toEqual({
      kind: "leader",
      state: "queued",
      model: "sonnet",
      cli: "claude",
      created_by: org.user(leaderUser),
    });
    expect(
      (await one<{ thread_id: string }>("select thread_id from hive.chat_links where external_user_id = '1010'"))
        .thread_id,
    ).toBe(thread.id);

    expect(texts(await say(ext, "Thêm cả hoàn tiền một phần"))[0]).toContain("Còn 28 lượt");
    expect(
      await count("select 1 from hive.chat_threads where created_by = $1 and title like 'Chat %'", [
        org.user(leaderUser),
      ]),
    ).toBe(1);
    expect(await count("select 1 from hive.chat_messages where thread_id = $1 and role = 'user'", [thread.id])).toBe(2);
    expect(await count("select 1 from hive.runs where leader_thread_id = $1", [thread.id])).toBe(1);
    expect(await usageCount(org.user(leaderUser))).toBe(2);
    expect(await usageCount("")).toBe(2);
    // Mỗi tin tự do đã vào audit với độ dài, không chép nội dung.
    const audit = await one<{ data: Record<string, unknown> }>(
      "select data from hive.audit_log where org_id = $1 and action = 'chat.command' and data->>'name' = 'leader.message' limit 1",
      [org.orgId],
    );
    expect(audit.data).toMatchObject({ channel: "telegram", ok: true });
    expect(JSON.stringify(audit.data)).not.toContain("hoàn tiền");
  });

  it("/new bắt đầu phiên mới", async () => {
    expect(texts(await say(ext, "/new"))[0]).toContain("cuộc trò chuyện Leader mới");
    expect(texts(await say(ext, "Câu hỏi mới"))[0]).toContain("Còn 27 lượt");
    expect(
      await count("select 1 from hive.chat_threads where created_by = $1 and title like 'Chat %'", [
        org.user(leaderUser),
      ]),
    ).toBe(2);
  });

  it("hết lượt của người dùng: trả lời cố định, không lưu tin, không tăng lượt; lệnh vẫn dùng được", async () => {
    const before = await usageCount(org.user(leaderUser));
    const messages = await count("select 1 from hive.chat_messages where sender_id = $1", [org.user(leaderUser)]);
    await asUser("admin", (tx) => updateSettings(tx, org.user("admin"), { userDailyLimit: before }));
    try {
      expect(texts(await say(ext, "Thêm một câu nữa"))[0]).toContain(`hết ${before} lượt`);
      expect(await usageCount(org.user(leaderUser))).toBe(before);
      expect(await usageCount("")).toBe(before);
      expect(await count("select 1 from hive.chat_messages where sender_id = $1", [org.user(leaderUser)])).toBe(
        messages,
      );
      expect(texts(await say(ext, "/help"))[0]).toContain("/pending");
    } finally {
      await asUser("admin", (tx) => updateSettings(tx, org.user("admin"), { userDailyLimit: 30 }));
    }
  });

  it("hết lượt của tổ chức chặn cả người khác; giới hạn 0 tắt tin tự do", async () => {
    const total = await usageCount("");
    await asUser("admin", (tx) => updateSettings(tx, org.user("admin"), { orgDailyLimit: total }));
    try {
      expect(texts(await say(1001, "Tin của người khác"))[0]).toContain("Tổ chức đã dùng hết");
      expect(await usage(org.user("tmember"))).toBe(0);
    } finally {
      await asUser("admin", (tx) => updateSettings(tx, org.user("admin"), { orgDailyLimit: 300 }));
    }
    await asUser("admin", (tx) => updateSettings(tx, org.user("admin"), { userDailyLimit: 0 }));
    try {
      expect(texts(await say(1001, "Tin khi đã tắt"))[0]).toContain("chưa cho gửi tin tự do");
    } finally {
      await asUser("admin", (tx) => updateSettings(tx, org.user("admin"), { userDailyLimit: 30 }));
    }
  });

  it("không có dự án nào để chọn thì hỏi chọn dự án, không tốn lượt", async () => {
    expect(texts(await say(1004, "Xin chào Leader"))[0]).toContain("Chọn dự án cho Leader trước");
    expect(await usage(org.user("loner"))).toBe(0);
  });

  it("hub chưa cấu hình giao run thì báo lỗi rõ ràng", async () => {
    const noRuns = { ...deps, runs: undefined };
    expect(texts(await say(ext, "Xin chào", "private", noRuns))[0]).toContain("chưa cấu hình giao leader run");
  });

  it("câu trả lời và đề xuất của Leader về lại chat, đã che bí mật và code; nút duyệt chạy đề xuất", async () => {
    const registry = new McpToolRegistry();
    leaderMcpTools(registry);
    const tool = (name: string) => {
      const t = registry.list().find((x) => x.name === name);
      if (!t) throw new Error(`thiếu tool ${name}`);
      return t;
    };
    const thread = await one<{ id: string }>(
      "select thread_id as id from hive.chat_links where external_user_id = '1010'",
    );
    const run = await one<{ id: string; org_id: string; created_by: string }>(
      "select id, org_id, created_by from hive.runs where leader_thread_id = $1 order by created_at desc limit 1",
      [thread.id],
    );
    const principal: McpPrincipal = {
      kind: "run",
      userId: run.created_by,
      orgId: org.orgId,
      runId: run.id,
      runKind: "leader",
      projectId,
      scopes: [],
    };
    const call = (name: string, args: Record<string, unknown>) =>
      withTenant(pool, { userId: run.created_by, orgId: org.orgId }, (tx) =>
        tool(name).handler(args as never, { tx, orgId: org.orgId, principal }, undefined),
      );

    await call("leader_reply", {
      threadId: thread.id,
      content: "Đã xem.\n```ts\nconst key = 'sk-abcdefghijklmnopqrstuvwxyz';\n```\nToken: hwm_abcdefgh12345678",
    });
    const reply = await one<{ id: string; body: string; kind: string; title: string; actions: unknown[] }>(
      "select id, body, kind, title, actions from hive.chat_outbox where kind = 'leader' order by created_at desc limit 1",
    );
    expect(reply).toMatchObject({ kind: "leader", title: "Leader", actions: [] });
    expect(reply.body).toContain("[đoạn code đã ẩn");
    expect(reply.body).not.toContain("sk-abcdef");
    expect(reply.body).not.toContain("hwm_abcdefgh");
    const org1 = { orgId: org.orgId, outboxId: reply.id };
    fake.reset();
    expect(await deliverOutbox(deps, org1, quiet)).toBe("sent");
    const [delivered] = fake.sent("telegram");
    expect(delivered?.body.chat_id).toBe("1010");
    expect(String(delivered?.body.text)).toContain("<b>Leader</b>");
    expect(String(delivered?.body.text)).not.toContain("hwm_");

    await call("leader_propose", {
      threadId: thread.id,
      rationale: "Nên tách việc hoàn tiền.",
      action: { type: "task.create", projectId, title: "Hoàn tiền một phần", body: "" },
    });
    const proposal = await one<{ id: string; body: string; actions: Array<{ kind: string }> }>(
      "select id, body, actions from hive.chat_outbox where kind = 'leader' order by created_at desc limit 1",
    );
    expect(proposal.actions.map((a) => a.kind)).toEqual(["approval.approve", "approval.reject"]);
    expect(proposal.body).toContain("Đề xuất: Tạo việc “Hoàn tiền một phần”");
    fake.reset();
    expect(await deliverOutbox(deps, { orgId: org.orgId, outboxId: proposal.id }, quiet)).toBe("sent");
    const [sent] = fake.sent("telegram");
    expect(keyboard(sent).map((b) => b.text)).toEqual(["Duyệt", "Từ chối", "Mở trên web"]);
    const approve = callbacks(sent)[0] ?? "";
    expect(texts(await press(ext, approve))[0]).toContain("Đã duyệt");
    expect(await count("select 1 from hive.tasks where title = 'Hoàn tiền một phần'")).toBe(1);
  });

  it("thread không gắn với chat nào thì Leader không gửi gì ra ngoài", async () => {
    const before = await count("select 1 from hive.chat_outbox where org_id = $1", [org.orgId]);
    await say(1001, "/new");
    const other = await one<{ id: string }>(
      "insert into hive.chat_threads (org_id, project_id, created_by, title) values ($1, $2, $3, 'Trên web') returning id",
      [org.orgId, projectId, org.user("tmember")],
    );
    expect(other.id).toBeTruthy();
    expect(await count("select 1 from hive.chat_outbox where org_id = $1", [org.orgId])).toBeGreaterThanOrEqual(before);
  });
});

describe("thông báo tới chat", () => {
  const event = (over: Record<string, unknown> = {}) => ({
    orgId: org.orgId,
    event: "run.failed" as const,
    eventKey: randomUUID(),
    recipientIds: [org.user("tmember"), org.user("tviewer"), org.user("loner")],
    title: "Run PAY-1 thất bại",
    body: "Chi tiết lỗi\n```\nDB_TOKEN=abcdef123456\n```\nxem log trên web",
    link: "https://hive.test/tasks/PAY-1",
    ...over,
  });
  const emit = (over: Record<string, unknown> = {}) => asUser("admin", (tx) => notify(tx, event(over) as never));
  const outboxOf = async (user: string, key?: string) =>
    (
      await admin.query(
        `select o.* from hive.chat_outbox o join hive.chat_links l on l.id = o.link_id
         where l.user_id = $1 and o.kind = 'notification' ${key ? "and o.dedupe_key = $2" : ""} order by o.created_at`,
        key ? [org.user(user), key] : [org.user(user)],
      )
    ).rows as Array<{
      id: string;
      title: string;
      body: string;
      url: string | null;
      status: string;
      attempts: number;
      error: string | null;
      actions: unknown[];
    }>;

  it("chỉ người nhận có liên kết và chọn sự kiện đó mới nhận; chữ đã che bí mật và code", async () => {
    const eventKey = randomUUID();
    await emit({ eventKey });
    const mine = await outboxOf("tmember", `run.failed:${eventKey}`);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      status: "queued",
      title: "Run PAY-1 thất bại",
      url: "https://hive.test/tasks/PAY-1",
    });
    expect(mine[0]?.body).toContain("[đoạn code đã ẩn");
    expect(mine[0]?.body).not.toContain("abcdef123456");
    // tviewer chỉ chọn merge.failed; loner đã không còn liên kết hoặc không chọn: không có tin.
    expect(await outboxOf("tviewer", `run.failed:${eventKey}`)).toHaveLength(0);
    // Chạy lại cùng eventKey (job nghiệp vụ chạy lại) không gửi chat lần nữa.
    await emit({ eventKey });
    expect(await outboxOf("tmember", `run.failed:${eventKey}`)).toHaveLength(1);
    // Người được chọn sự kiện thì nhận.
    const mergeKey = randomUUID();
    await emit({ event: "merge.failed", eventKey: mergeKey });
    expect(await outboxOf("tviewer", `merge.failed:${mergeKey}`)).toHaveLength(1);
  });

  it("rollback nghiệp vụ thì không để lại tin chat", async () => {
    const eventKey = randomUUID();
    await expect(
      asUser("admin", async (tx) => {
        await notify(tx, event({ eventKey }) as never);
        throw new Error("nghiệp vụ lỗi");
      }),
    ).rejects.toThrow("nghiệp vụ lỗi");
    expect(await outboxOf("tmember", `run.failed:${eventKey}`)).toHaveLength(0);
  });

  it("bot tắt thì không xếp tin; xếp rồi mới tắt thì tin thất bại ngay với lý do rõ", async () => {
    const queuedKey = randomUUID();
    await emit({ eventKey: queuedKey });
    const [queued] = await outboxOf("tmember", `run.failed:${queuedKey}`);
    await asUser("admin", (tx) => updateBot(tx, masterKey, org.user("admin"), { id: tgBot.id, enabled: false }));
    try {
      const skippedKey = randomUUID();
      await emit({ eventKey: skippedKey });
      expect(await outboxOf("tmember", `run.failed:${skippedKey}`)).toHaveLength(0);
      expect(await deliverOutbox(deps, { orgId: org.orgId, outboxId: queued?.id ?? "" }, quiet)).toBe("failed");
      expect((await outboxOf("tmember", `run.failed:${queuedKey}`))[0]?.error).toContain("Bot đã tắt");
    } finally {
      await asUser("admin", (tx) => updateBot(tx, masterKey, org.user("admin"), { id: tgBot.id, enabled: true }));
    }
  });

  it("gửi tới đúng chat với tiêu đề in đậm, nút Mở trên web; gửi lần hai bị bỏ qua", async () => {
    const eventKey = randomUUID();
    await emit({ eventKey });
    const [row] = await outboxOf("tmember", `run.failed:${eventKey}`);
    fake.reset();
    expect(await deliverOutbox(deps, { orgId: org.orgId, outboxId: row?.id ?? "" }, quiet)).toBe("sent");
    const [call] = fake.sent("telegram");
    expect(call?.body.chat_id).toBe("1001");
    expect(String(call?.body.text)).toContain("<b>Run PAY-1 thất bại</b>");
    expect(String(call?.body.text)).not.toContain("abcdef123456");
    expect(keyboard(call)).toEqual([{ text: "Mở trên web", url: "https://hive.test/tasks/PAY-1" }]);
    expect((await outboxOf("tmember", `run.failed:${eventKey}`))[0]).toMatchObject({ status: "sent", attempts: 1 });
    expect(await deliverOutbox(deps, { orgId: org.orgId, outboxId: row?.id ?? "" }, quiet)).toBe("skipped");
  });

  it("lỗi vĩnh viễn (token sai) failed ngay; lỗi tạm thời thử lại rồi gửi được; token không lọt vào lỗi", async () => {
    const permanentKey = randomUUID();
    await emit({ eventKey: permanentKey });
    const [p] = await outboxOf("tmember", `run.failed:${permanentKey}`);
    fake.failTelegram(403);
    expect(await deliverOutbox(deps, { orgId: org.orgId, outboxId: p?.id ?? "" }, quiet)).toBe("failed");
    const failed = (await outboxOf("tmember", `run.failed:${permanentKey}`))[0];
    expect(failed?.status).toBe("failed");
    expect(failed?.error).not.toContain(TOKEN);

    const transientKey = randomUUID();
    await emit({ eventKey: transientKey });
    const [t] = await outboxOf("tmember", `run.failed:${transientKey}`);
    fake.failTelegram(500);
    expect(await deliverOutbox(deps, { orgId: org.orgId, outboxId: t?.id ?? "" }, quiet)).toBe("retry");
    expect((await outboxOf("tmember", `run.failed:${transientKey}`))[0]).toMatchObject({
      status: "queued",
      attempts: 1,
    });
    expect(await deliverOutbox(deps, { orgId: org.orgId, outboxId: t?.id ?? "" }, quiet)).toBe("sent");
  });

  it("nút Duyệt và Trả lại của kế hoạch được lưu và hiện thành nút", async () => {
    const taskId = randomUUID();
    const planId = randomUUID();
    const eventKey = randomUUID();
    await emit({
      event: "plan.awaiting_approval",
      eventKey,
      recipientIds: [org.user("tmember")],
      title: "Kế hoạch của PAY-2 chờ duyệt",
      body: "Bước 1\nBước 2",
      actions: [
        { kind: "plan.approve", taskId, planId },
        { kind: "plan.reject", taskId, planId },
      ],
    });
    const [row] = await outboxOf("tmember", `plan.awaiting_approval:${eventKey}`);
    expect(row?.actions).toEqual([
      { kind: "plan.approve", taskId, planId },
      { kind: "plan.reject", taskId, planId },
    ]);
    fake.reset();
    await deliverOutbox(deps, { orgId: org.orgId, outboxId: row?.id ?? "" }, quiet);
    const [call] = fake.sent("telegram");
    expect(keyboard(call).map((b) => b.text)).toEqual(["Duyệt", "Trả lại", "Mở trên web"]);
    expect(callbacks(call)).toEqual([`o:${row?.id}:0`, `o:${row?.id}:1`]);
    // Nút không mang taskId/planId: người nhận không đổi được hành động.
    expect(JSON.stringify(call?.body)).not.toContain(taskId);
  });

  it("link http (hub dev ở localhost) vào chữ thay vì nút để Telegram không từ chối cả tin", async () => {
    const eventKey = randomUUID();
    await emit({ eventKey, link: "http://localhost:4000/tasks/PAY-3" });
    const [row] = await outboxOf("tmember", `run.failed:${eventKey}`);
    fake.reset();
    await deliverOutbox(deps, { orgId: org.orgId, outboxId: row?.id ?? "" }, quiet);
    const [call] = fake.sent("telegram");
    expect(keyboard(call)).toEqual([]);
    expect(String(call?.body.text)).toContain("http://localhost:4000/tasks/PAY-3");
  });

  it("job pg-boss gửi sau khi transaction commit", async () => {
    const jobs = createJobs({ connectionString: jobsUrl, queues: [chatQueue], maintenance: false });
    await jobs.start();
    installChatHooks({ jobs, publicUrl: PUBLIC });
    try {
      await registerChatWorker(jobs, deps, { pollingIntervalSeconds: 0.5 });
      fake.reset();
      const eventKey = randomUUID();
      await asUser("admin", (tx) => notify(tx, event({ eventKey }) as never, { jobs }));
      await vi.waitFor(() => expect(fake.sent("telegram").length).toBe(1), { timeout: 15_000, interval: 200 });
      expect(String(fake.sent("telegram")[0]?.body.text)).toContain("Run PAY-1 thất bại");
      await vi.waitFor(
        async () => expect((await outboxOf("tmember", `run.failed:${eventKey}`))[0]?.status).toBe("sent"),
        { timeout: 5000, interval: 100 },
      );
    } finally {
      installChatHooks({ publicUrl: PUBLIC });
      await jobs.stop();
    }
    expect(CHAT_QUEUE).toBe("chat.deliver");
  });
});

describe("Slack", () => {
  const U = "U100";
  const form = (data: Record<string, string>) => new URLSearchParams(data).toString();
  const call = (route: "events" | "commands" | "interact", body: string, type: string, o: { retry?: boolean } = {}) =>
    handleSlackWebhook(
      deps,
      slackBot.id,
      route,
      new Request(`http://hub/hooks/chat/slack/${slackBot.id}/${route}`, {
        method: "POST",
        headers: { "content-type": type, ...slackHeaders(SIGNING, body, o) },
        body,
      }),
    );
  const slash = async (user: string, text: string, channel = "D1") => {
    fake.reset();
    const res = await call(
      "commands",
      form({ command: "/hive", text, user_id: user, user_name: "ten", channel_id: channel }),
      "application/x-www-form-urlencoded",
    );
    expect(res.status).toBe(200);
    return (await res.json()) as {
      response_type: string;
      text: string;
      blocks: Array<{ type: string; text?: { text: string }; elements?: Array<Record<string, string>> }>;
    };
  };
  const dm = async (user: string, text: string, extra: Record<string, unknown> = {}, o = {}) => {
    fake.reset();
    const res = await call(
      "events",
      JSON.stringify({
        type: "event_callback",
        event: { type: "message", channel_type: "im", channel: "D1", user, text, ...extra },
      }),
      "application/json",
      o,
    );
    expect(res.status).toBe(200);
    return fake.sent("slack");
  };

  it("liên kết bằng /hive link MÃ (slash) và bằng tin nhắn `link MÃ` trong DM", async () => {
    const code = await asUser("tmember", (tx) => createLinkCode(tx, org.user("tmember"), slackBot.id));
    expect(code.command).toBe(`/hive link ${code.code}`);
    const res = await slash(U, `link ${code.code}`);
    expect(res.response_type).toBe("ephemeral");
    expect(res.blocks[0]?.text?.text).toContain("Đã liên kết");
    const row = await one<{ user_id: string; chat_id: string }>(
      "select user_id, chat_id from hive.chat_links where bot_id = $1 and external_user_id = $2",
      [slackBot.id, U],
    );
    expect(row).toEqual({ user_id: org.user("tmember"), chat_id: U });

    const code2 = await asUser("tviewer", (tx) => createLinkCode(tx, org.user("tviewer"), slackBot.id));
    const sent = await dm("U200", `link ${code2.code}`);
    expect(sent[0]?.body.channel).toBe("D1");
    expect(JSON.stringify(sent[0]?.body.blocks)).toContain("Đã liên kết");
  });

  it("slash /hive trả lời kín (ephemeral); /hive không lệnh là trợ giúp", async () => {
    const help = await slash(U, "");
    expect(help.blocks[0]?.text?.text).toContain("/hive pending");
    const unknown = await slash(U, "foo");
    expect(unknown.blocks[0]?.text?.text).toContain("Không có lệnh");
  });

  it("nút trên Slack: chỉ người nhận bấm được, thành công thì thay tin gốc bằng kết quả", async () => {
    const approvalId = await seedApproval("tmember", "Việc từ Slack");
    const pending = await slash(U, "pending");
    const actionBlock = pending.blocks.find((b) => b.type === "actions");
    const values = actionBlock?.elements?.flatMap((e) => (e.value ? [e.value] : [])) ?? [];
    expect(values).toHaveLength(2);
    expect(actionBlock?.elements?.find((e) => e.url)?.url).toBe(`${PUBLIC}/leader`);

    const interact = (user: string, value: string) =>
      call(
        "interact",
        form({
          payload: JSON.stringify({
            type: "block_actions",
            user: { id: user },
            channel: { id: "D1" },
            response_url: fake.responseUrl,
            actions: [{ action_id: "hive_0", value }],
          }),
        }),
        "application/x-www-form-urlencoded",
      );

    fake.reset();
    expect((await interact("U200", values[0] ?? "")).status).toBe(200);
    const denied = fake.calls.find((c) => c.api === "response");
    expect(denied?.body.response_type).toBe("ephemeral");
    expect(JSON.stringify(denied?.body)).toContain("không dành cho tài khoản của bạn");
    expect(
      (await one<{ status: string }>("select status from hive.approvals where id = $1", [approvalId])).status,
    ).toBe("pending");

    fake.reset();
    await interact(U, values[0] ?? "");
    const done = fake.calls.find((c) => c.api === "response");
    expect(done?.body.replace_original).toBe(true);
    expect(JSON.stringify(done?.body)).toContain("Đã duyệt");
    expect(
      await one<{ status: string; decided_by: string }>("select status, decided_by from hive.approvals where id = $1", [
        approvalId,
      ]),
    ).toEqual({
      status: "approved",
      decided_by: org.user("tmember"),
    });
  });

  it("tin DM tự do tới Leader; tin của bot, tin có subtype, bản gửi lại bị bỏ qua", async () => {
    const reply = await dm(U, "Hỏi Leader qua Slack");
    expect(JSON.stringify(reply[0]?.body.blocks)).toContain("Đã chuyển cho Leader");
    expect(reply[0]?.body.channel).toBe("D1");
    expect(await dm(U, "tin của bot", { bot_id: "B1" })).toEqual([]);
    expect(await dm(U, "chỉnh sửa", { subtype: "message_changed" })).toEqual([]);
    expect(await dm(U, "/help", {}, { retry: true })).toEqual([]);
  });

  it("kênh: chỉ phản hồi khi @mention, và bị chặn khi tổ chức chưa bật chat nhóm", async () => {
    expect(await dm(U, "nói chuyện trong kênh", { channel_type: "channel", channel: "C1" })).toEqual([]);
    const mention = await dm(U, "<@UBOT> pending", { type: "app_mention", channel_type: "channel", channel: "C1" });
    expect(JSON.stringify(mention[0]?.body.blocks)).toContain("chưa bật chat nhóm");
    expect(mention[0]?.body.channel).toBe("C1");
    const blockedSlash = await slash(U, "help", "C1");
    expect(blockedSlash.blocks[0]?.text?.text).toContain("chưa bật chat nhóm");
  });

  it("lỗi gửi Slack không sập webhook", async () => {
    fake.failSlack("invalid_auth");
    expect(await dm(U, "link AAAA-AAAA")).toHaveLength(1);
  });
});

afterEach(() => {
  fake.reset();
});
