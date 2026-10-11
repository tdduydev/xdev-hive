import { getSchema } from "better-auth/db";
import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";
import { createApp } from "./app.ts";
import { authConfig, createAuth } from "./modules/identity/index.ts";
import { createPool } from "./modules/platform/index.ts";

const { adminUrl, appUrl, authUrl } = inject("db");
const authPool = createPool(authUrl);
const admin = new pg.Pool({ connectionString: adminUrl });
const appPool = createPool(appUrl);
const opts = { pool: authPool, baseURL: "http://localhost:3000", secret: "test-secret-0123456789abcdef-0123456789" };
const app = createApp({ config: { port: 0, version: "t" }, auth: createAuth({ ...opts, allowEmailSignUp: true }) });
const closedApp = createApp({ config: { port: 0, version: "t" }, auth: createAuth(opts) });

afterAll(async () => {
  await Promise.all([authPool.end(), admin.end(), appPool.end()]);
});

const post = (target: ReturnType<typeof createApp>, path: string, body: unknown) =>
  target.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

describe("schema của Better Auth", () => {
  it("bảng và cột trong schema auth khớp với những gì Better Auth cần", async () => {
    const want = getSchema(authConfig({ ...opts, github: { clientId: "a", clientSecret: "b" } }) as never);
    const { rows } = await admin.query<{ table_name: string; column_name: string }>(
      "select table_name, column_name from information_schema.columns where table_schema = 'auth'",
    );
    const have = new Map<string, Set<string>>();
    for (const r of rows) have.set(r.table_name, (have.get(r.table_name) ?? new Set()).add(r.column_name));
    for (const [model, def] of Object.entries(want)) {
      const table = (def as { modelName?: string }).modelName ?? model;
      const cols = have.get(table);
      expect(cols, `thiếu bảng auth.${table}`).toBeDefined();
      for (const [key, f] of Object.entries((def as { fields: Record<string, { fieldName?: string }> }).fields)) {
        expect(cols?.has(f.fieldName ?? key), `thiếu cột auth.${table}.${f.fieldName ?? key}`).toBe(true);
      }
    }
  });
});

describe("đăng nhập bằng email", () => {
  const email = `duy+${Date.now()}@example.com`;
  const password = "mat-khau-du-dai-123";

  it("đăng ký, rồi gọi /api/v1/me bằng cookie phiên", async () => {
    const res = await post(app, "/api/auth/sign-up/email", { name: "Duy", email, password });
    expect(res.status).toBe(200);
    const me = await app.request("/api/v1/me", { headers: { cookie: cookieOf(res) } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ name: "Duy", email });
  });

  it("đăng nhập lại bằng mật khẩu đúng", async () => {
    const res = await post(app, "/api/auth/sign-in/email", { email, password });
    expect(res.status).toBe(200);
    expect(cookieOf(res)).toMatch(/session_token=/);
  });

  it("mật khẩu sai trả 401", async () => {
    expect((await post(app, "/api/auth/sign-in/email", { email, password: "sai-mat-khau-0000" })).status).toBe(401);
  });

  it("không cho tự đăng ký khi chưa bật", async () => {
    const res = await post(closedApp, "/api/auth/sign-up/email", { name: "X", email: "x@example.com", password });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("mật khẩu không lưu dạng gốc", async () => {
    const { rows } = await admin.query(
      `select a.password from auth.account a join auth."user" u on u.id = a."userId" where u.email = $1`,
      [email],
    );
    expect(rows[0].password).not.toContain(password);
  });
});

describe("quyền của hive_app trên schema auth", () => {
  it("đọc được tên và email", async () => {
    await expect(appPool.query(`select id, name, email from auth."user" limit 1`)).resolves.toBeDefined();
  });
  it("không đọc được tài khoản, phiên, mật khẩu", async () => {
    await expect(appPool.query("select password from auth.account")).rejects.toThrow(/permission denied/);
    await expect(appPool.query("select token from auth.session")).rejects.toThrow(/permission denied/);
    await expect(appPool.query(`select "emailVerified" from auth."user"`)).rejects.toThrow(/permission denied/);
  });
});

describe("đăng nhập bằng GitHub và GitLab", () => {
  const social = createApp({
    config: { port: 0, version: "t" },
    auth: createAuth({
      ...opts,
      github: { clientId: "gh-client", clientSecret: "gh-secret" },
      gitlab: { clientId: "gl-client", clientSecret: "gl-secret", issuer: "https://gitlab.example.com" },
    }),
  });

  it("GitHub: trả URL chuyển sang trang đồng ý của GitHub với đúng client id", async () => {
    const res = await post(social, "/api/auth/sign-in/social", { provider: "github", callbackURL: "/" });
    const { url } = (await res.json()) as { url: string };
    const u = new URL(url);
    expect(u.origin).toBe("https://github.com");
    expect(u.searchParams.get("client_id")).toBe("gh-client");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/callback/github");
  });

  it("GitLab tự host: chuyển sang đúng máy chủ GitLab", async () => {
    const res = await post(social, "/api/auth/sign-in/social", { provider: "gitlab", callbackURL: "/" });
    const { url } = (await res.json()) as { url: string };
    expect(new URL(url).origin).toBe("https://gitlab.example.com");
  });

  it("nhà cung cấp chưa cấu hình thì từ chối", async () => {
    const res = await post(app, "/api/auth/sign-in/social", { provider: "github", callbackURL: "/" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("SSO (OIDC)", () => {
  it("đăng ký nhà cung cấp SSO đòi phải đăng nhập", async () => {
    const res = await post(app, "/api/auth/sso/register", {
      providerId: "fpt-azure",
      issuer: "https://login.example.com",
      domain: "example.com",
      oidcConfig: { clientId: "a", clientSecret: "b" },
    });
    expect(res.status).toBe(401);
  });
});
