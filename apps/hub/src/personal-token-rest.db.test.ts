// Token cá nhân trên REST API của người dùng (spec 008 FR-026): app desktop gọi đúng hợp đồng của web bằng
// `Authorization: Bearer hive_pat_…`, với đúng quyền của chủ token. App dựng bằng app.fetch, không mở cổng.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import { createApp } from "./app.ts";
import { createAuth } from "./modules/identity/index.ts";
import { createPool } from "./modules/platform/index.ts";

const { adminUrl, appUrl, authUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const authPool = createPool(authUrl);
const tag = randomUUID().slice(0, 6);
const baseURL = "http://hive.test:3000";

let org: OrgFixture & { user: (n: string) => string };
let other: OrgFixture & { user: (n: string) => string };
const app = createApp({
  config: { port: 0, version: "t", publicUrl: baseURL },
  auth: createAuth({
    pool: authPool,
    baseURL,
    secret: "test-secret-0123456789abcdef-0123456789",
    allowEmailSignUp: true,
  }),
  pool,
});

/** Token cá nhân như MCP và công cụ → Token MCP tạo: hive_pat_<tổ chức>_<bí mật>, hub chỉ giữ băm. */
async function pat(orgId: string, userId: string, opts: { revoked?: boolean; expired?: boolean } = {}) {
  const token = `hive_pat_${orgId}_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  await admin.query(
    `insert into hive.mcp_user_tokens (org_id, user_id, token_hash, prefix, client_id, expires_at, revoked_at)
     values ($1, $2, $3, 'hive_pat_test', 'xdev-hive-desktop', now() + interval '30 days', $4)`,
    [orgId, userId, hash, opts.revoked ? new Date() : null],
  );
  // Ràng buộc của bảng không cho tạo token đã hết hạn: lùi cả ngày tạo và ngày hết hạn về quá khứ.
  if (opts.expired)
    await admin.query(
      "update hive.mcp_user_tokens set created_at = now() - interval '31 days', expires_at = now() - interval '1 day' where token_hash = $1",
      [hash],
    );
  return token;
}

const call = (path: string, token: string | null, orgId: string, init: RequestInit = {}) =>
  app.fetch(
    new Request(`${baseURL}/api${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-hive-org": orgId,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    }),
  );

beforeAll(async () => {
  org = await seedOrg(admin, `patrest-${tag}`);
  other = await seedOrg(admin, `patrest2-${tag}`);
});

afterAll(async () => {
  await Promise.all([admin.end(), pool.end(), authPool.end()]);
});

describe("token cá nhân trên REST API", () => {
  it("gọi được API của người dùng với đúng quyền của chủ token", async () => {
    const token = await pat(org.orgId, org.user("tmember"));
    const teams = await call("/v1/teams", token, org.orgId);
    expect(teams.status, await teams.clone().text()).toBe(200);
    const names = ((await teams.json()) as { id: string }[]).map((t) => t.id);
    expect(names).toContain(org.teamId);
    // Thành viên đội không phải quản trị: tạo mã đăng ký máy bị từ chối như khi đăng nhập bằng cookie.
    const reg = await call(`/v1/teams/${org.teamId}/machines/registrations`, token, org.orgId, {
      method: "POST",
      body: "{}",
    });
    expect(reg.status).toBe(403);
  });

  it("không có, sai, hết hạn, đã thu hồi hay khác tổ chức thì là chưa đăng nhập", async () => {
    expect((await call("/v1/teams", null, org.orgId)).status).toBe(401);
    expect((await call("/v1/teams", `hive_pat_${org.orgId}_${"x".repeat(43)}`, org.orgId)).status).toBe(401);
    expect(
      (await call("/v1/teams", await pat(org.orgId, org.user("tmember"), { expired: true }), org.orgId)).status,
    ).toBe(401);
    expect(
      (await call("/v1/teams", await pat(org.orgId, org.user("tmember"), { revoked: true }), org.orgId)).status,
    ).toBe(401);
    // Token của tổ chức này không mở được tổ chức khác, kể cả khi chủ token thuộc cả hai.
    await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [
      other.orgId,
      org.user("tmember"),
    ]);
    const token = await pat(org.orgId, org.user("tmember"));
    expect((await call("/v1/teams", token, other.orgId)).status).toBe(401);
    // Spec 034 FR-094: header đúng tổ chức của token nhưng đường dẫn chọn tổ chức kia thì vẫn bị chặn.
    expect((await call(`/v1/orgs/${org.orgId}`, token, org.orgId)).status).toBe(200);
    expect((await call(`/v1/orgs/${other.orgId}`, token, org.orgId)).status).toBe(401);
    // Route SSE chọn tổ chức bằng `?org=` khi không có header; bridge token không thấy tham số này.
    const stream = (orgId: string) =>
      app.fetch(
        new Request(`${baseURL}/api/v1/runs/${randomUUID()}/stream?org=${orgId}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
    expect((await stream(org.orgId)).status).not.toBe(401);
    expect((await stream(other.orgId)).status).toBe(401);
  });

  it("machine token hay run token không thay được phiên người dùng", async () => {
    expect((await call("/v1/teams", `hwm_${randomBytes(32).toString("base64url")}`, org.orgId)).status).toBe(401);
    expect((await call("/v1/teams", "eyJhbGciOiJFZERTQSJ9.e30.x", org.orgId)).status).toBe(401);
  });

  it("token cá nhân không tự tạo, gia hạn hay thu hồi được token", async () => {
    const token = await pat(org.orgId, org.user("tmember"));
    const created = await call("/v1/mcp/admin/tokens", token, org.orgId, {
      method: "POST",
      body: JSON.stringify({ clientId: "x", lifetimeDays: 90 }),
    });
    expect(created.status).toBe(401);
  });
});
