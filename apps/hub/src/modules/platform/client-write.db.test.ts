import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { runClientWrite } from "./client-write.ts";
import { createPool } from "./db.ts";
import { ConflictError, ForbiddenError } from "./errors.ts";

/* T010 (specs/027 US1): thủ tục oRPC có ghi chạy một lần mỗi khoá và trả header `Hive-Client-Event`. */

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);

const orgId = randomUUID();
const tenant = { userId: "u", orgId };
const key = () => `k${randomUUID().replaceAll("-", "")}`;
const request = (headers: Record<string, string>) => ({ headers: new Headers(headers), resHeaders: new Headers() });
const eventOf = (r: { resHeaders: Headers }) => JSON.parse(r.resHeaders.get("hive-client-event") ?? "null");

beforeAll(async () => {
  await admin.query("insert into hive.orgs (id, slug, name, created_by) values ($1, $2, 'W', 'u')", [
    orgId,
    `cw-${orgId.slice(0, 8)}`,
  ]);
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("runClientWrite", () => {
  it("gửi lại cùng khoá nhận kết quả đã lưu, chỉ ghi một lần", async () => {
    const k = key();
    let runs = 0;
    const fn = async () => ({ n: ++runs, createdAt: "2026-10-23T08:00:00.000Z" });
    const first = request({ "Idempotency-Key": k, "X-Hive-Source": "desktop" });
    const again = request({ "Idempotency-Key": k, "X-Hive-Source": "desktop" });
    expect(await runClientWrite(app, tenant, first, "memory.write", fn)).toEqual({
      n: 1,
      createdAt: expect.any(String),
    });
    expect(await runClientWrite(app, tenant, again, "memory.write", fn)).toMatchObject({ n: 1 });
    expect(runs).toBe(1);
    expect(eventOf(first)).toMatchObject({ key: k, outcome: "accepted" });
    expect(eventOf(again)).toMatchObject({ key: k, outcome: "duplicate" });
    const { rows } = await admin.query("select source, kind from hive.client_events where idempotency_key = $1", [k]);
    expect(rows).toEqual([{ source: "desktop", kind: "memory.write" }]);
  });

  it("lần bị từ chối giữ đúng lỗi; gửi lại nhận 409 cùng mã", async () => {
    const k = key();
    const fn = async () => {
      throw new ForbiddenError("AGENT_MEMORY_OFF", "Chính sách của tổ chức không cho agent ghi memory.");
    };
    const first = request({ "Idempotency-Key": k });
    await expect(runClientWrite(app, tenant, first, "memory.write", fn)).rejects.toBeInstanceOf(ForbiddenError);
    expect(eventOf(first)).toMatchObject({ outcome: "rejected", code: "AGENT_MEMORY_OFF" });
    const again = request({ "Idempotency-Key": k });
    const error = await runClientWrite(app, tenant, again, "memory.write", fn).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ code: "AGENT_MEMORY_OFF" });
    expect(eventOf(again)).toMatchObject({ outcome: "duplicate", code: "AGENT_MEMORY_OFF" });
  });

  it("thiếu khoá thì ghi như client cũ, không có dòng sự kiện", async () => {
    let runs = 0;
    const r = request({});
    await runClientWrite(app, tenant, r, "memory.write", async () => ++runs);
    await runClientWrite(app, tenant, r, "memory.write", async () => ++runs);
    expect(runs).toBe(2);
    expect(r.resHeaders.get("hive-client-event")).toBeNull();
  });
});
