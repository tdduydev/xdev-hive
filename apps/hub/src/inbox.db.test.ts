import { randomBytes, randomUUID } from "node:crypto";
import type { InboxItem } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../test/org-fixture.ts";
import { createApp } from "./app.ts";
import { createAuth } from "./modules/identity/index.ts";
import {
  cleanupInbox,
  createChannel,
  INBOX_CLEANUP_QUEUE,
  inboxCleanupQueue,
  notify,
  notifyQueue,
} from "./modules/notify/index.ts";
import { createJobs, createPool, parseMasterKey, withTenant } from "./modules/platform/index.ts";

const { adminUrl, appUrl, authUrl, jobsUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const authPool = createPool(authUrl);
const jobs = createJobs({ connectionString: jobsUrl, queues: [inboxCleanupQueue, notifyQueue], maintenance: false });
const tag = randomUUID();
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
let org: Awaited<ReturnType<typeof seedOrg>>;
let other: typeof org;
let app: ReturnType<typeof createApp>;
let userId = "";
let cookie = "";
let outsiderCookie = "";

beforeAll(async () => {
  org = await seedOrg(admin, `inbox-${tag}`);
  other = await seedOrg(admin, `inbox-other-${tag}`);
  await jobs.start();
  const auth = createAuth({
    pool: authPool,
    baseURL: "http://localhost:3000",
    secret: "test-secret-0123456789abcdef-0123456789",
    allowEmailSignUp: true,
  });
  app = createApp({ config: { port: 0, version: "test" }, auth, pool, jobs });
  for (const name of ["recipient", "outsider"]) {
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, email: `${name}-${tag}@example.com`, password: "test-password-0123456789" }),
    });
    expect(res.status).toBe(200);
    const sessionCookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    if (name === "outsider") outsiderCookie = sessionCookie;
    else {
      cookie = sessionCookie;
      userId = ((await res.json()) as { user: { id: string } }).user.id;
      for (const orgId of [org.orgId, other.orgId]) {
        await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [
          orgId,
          userId,
        ]);
      }
    }
  }
});
afterAll(async () => {
  await jobs.stop();
  await Promise.all([admin.end(), pool.end(), authPool.end()]);
});

