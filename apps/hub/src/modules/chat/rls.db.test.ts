import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { createPool, parseMasterKey, withTenant } from "../platform/index.ts";
import { createBot, createLinkCode, decryptBotConfig, findChatBot } from "./index.ts";
import { chatBots, chatLinkCodes, chatLinks, chatOrgSettings, chatOutbox, chatUsage } from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const TABLES = [
  "chat_bots",
  "chat_org_settings",
  "chat_link_codes",
  "chat_links",
  "chat_outbox",
  "chat_usage",
] as const;
const TOKEN = "123456:ABCdefGhIJKlmnOPQrstUVwxyz0123456789";

let org: OrgFixture & { user: (n: string) => string };
let other: typeof org;
let botId = "";

beforeAll(async () => {
  org = await seedOrg(admin, `chatrls-${randomUUID()}`);
  other = await seedOrg(admin, `chatrls2-${randomUUID()}`);
  const owner = org.user("admin");
  const bot = await withTenant(pool, { userId: owner, orgId: org.orgId }, (tx) =>
    createBot(tx, masterKey, owner, { name: "tg", config: { kind: "telegram", botToken: TOKEN } }),
  );
  botId = bot.id;
  await withTenant(pool, { userId: org.user("tmember"), orgId: org.orgId }, (tx) =>
    createLinkCode(tx, org.user("tmember"), botId),
  );
  await admin.query(
    "insert into hive.chat_links (org_id, bot_id, user_id, external_user_id, chat_id, events) values ($1, $2, $3, '1', '1', '{run.failed}')",
    [org.orgId, botId, org.user("tmember")],
  );
});
afterAll(async () => {
  await Promise.all([admin.end(), pool.end()]);
});

describe("chat RLS", () => {
  it("mọi bảng chat bật và ép RLS", async () => {
    for (const table of TABLES) {
      const { rows } = await admin.query(
        "select relrowsecurity, relforcerowsecurity from pg_class where oid = $1::regclass",
        [`hive.${table}`],
      );
      expect({ table, ...rows[0] }).toEqual({ table, relrowsecurity: true, relforcerowsecurity: true });
    }
  });

  it("không có ngữ cảnh tổ chức thì thấy 0 dòng ở mọi bảng", async () => {
    for (const context of [{}, { userId: org.user("admin") }]) {
      await withTenant(pool, context, async (tx) => {
        for (const t of [chatBots, chatOrgSettings, chatLinkCodes, chatLinks, chatOutbox, chatUsage]) {
          expect(await tx.select().from(t)).toEqual([]);
        }
      });
    }
  });

  it("tổ chức khác không thấy, không sửa, không xoá dòng của tổ chức này", async () => {
    await withTenant(pool, { userId: other.user("admin"), orgId: other.orgId }, async (tx) => {
      expect(await tx.select().from(chatBots)).toEqual([]);
      expect(await tx.select().from(chatLinks)).toEqual([]);
      expect(await tx.select().from(chatLinkCodes)).toEqual([]);
      expect(await tx.update(chatBots).set({ enabled: false }).returning()).toEqual([]);
      expect(await tx.delete(chatLinks).returning()).toEqual([]);
    });
    const { rows } = await admin.query("select enabled from hive.chat_bots where id = $1", [botId]);
    expect(rows[0].enabled).toBe(true);
  });

  it("không ghi được dòng sang tổ chức khác (WITH CHECK)", async () => {
    await expect(
      withTenant(pool, { orgId: other.orgId }, (tx) =>
        tx.insert(chatUsage).values({ orgId: org.orgId, userId: "x", day: sql`current_date`, count: 1 }),
      ),
    ).rejects.toThrow();
  });

  it("webhook chỉ đọc được đúng bot có id trong app.chat_bot_id, và chỉ đọc", async () => {
    await withTenant(pool, {}, async (tx) => {
      await tx.execute(sql`select set_config('app.chat_bot_id', ${botId}, true)`);
      expect((await tx.select({ id: chatBots.id }).from(chatBots)).map((r) => r.id)).toEqual([botId]);
      expect(await tx.update(chatBots).set({ enabled: false }).returning()).toEqual([]);
      // Mã liên kết và liên kết không lộ qua đường tra bot.
      expect(await tx.select().from(chatLinks)).toEqual([]);
    });
  });

  it("token bot nằm trong config_enc dạng mã hoá, và chỉ giải mã đúng ngữ cảnh dòng", async () => {
    const { rows } = await admin.query("select config_enc from hive.chat_bots where id = $1", [botId]);
    expect(rows[0].config_enc).not.toContain("123456");
    expect(rows[0].config_enc).not.toContain(TOKEN.split(":")[1]);
    const config = decryptBotConfig(masterKey, botId, rows[0].config_enc);
    expect(config).toMatchObject({ kind: "telegram", botToken: TOKEN });
    expect(() => decryptBotConfig(masterKey, randomUUID(), rows[0].config_enc)).toThrow();
    expect((await findChatBot(pool, masterKey, botId))?.orgId).toBe(org.orgId);
    expect(await findChatBot(pool, masterKey, randomUUID())).toBeNull();
    expect(await findChatBot(pool, undefined, botId)).toBeNull();
    expect(await findChatBot(pool, masterKey, "không-phải-uuid")).toBeNull();
  });
});
