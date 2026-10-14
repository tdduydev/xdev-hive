import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "./app.ts";
import { createAuth } from "./modules/identity/index.ts";
import { createPool, parseMasterKey } from "./modules/platform/index.ts";

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

describe("khung cách ly qua app.ts", () => {
  const webDist = mkdtempSync(join(tmpdir(), "hive-web-"));
  writeFileSync(join(webDist, "index.html"), "<!doctype html><title>SPA</title>");
  const httpApp = createApp({
    config: {
      port: 0,
      version: "t",
      publicUrl: "http://localhost:3000",
      masterKey: parseMasterKey(randomBytes(32).toString("base64")),
    },
    auth: createAuth({
      pool: authPool,
      baseURL: "http://localhost:3000",
      secret: "test-secret-0123456789abcdef-0123456789",
      allowEmailSignUp: true,
    }),
    pool: app,
    webDist,
  });
  let cookie = "";
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
      body: JSON.stringify({ name: "Mai", email: `frame-${tag}@example.com`, password: "mat-khau-du-dai-123" }),
    });
    expect(res.status).toBe(200);
    cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const userId = ((await res.json()) as { user: { id: string } }).user.id;
    orgId = randomUUID();
    await admin.query("insert into hive.orgs (id, slug, name, created_by) values ($1, $2, $2, $3)", [
      orgId,
      `frame-api-${tag}`,
      userId,
    ]);
    await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'owner')", [orgId, userId]);
  });

  afterAll(() => rmSync(webDist, { recursive: true, force: true }));

  it("frameUrl → khung mở được dù có hay không cookie phiên; frameDocument cho app", async () => {
    const created = await api("POST", "/artifacts", { type: "html", title: "Trang", content: "<b>chào</b>" });
    const id = (created.json.artifact as { id: string }).id;
    const issued = await api("GET", `/artifacts/${id}/versions/1/frame-url?theme=dark`);
    expect(issued.status).toBe(200);
    const url = new URL(issued.json.url as string);
    expect(url.origin).toBe("http://localhost:3000");
    expect(url.pathname.startsWith("/_artifact/frame/")).toBe(true);
    const anonymous = await httpApp.request(url.pathname);
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get("content-security-policy")).toContain("http://localhost:3000/_artifact/lib/");
    const body = await anonymous.text();
    expect(body).toContain("<b>chào</b>");
    expect(body).not.toContain("<title>SPA</title>");
    const withSession = await httpApp.request(url.pathname, { headers: { cookie, "x-hive-org": orgId } });
    expect(withSession.status).toBe(200);
    expect(withSession.headers.get("set-cookie")).toBeNull();
    expect(await withSession.text()).toBe(body);
    const doc = await api("GET", `/artifacts/${id}/versions/1/frame-document`);
    expect(doc.status).toBe(200);
    expect(doc.json.html).toContain("<b>chào</b>");
    expect(doc.json.csp).toContain("hive-artifact://localhost/lib/");
  });

  it("phiên người dùng không mở được khung khi vé hỏng; đường lạ dưới /_artifact/ không ra SPA", async () => {
    expect((await httpApp.request("/_artifact/frame/abc.def", { headers: { cookie } })).status).toBe(403);
    for (const path of ["/_artifact/khong-co", "/_artifact/lib/khong-co.js", "/_artifact/rpc/artifacts"]) {
      const res = await httpApp.request(path, { headers: { cookie } });
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain("SPA");
    }
    // SPA vẫn phục vụ đường khác như trước.
    expect(await (await httpApp.request("/artifacts")).text()).toContain("SPA");
  });

  it("preview: bí mật bị chặn 400 kèm dòng, audit ghi dù rollback; nội dung sạch thì có URL khung", async () => {
    const blocked = await api("POST", "/artifacts/preview", { type: "html", content: `<p>a</p>\n${FAKE_TOKEN}` });
    expect(blocked.status).toBe(400);
    expect(blocked.json.data).toMatchObject({ code: "ARTIFACT_SECRET_FOUND" });
    expect(JSON.stringify(blocked.json)).not.toContain(FAKE_TOKEN);
    const rows = await auditRows(orgId, "artifact.secret.blocked");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(FAKE_TOKEN);
    const ok = await api("POST", "/artifacts/preview", { type: "html", content: "<p>nháp</p>", theme: "light" });
    expect(ok.status).toBe(200);
    expect(ok.json.compileError).toBeNull();
    const frame = await httpApp.request(new URL(ok.json.url as string).pathname);
    expect(frame.status).toBe(200);
    expect(frame.headers.get("cache-control")).toBe("private, no-store");
  });

  it("link công khai: tạo, mở không cần phiên (không ra SPA), liệt kê không có mã, thu hồi thì 404", async () => {
    const created = await api("POST", "/artifacts", { type: "html", title: "Báo giá", content: "<b>công khai</b>" });
    const id = (created.json.artifact as { id: string }).id;
    const tooLong = await api("POST", `/artifacts/${id}/public-links`, { version: 1, expiresInDays: 31 });
    expect(tooLong.status).toBe(400);
    const made = await api("POST", `/artifacts/${id}/public-links`, { version: 1 });
    expect(made.status).toBe(200);
    const url = new URL(made.json.url as string);
    expect(url.origin).toBe("http://localhost:3000");
    const token = url.pathname.slice("/_artifact/s/".length);
    const link = made.json.link as { id: string; expiresAt: string; createdAt: string };
    expect((new Date(link.expiresAt).getTime() - new Date(link.createdAt).getTime()) / 86_400_000).toBeCloseTo(7, 3);

    const pageRes = await httpApp.request(url.pathname);
    expect(pageRes.status).toBe(200);
    const html = await pageRes.text();
    expect(html).not.toContain("<title>SPA</title>");
    expect(html).not.toMatch(/<script/i);
    const frame = /src="([^"]+)"/.exec(html)?.[1] ?? "";
    expect((await httpApp.request(new URL(frame).pathname)).status).toBe(200);

    const listed = await httpApp.request(`/api/v1/artifacts/${id}/public-links`, {
      headers: { cookie, "x-hive-org": orgId },
    });
    expect(listed.status).toBe(200);
    const listText = await listed.text();
    expect(listText).toContain(link.id);
    expect(listText).not.toContain(token);
    const orgList = await api("GET", "/artifact-public-links?limit=10");
    expect(orgList.status).toBe(200);
    expect((orgList.json.items as { id: string }[]).map((l) => l.id)).toContain(link.id);

    const revoked = await api("POST", `/artifact-public-links/${link.id}/revoke`, {});
    expect(revoked.status).toBe(200);
    expect(revoked.json).toMatchObject({ active: false, revokeReason: "manual" });
    const gone = await httpApp.request(url.pathname, { headers: { cookie } });
    expect(gone.status).toBe(404);
    expect(await gone.text()).toContain("Liên kết không tồn tại hoặc đã hết hạn.");
  });
});