async function api(path: string, body?: unknown, orgId = org.orgId, sessionCookie = cookie) {
  return app.request(`/api/v1/inbox${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie: sessionCookie, "x-hive-org": orgId, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function emit(eventKey: string, recipientIds = [userId], orgId = org.orgId) {
  await withTenant(pool, { orgId }, (tx) =>
    notify(tx, {
      orgId,
      event: "run.failed",
      eventKey,
      recipientIds,
      title: `Run lỗi ${eventKey}`,
      body: "Agent thoát lỗi.",
      link: "https://hive.example.com/tasks/ABC-1",
    }),
  );
}
async function items(orgId = org.orgId): Promise<InboxItem[]> {
  const res = await api("?limit=100", undefined, orgId);
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: InboxItem[] }).items;
}
async function reset() {
  await admin.query("delete from hive.inbox_items where org_id = any($1::uuid[])", [[org.orgId, other.orgId]]);
}

describe("personal inbox API", () => {
  it("writes without channels, deduplicates recipients and replayed events, filters inactive and external identities", async () => {
    await reset();
    await admin.query("update hive.org_members set status = 'blocked' where org_id = $1 and user_id = $2", [
      org.orgId,
      org.user("tviewer"),
    ]);
    const recipients = [
      userId,
      userId,
      org.user("tmember"),
      other.user("owner"),
      org.user("tviewer"),
      "github:someone",
    ];
    await emit("dedup", recipients);
    await emit("dedup", recipients);
    expect(await items()).toEqual([
      expect.objectContaining({
        event: "run.failed",
        title: "Run lỗi dedup",
        body: "Agent thoát lỗi.",
        readAt: null,
        link: "https://hive.example.com/tasks/ABC-1",
      }),
    ]);
    const { rows } = await admin.query("select user_id from hive.inbox_items where org_id = $1", [org.orgId]);
    expect(rows.map((r) => r.user_id).sort()).toEqual([userId, org.user("tmember")].sort());
    await emit("dedup", [userId], other.orgId);
    expect(await items(other.orgId)).toHaveLength(1);
  });

  it("requires authentication and active organization membership for every operation", async () => {
    for (const [path, body] of [
      ["", undefined],
      ["/unread-count", undefined],
      ["/read", { ids: [randomUUID()] }],
      ["/read-all", {}],
    ] as const) {
      expect((await api(path, body, org.orgId, "")).status).toBe(401);
      expect((await api(path, body, org.orgId, outsiderCookie)).status).toBe(403);
      expect((await api(path, body, randomUUID())).status).toBe(403);
    }
  });

  it("counts unread items, marks one or many, ignores others' ids, preserves read timestamps and isolates markAllRead", async () => {
    await reset();
    await emit("first");
    await emit("second");
    await emit("third");
    await emit("someone-else", [org.user("owner")]);
    await emit("other-org", [userId], other.orgId);
    const mine = await items();
    const foreign = (
      await admin.query("select id from hive.inbox_items where org_id = $1 and user_id = $2", [
        org.orgId,
        org.user("owner"),
      ])
    ).rows[0].id;
    const theirs = (await items(other.orgId))[0];
    expect(await (await api("/unread-count")).json()).toEqual({ count: 3 });
    expect(await (await api("/read", { ids: [mine[0]?.id, foreign, theirs?.id, randomUUID()] })).json()).toEqual({
      count: 1,
    });
    const readAt = (await items()).find((i) => i.id === mine[0]?.id)?.readAt;
    expect(readAt).toBeTruthy();
    expect(await (await api("/read", { ids: [mine[0]?.id] })).json()).toEqual({ count: 0 });
    expect((await items()).find((i) => i.id === mine[0]?.id)?.readAt).toBe(readAt);
    expect(await (await api("?unreadOnly=true")).json()).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ readAt: null })]),
    });
    expect(await (await api("/read", { ids: mine.slice(1).map((i) => i.id) })).json()).toEqual({ count: 2 });
    await emit("fourth");
    expect(await (await api("/read-all", {})).json()).toEqual({ count: 1 });
    expect(await (await api("/read-all", {})).json()).toEqual({ count: 0 });
    expect(await (await api("/unread-count")).json()).toEqual({ count: 0 });
    expect(await (await api("?unreadOnly=true")).json()).toMatchObject({ items: [], nextCursor: null });
    expect(await (await api("/unread-count", undefined, other.orgId)).json()).toEqual({ count: 1 });
    expect(
      (await admin.query("select read_at from hive.inbox_items where id = $1", [foreign])).rows[0].read_at,
    ).toBeNull();
  });

  it("paginates ties by timestamp and id, accepts cursors after rows are deleted, validates bounds", async () => {
    await reset();
    for (let n = 0; n < 5; n++) await emit(`page-${n}`);
    await admin.query("update hive.inbox_items set created_at = '2026-10-11T12:00:00.123Z' where org_id = $1", [
      org.orgId,
    ]);
    const all = await items();
    let path = "?limit=2";
    const collected: string[] = [];
    do {
      const res = await api(path);
      expect(res.status).toBe(200);
      const page = (await res.json()) as { items: InboxItem[]; nextCursor: string | null };
      collected.push(...page.items.map((i) => i.id));
      if (!page.nextCursor) break;
      await admin.query("delete from hive.inbox_items where id = $1", [page.nextCursor.split("~")[1]]);
      path = `?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`;
    } while (collected.length < 10);
    expect(collected).toEqual(all.map((i) => i.id));
    for (const query of ["?limit=0", "?limit=101", "?cursor=bad", "?unreadOnly=invalid"])
      expect((await api(query)).status).toBe(400);
    expect((await api("/read", { ids: [] })).status).toBe(400);
  });

  it("rolls inbox and channel notifications back with the business transaction", async () => {
    await reset();
    const channel = await withTenant(pool, { orgId: org.orgId, userId: org.user("admin") }, (tx) =>
      createChannel(tx, masterKey, org.user("admin"), {
        name: `inbox-${tag}`,
        events: ["run.failed"],
        config: { kind: "telegram", botToken: "123456:ABCdefGhIJKlmnOPQrstUVwxyz0123456789", chatId: "-1" },
      }),
    );
    await expect(
      withTenant(pool, { orgId: org.orgId }, async (tx) => {
        await notify(
          tx,
          {
            orgId: org.orgId,
            event: "run.failed",
            eventKey: "rollback",
            recipientIds: [userId],
            title: "Run lỗi",
            body: "Agent lỗi",
          },
          { jobs },
        );
        throw new Error("Rollback");
      }),
    ).rejects.toThrow("Rollback");
    expect(await items()).toEqual([]);
    expect((await admin.query("select id from hive.notifications where channel_id = $1", [channel.id])).rows).toEqual(
      [],
    );
  });

  it("schedules cleanup transactionally, deletes only read items over 90 days and is idempotent", async () => {
    await reset();
    await emit("retention");
    const [item] = await items();
    await api("/read", { ids: [item?.id] });
    const { rows } = await admin.query(
      "select data, start_after from pgboss.job where name = $1 and data->>'userId' = $2 order by start_after desc limit 1",
      [INBOX_CLEANUP_QUEUE, userId],
    );
    expect(rows[0].data).toEqual({ orgId: org.orgId, userId });
    expect(rows[0].start_after.getTime()).toBeGreaterThan(Date.now() + 89 * 24 * 60 * 60 * 1000);
    await emit("unread-old");
    await emit("read-recent");
    await emit("other-retention", [userId], other.orgId);
    await admin.query("update hive.inbox_items set created_at = now() - interval '100 days' where org_id = $1", [
      org.orgId,
    ]);
    await admin.query("update hive.inbox_items set read_at = now() - interval '91 days' where id = $1 or org_id = $2", [
      item?.id,
      other.orgId,
    ]);
    await admin.query(
      "update hive.inbox_items set read_at = now() - interval '89 days' where org_id = $1 and event_key = 'read-recent'",
      [org.orgId],
    );
    await cleanupInbox(pool, { orgId: org.orgId, userId });
    await cleanupInbox(pool, { orgId: org.orgId, userId });
    expect((await items()).map((i) => i.title).sort()).toEqual(["Run lỗi read-recent", "Run lỗi unread-old"]);
    expect(await items(other.orgId)).toHaveLength(1);
  });
});
