import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "./app.ts";
import { createAuth } from "./modules/identity/index.ts";
import { createPool } from "./modules/platform/index.ts";

// Kiểm lớp API của knowledge qua HTTP (OpenAPI): đăng nhập, header tổ chức, đổi lỗi nghiệp vụ thành mã HTTP, tham
// số GET đến dạng chuỗi. Nghiệp vụ chi tiết nằm ở modules/knowledge/knowledge.db.test.ts.
const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const authPool = createPool(db.authUrl);
const appPool = createPool(db.appUrl);
const suffix = randomUUID().slice(0, 8);
const app = createApp({
  config: { port: 0, version: "t" },
  auth: createAuth({
    pool: authPool,
    baseURL: "http://localhost:3000",
    secret: "test-secret-0123456789abcdef-0123456789",
    allowEmailSignUp: true,
  }),
  pool: appPool,
});

const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
let orgId = "";
let teamId = "";

async function api(who: string, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { cookie: cookies[who] ?? "", "x-hive-org": orgId };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(`/api/v1${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> & { data?: { code?: string } } };
}

beforeAll(async () => {
  for (const name of ["tadmin", "viewer"]) {
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, email: `${name}-${suffix}@example.com`, password: "mat-khau-du-dai-123" }),
    });
    expect(res.status).toBe(200);
    cookies[name] = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    ids[name] = ((await res.json()) as { user: { id: string } }).user.id;
  }
  orgId = randomUUID();
  await admin.query("insert into hive.orgs (id, slug, name, created_by) values ($1, $2, $2, $3)", [
    orgId,
    `kn-api-${suffix}`,
    ids.tadmin,
  ]);
  for (const n of ["tadmin", "viewer"])
    await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [
      orgId,
      ids[n],
    ]);
  teamId = (
    await admin.query("insert into hive.teams (org_id, slug, name) values ($1, 'nen-tang', 'Nền tảng') returning id", [
      orgId,
    ])
  ).rows[0].id;
  for (const [n, role] of [
    ["tadmin", "admin"],
    ["viewer", "viewer"],
  ] as const)
    await admin.query("insert into hive.team_members (team_id, org_id, user_id, role) values ($1, $2, $3, $4)", [
      teamId,
      orgId,
      ids[n],
      role,
    ]);
});

afterAll(async () => {
  await Promise.all([admin.end(), authPool.end(), appPool.end()]);
});

describe("API knowledge", () => {
  it("ghi và tìm memory; người xem nhận 403 kèm mã lý do", async () => {
    const scope = { level: "team", teamId };
    const write = await api("tadmin", "POST", "/memories", {
      scope,
      kind: "gotcha",
      content: "Hàng đợi pg-boss cần quyền INSERT",
    });
    expect(write.status).toBe(200);
    const denied = await api("viewer", "POST", "/memories", { scope, kind: "note", content: "x" });
    expect([denied.status, denied.json.data?.code]).toEqual([403, "TEAM_ROLE_REQUIRED"]);
    const found = await api("viewer", "GET", `/memories/search?query=${encodeURIComponent("hàng đợi")}&limit=5`);
    expect(found.status).toBe(200);
    expect((found.json as unknown as Array<{ id: string }>).map((m) => m.id)).toEqual([write.json.id]);
    const listed = await api("viewer", "GET", "/memories?includeSuperseded=false&limit=10");
    expect(listed.status).toBe(200);
  });

  it("lưu tài liệu từ base cũ thì 409 VERSION_CONFLICT; đọc lại phiên bản theo query", async () => {
    const key = "team/nen-tang/van-hanh";
    expect((await api("tadmin", "POST", "/docs", { key, content: "v1", baseVersion: 0 })).status).toBe(200);
    expect((await api("tadmin", "POST", "/docs", { key, content: "v2", baseVersion: 1 })).status).toBe(200);
    const stale = await api("tadmin", "POST", "/docs", { key, content: "đè", baseVersion: 1 });
    expect([stale.status, stale.json.data?.code]).toEqual([409, "VERSION_CONFLICT"]);
    const v1 = await api("viewer", "GET", `/docs/item?key=${encodeURIComponent(key)}&version=1`);
    expect([v1.status, v1.json.content]).toEqual([200, "v1"]);
    const missing = await api("viewer", "GET", `/docs/item?key=${encodeURIComponent("org/khong-co")}`);
    expect([missing.status, missing.json.data?.code]).toEqual([404, "DOC_NOT_FOUND"]);
  });

  it("đề xuất rồi duyệt qua API", async () => {
    const key = "team/nen-tang/de-xuat";
    await api("tadmin", "POST", "/docs", { key, content: "v1", baseVersion: 0 });
    const viewerTry = await api("viewer", "POST", "/proposals", { kind: "doc", key, content: "v2", baseVersion: 1 });
    expect(viewerTry.status).toBe(403);
    const prop = await api("tadmin", "POST", "/proposals", { kind: "doc", key, content: "v2", baseVersion: 1 });
    expect(prop.json.status).toBe("pending");
    const approved = await api("tadmin", "POST", `/proposals/${prop.json.id}/approve`, { note: "Ổn" });
    expect([approved.status, approved.json.resultVersion]).toEqual([200, 2]);
    const pending = await api("viewer", "GET", "/proposals?status=pending");
    expect(pending.json).toEqual([]);
  });

  it("skill: lưu và đọc theo tên", async () => {
    const save = await api("tadmin", "POST", "/skills", {
      scope: { level: "org" },
      name: "x",
      description: "d",
      content: "c",
      baseVersion: 0,
    });
    // Quản trị đội không phải quản trị tổ chức.
    expect([save.status, save.json.data?.code]).toEqual([403, "ORG_ROLE_REQUIRED"]);
    await api("tadmin", "POST", "/skills", {
      scope: { level: "team", teamId },
      name: "van-hanh",
      description: "Vận hành hub",
      content: "# Vận hành",
      baseVersion: 0,
    });
    const list = await api("viewer", "GET", "/skills");
    expect((list.json as unknown as Array<{ name: string }>).map((s) => s.name)).toEqual(["van-hanh"]);
    const bad = await api("viewer", "GET", "/skills/item");
    expect(bad.status).toBe(400);
  });
});
