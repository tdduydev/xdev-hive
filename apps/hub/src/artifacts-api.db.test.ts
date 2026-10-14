import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "./app.ts";
import { createAuth } from "./modules/identity/index.ts";
import { createPool } from "./modules/platform/index.ts";

// Lớp API của artifacts.* qua HTTP (OpenAPI): lỗi mang chi tiết trong `data`, audit bí mật ghi bằng transaction riêng
// sau khi request rollback. Nghiệp vụ chi tiết ở modules/artifacts/artifacts.db.test.ts và access.db.test.ts.
const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);
const authPool = createPool(db.authUrl);
const tag = randomUUID().slice(0, 6);
// Mẫu PAT GitHub giả: đủ dạng để bộ quét bắt, không phải token thật.
const FAKE_TOKEN = `ghp_${"A1b2C3d4".repeat(5)}abcd`;

const auditRows = async (orgId: string, action: string) =>
  (await admin.query("select data from hive.audit_log where org_id = $1 and action = $2", [orgId, action])).rows as {
    data: Record<string, unknown>;
  }[];

afterAll(async () => {
  await Promise.all([admin.end(), app.end(), authPool.end()]);
});

describe("API HTTP", () => {
  const httpApp = createApp({
    config: { port: 0, version: "t" },
    auth: createAuth({
      pool: authPool,
      baseURL: "http://localhost:3000",
      secret: "test-secret-0123456789abcdef-0123456789",
      allowEmailSignUp: true,
    }),
    pool: app,
  });
  let cookie = "";
  let userId = "";
  let orgId = "";

  async function api(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { cookie, "x-hive-org": orgId };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await httpApp.request(`/api/v1${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: res.status,
      json: (await res.json()) as Record<string, unknown> & { data?: Record<string, unknown> },
    };
  }

  beforeAll(async () => {
    const res = await httpApp.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Lan", email: `art-${tag}@example.com`, password: "mat-khau-du-dai-123" }),
    });
    expect(res.status).toBe(200);
    cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    userId = ((await res.json()) as { user: { id: string } }).user.id;
    orgId = randomUUID();
    await admin.query("insert into hive.orgs (id, slug, name, created_by) values ($1, $2, $2, $3)", [
      orgId,
      `art-api-${tag}`,
      userId,
    ]);
    await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'owner')", [orgId, userId]);
  });

  it("tạo, đọc, lưu phiên bản, xung đột có bản mới nhất, cài đặt đang áp", async () => {
    const created = await api("POST", "/artifacts", { type: "markdown", title: "Sơ đồ", content: "# A" });
    expect(created.status).toBe(200);
    const id = (created.json.artifact as { id: string }).id;
    expect((await api("GET", `/artifacts/${id}`)).json).toMatchObject({ version: { version: 1, content: "# A" } });
    expect((await api("POST", `/artifacts/${id}/versions`, { content: "# B", baseVersion: 1 })).status).toBe(200);
    const conflict = await api("POST", `/artifacts/${id}/versions`, { content: "# C", baseVersion: 1 });
    expect(conflict.status).toBe(409);
    expect(conflict.json.data).toEqual({ code: "ARTIFACT_VERSION_CONFLICT", latest: { version: 2, content: "# B" } });
    const list = await api("GET", "/artifacts?limit=10");
    expect((list.json.items as { id: string }[]).map((a) => a.id)).toEqual([id]);
    expect((await api("GET", "/artifact-settings")).json).toMatchObject({
      enabled: true,
      scopes: ["private", "project"],
    });
    const usage = await api("GET", "/artifact-usage");
    expect(usage.json).toMatchObject({ artifacts: 1, usedBytes: 6 });
  });

  it("bí mật: 400 có dòng và loại; audit artifact.secret.blocked được ghi dù request rollback, không chứa chuỗi", async () => {
    const res = await api("POST", "/artifacts", { type: "markdown", title: "Lộ", content: `x\nkey: ${FAKE_TOKEN}` });
    expect(res.status).toBe(400);
    expect(res.json.data).toMatchObject({
      code: "ARTIFACT_SECRET_FOUND",
      findings: expect.arrayContaining([expect.objectContaining({ line: 2 })]),
    });
    expect(JSON.stringify(res.json)).not.toContain(FAKE_TOKEN);
    const rows = await auditRows(orgId, "artifact.secret.blocked");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toMatchObject({
      type: "markdown",
      findings: expect.arrayContaining([expect.objectContaining({ line: 2 })]),
    });
    expect(JSON.stringify(rows)).not.toContain(FAKE_TOKEN);
  });

  it("không phải thành viên tổ chức thì không gọi được", async () => {
    const saved = orgId;
    orgId = randomUUID();
    try {
      expect((await api("GET", "/artifacts")).status).toBe(403);
    } finally {
      orgId = saved;
    }
  });
});
