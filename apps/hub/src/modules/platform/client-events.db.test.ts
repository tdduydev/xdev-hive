import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { ClientEventRejected, purgeClientEvents, withClientEvent } from "./client-events.ts";
import { createPool, withTenant } from "./db.ts";
import { clientEvents } from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);

const orgA = randomUUID();
const orgB = randomUUID();
const tag = randomUUID().slice(0, 8);
const key = () => `k${randomUUID().replaceAll("-", "")}`;
const meta = (k: string) => ({ key: k, source: "hive-cli" as const, kind: "test.write", userId: "u" });

beforeAll(async () => {
  await admin.query(
    "insert into hive.orgs (id, slug, name, created_by) values ($1, $3, 'A', 'u'), ($2, $4, 'B', 'u')",
    [orgA, orgB, `ce-a-${tag}`, `ce-b-${tag}`],
  );
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("withClientEvent", () => {
  it("fn chỉ chạy một lần mỗi khoá; lần sau trả kết quả đã lưu", async () => {
    const k = key();
    let runs = 0;
    const fn = async () => {
      runs += 1;
      return { n: runs };
    };
    const first = await withClientEvent(app, { orgId: orgA }, meta(k), fn);
    const again = await withClientEvent(app, { orgId: orgA }, meta(k), fn);
    expect(first).toMatchObject({ outcome: "accepted", response: { n: 1 } });
    expect(again).toMatchObject({ outcome: "duplicate", response: { n: 1 } });
    expect(runs).toBe(1);
  });

  it("bị từ chối thì rollback phần fn đã ghi và lưu lần từ chối", async () => {
    const k = key();
    const out = await withClientEvent(app, { orgId: orgA }, meta(k), async (tx) => {
      // Ghi một dòng khác trong cùng transaction: phải mất theo rollback.
      await tx
        .insert(clientEvents)
        .values({ orgId: orgA, idempotencyKey: `${k}-side`, source: "web", kind: "x", outcome: "accepted" });
      throw new ClientEventRejected("TEST_REJECTED", "Không nhận.");
    });
    expect(out).toMatchObject({ outcome: "rejected", code: "TEST_REJECTED", reason: "Không nhận." });
    const { rows } = await admin.query(
      "select idempotency_key, outcome from hive.client_events where idempotency_key like $1 order by idempotency_key",
      [`${k}%`],
    );
    expect(rows).toEqual([{ idempotency_key: k, outcome: "rejected" }]);
  });

  it("lỗi khác (không phải từ chối) ném ra và không để lại dòng nào", async () => {
    const k = key();
    await expect(
      withClientEvent(app, { orgId: orgA }, meta(k), async () => {
        throw new Error("hỏng");
      }),
    ).rejects.toThrow("hỏng");
    const { rows } = await admin.query("select 1 from hive.client_events where idempotency_key = $1", [k]);
    expect(rows).toHaveLength(0);
  });

  it("cùng khoá ở hai tổ chức là hai sự kiện khác nhau", async () => {
    const k = key();
    const a = await withClientEvent(app, { orgId: orgA }, meta(k), async () => "a");
    const b = await withClientEvent(app, { orgId: orgB }, meta(k), async () => "b");
    expect([a.outcome, b.outcome]).toEqual(["accepted", "accepted"]);
  });
});

describe("RLS client_events", () => {
  it("không có context thì không thấy gì; có context chỉ thấy tổ chức mình", async () => {
    await withTenant(app, {}, async (tx) => {
      expect(await tx.select().from(clientEvents)).toHaveLength(0);
    });
    await withTenant(app, { orgId: orgA }, async (tx) => {
      const rows = await tx.select().from(clientEvents);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.orgId === orgA)).toBe(true);
    });
  });

  it("job dọn xoá sự kiện quá 30 ngày", async () => {
    const k = key();
    await admin.query(
      `insert into hive.client_events (org_id, idempotency_key, source, kind, outcome, received_at)
       values ($1, $2, 'web', 'x', 'accepted', now() - interval '31 days')`,
      [orgA, k],
    );
    expect(await purgeClientEvents(app)).toBeGreaterThanOrEqual(1);
    const { rows } = await admin.query("select 1 from hive.client_events where idempotency_key = $1", [k]);
    expect(rows).toHaveLength(0);
  });
});
