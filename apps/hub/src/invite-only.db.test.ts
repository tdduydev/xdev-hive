import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { type MockIdp, startMockIdp } from "../test/oidc-idp.ts";
import { freshDatabase } from "../test/seed.ts";
import { createApp } from "./app.ts";
import { type AuthHooks, type AuthOptions, createAuth } from "./modules/identity/index.ts";
import { createPool } from "./modules/platform/index.ts";
import { authHooks } from "./modules/tenancy/index.ts";

// Hub chỉ tạo tài khoản cho người được mời, người quản trị hub (HIVE_ORG_CREATORS) và người vào bằng SSO đúng tên
// miền đã xác minh của tổ chức; quy tắc nằm ở user.validateUserInfo nên áp cho mọi cách đăng nhập.

// Database chung với các file test khác: email có hậu tố riêng để không đụng người dùng của file khác.
const run = randomUUID().slice(0, 8);
const mail = (name: string, domain = "example.com") => `${name}-${run}@${domain}`;
const CORP = `corp-${run}.test`;
const PUBLIC_URL = "http://localhost:3000";
const SECRET = "test-secret-0123456789abcdef-0123456789";
const PASSWORD = "mat-khau-du-dai-123";
const ADMIN = mail("quan-tri");
// Ký hiệu Kelvin (U+212A): toLowerCase() biến nó thành chữ "k" ASCII.
const KELVIN = "K";

const { adminUrl, appUrl, authUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const authPool = createPool(authUrl);
const appPool = createPool(appUrl);
let idp: MockIdp;
type App = ReturnType<typeof createApp>;
let app: App;
// Bật HIVE_ALLOW_EMAIL_SIGNUP=1: hành vi cũ cho môi trường dev.
let openApp: App;
let authOpts: AuthOptions;
let ownerCookie = "";
let orgId = "";

const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
/** Có cookie phiên còn dùng được (không phải cookie xoá phiên, Max-Age=0). */
const liveSession = (res: Response) =>
  res.headers.getSetCookie().some((c) => c.includes("session_token=") && !c.includes("Max-Age=0"));

function send(target: App, method: string, path: string, opts: { cookie?: string; body?: unknown; org?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.org) headers["x-hive-org"] = opts.org;
  return target.request(path, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

const signUp = (target: App, email: string, extra: object = {}) =>
  send(target, "POST", "/api/auth/sign-up/email", {
    body: { name: email.split("@")[0], email, password: PASSWORD, ...extra },
  });

async function usersWithEmail(email: string) {
  const { rows } = await admin.query(`select 1 from auth."user" where email = $1`, [email.toLowerCase()]);
  return rows.length;
}
const userExists = async (email: string) => (await usersWithEmail(email)) === 1;

async function invite(email: string, org = orgId) {
  const res = await send(app, "POST", "/api/v1/invitations", {
    cookie: ownerCookie,
    org,
    body: { emails: [email] },
  });
  expect(res.status).toBe(200);
  const [inv] = ((await res.json()) as { invitations: { link: string }[] }).invitations;
  return inv?.link.split("/invite/")[1] ?? "";
}

/** Thu hồi lời mời là xoá dòng (invitations.revoke). */
const revoke = (email: string) => admin.query("delete from hive.invitations where email = $1", [email.toLowerCase()]);

async function verifyDomain(verified: boolean, providerId = `org-${orgId}`) {
  await admin.query(`update auth."ssoProvider" set "domainVerified" = $1 where "providerId" = $2`, [
    verified,
    providerId,
  ]);
}

// --- GitHub và GitLab giả: thay fetch tới hai nhà cung cấp, các địa chỉ khác (IdP giả) đi qua như thường. ---

interface OAuthUser {
  id: number;
  login: string;
  email: string;
  verified: boolean;
}
const nextUser: Record<string, OAuthUser | undefined> = {};
const tokens = new Map<string, OAuthUser>();
const realFetch = globalThis.fetch;

function fakeProviderFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const json = (body: unknown) => Promise.resolve(Response.json(body));
  const issueToken = (provider: string) => {
    const user = nextUser[provider];
    if (!user) return json({ error: "bad_verification_code" });
    const token = randomUUID();
    tokens.set(token, user);
    return json({ access_token: token, token_type: "bearer", scope: "read_user" });
  };
  const caller = () => {
    const auth = new Headers(input instanceof Request ? input.headers : init?.headers).get("authorization") ?? "";
    return tokens.get(auth.replace(/^Bearer /i, ""));
  };
  const unauthorized = () => Promise.resolve(Response.json({ message: "Bad credentials" }, { status: 401 }));
  if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token") return issueToken("github");
  if (url.origin === "https://api.github.com") {
    const user = caller();
    if (!user) return unauthorized();
    if (url.pathname === "/user") return json({ id: user.id, login: user.login, name: user.login, email: null });
    if (url.pathname === "/user/emails") return json([{ email: user.email, primary: true, verified: user.verified }]);
  }
  if (url.origin === "https://gitlab.com" && url.pathname === "/oauth/token") return issueToken("gitlab");
  if (url.origin === "https://gitlab.com" && url.pathname === "/api/v4/user") {
    const user = caller();
    if (!user) return unauthorized();
    // Như GitLab thật: /api/v4/user không có email_verified, chỉ có confirmed_at.
    return json({
      id: user.id,
      username: user.login,
      name: user.login,
      email: user.email,
      state: "active",
      locked: false,
      confirmed_at: user.verified ? "2026-01-01T00:00:00Z" : null,
    });
  }
  return realFetch(input, init);
}

/** Đi hết luồng OAuth như trình duyệt; web gửi errorCallbackURL là trang đăng nhập. */
async function oauthSignIn(target: App, user: OAuthUser, provider: "github" | "gitlab" = "github") {
  nextUser[provider] = user;
  const start = await send(target, "POST", "/api/auth/sign-in/social", {
    body: { provider, callbackURL: "/", errorCallbackURL: "/login" },
  });
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state") ?? "";
  const done = await send(target, "GET", `/api/auth/callback/${provider}?code=c-${user.id}&state=${state}`, {
    cookie: cookieOf(start),
  });
  expect(done.status).toBe(302);
  const location = new URL(done.headers.get("location") ?? "", PUBLIC_URL);
  return {
    location,
    error: location.searchParams.get("error"),
    description: location.searchParams.get("error_description"),
    sessionCookie: liveSession(done),
    cookie: cookieOf(done),
  };
}
const githubSignIn = (target: App, user: OAuthUser) => oauthSignIn(target, user, "github");

let nextOAuthId = Number.parseInt(run, 16) % 1_000_000_000;
const oauthUser = (email: string, verified = true): OAuthUser => ({
  id: ++nextOAuthId,
  login: email.split("@")[0] ?? "x",
  email,
  verified,
});

/** Luồng OIDC như trình duyệt: hub → IdP authorize → callback của hub. */
async function ssoSignIn(email: string) {
  idp.signInAs({ sub: `sub-${email}`, email, name: email.split("@")[0] ?? email });
  const start = await send(app, "POST", "/api/auth/sign-in/sso", {
    body: { providerId: `org-${orgId}`, callbackURL: "/", errorCallbackURL: "/login" },
  });
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const authorize = await fetch(url, { redirect: "manual" });
  const callback = new URL(authorize.headers.get("location") ?? "");
  const done = await send(app, "GET", callback.pathname + callback.search, { cookie: cookieOf(start) });
  expect(done.status).toBe(302);
  const location = new URL(done.headers.get("location") ?? "", PUBLIC_URL);
  return {
    error: location.searchParams.get("error"),
    description: location.searchParams.get("error_description"),
    cookie: cookieOf(done),
  };
}

/** App dùng cùng database và secret nhưng thay một vài hook đăng nhập (giả lập lời mời bị thu hồi giữa chừng...). */
function appWith(overrides: Partial<AuthHooks>, extra: Partial<AuthOptions> = {}) {
  return createApp({
    config: { port: 0, version: "t", publicUrl: PUBLIC_URL },
    auth: createAuth({ ...authOpts, ...extra, hooks: { ...authHooks(appPool), ...overrides } }),
    pool: appPool,
  });
}

beforeAll(async () => {
  vi.stubGlobal("fetch", fakeProviderFetch);
  idp = await startMockIdp();
  authOpts = {
    pool: authPool,
    baseURL: PUBLIC_URL,
    secret: SECRET,
    // IdP giả chạy ở 127.0.0.1: plugin SSO chặn host nội bộ trừ khi có trong trustedOrigins.
    trustedOrigins: [PUBLIC_URL, idp.issuer],
    github: { clientId: "gh-client", clientSecret: "gh-secret" },
    gitlab: { clientId: "gl-client", clientSecret: "gl-secret" },
    orgCreators: [ADMIN, mail("kate")],
    hooks: authHooks(appPool),
  };
  // Chủ tổ chức của file này nằm trong danh sách tạo tổ chức của tenancy: database dùng chung nên file khác có thể đã
  // tạo tổ chức đầu tiên. Danh sách của đăng nhập (authOpts.orgCreators) không có chủ tổ chức.
  const config = { port: 0, version: "t", publicUrl: PUBLIC_URL, orgCreators: [ADMIN, mail("chu")] };
  app = createApp({ config, auth: createAuth({ ...authOpts, allowEmailSignUp: false }), pool: appPool });
  openApp = createApp({ config, auth: createAuth({ ...authOpts, allowEmailSignUp: true }), pool: appPool });

  // Chủ tổ chức dùng để mời và cấu hình SSO; tạo bằng openApp cho gọn.
  const owner = await signUp(openApp, mail("chu"));
  expect(owner.status).toBe(200);
  ownerCookie = cookieOf(owner);
  const org = await send(app, "POST", "/api/v1/orgs", {
    cookie: ownerCookie,
    body: { name: `Tổ chức ${run}`, slug: `org-${run}` },
  });
  expect(org.status).toBe(200);
  orgId = ((await org.json()) as { id: string }).id;
  const sso = await send(app, "PUT", "/api/v1/sso", {
    cookie: ownerCookie,
    org: orgId,
    body: { issuer: idp.issuer, domain: CORP, clientId: idp.clientId, clientSecret: idp.clientSecret, join: "pending" },
  });
  expect(sso.status).toBe(200);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await idp.close();
  await Promise.all([admin.end(), authPool.end(), appPool.end()]);
});

describe("email + mật khẩu", () => {
  it("không có lời mời: từ chối, không tạo người dùng", async () => {
    const res = await signUp(app, mail("la"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: "SIGN_UP_INVITE_REQUIRED",
      message: /chỉ cho đăng ký bằng lời mời/,
    });
    expect(cookieOf(res)).not.toMatch(/session_token=/);
    expect(await userExists(mail("la"))).toBe(false);
  });

  it("email đã có tài khoản mà không có lời mời: vẫn 403, không lộ email đã tồn tại", async () => {
    const res = await signUp(app, mail("chu"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("SIGN_UP_INVITE_REQUIRED");
  });

  it("email trong HIVE_ORG_CREATORS khi hub đã có tổ chức: cùng 403 như người ngoài danh sách", async () => {
    // Mật khẩu không chứng minh ai giữ hộp thư: mở cho người quản trị chỉ lúc hub còn trống (xem describe bên dưới).
    const res = await signUp(app, ADMIN.toUpperCase());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("SIGN_UP_INVITE_REQUIRED");
    expect(await userExists(ADMIN)).toBe(false);
  });

  it("có lời mời (kèm mã trong link): được tạo và vào tổ chức", async () => {
    const email = mail("duoc-moi");
    const token = await invite(email);
    const res = await signUp(app, email, { inviteToken: token });
    expect(res.status).toBe(200);
    const { rows } = await admin.query(
      `select m.status from hive.org_members m join auth."user" u on u.id = m.user_id where m.org_id = $1 and u.email = $2`,
      [orgId, email],
    );
    expect(rows).toEqual([{ status: "active" }]);
  });

  it("có lời mời nhưng không kèm mã: từ chối, vì mật khẩu không chứng minh ai giữ hộp thư", async () => {
    const email = mail("biet-email");
    await invite(email);
    expect((await signUp(app, email)).status).toBe(403);
    expect(await userExists(email)).toBe(false);
  });

  it("lời mời bị thu hồi giữa lúc kiểm và lúc nhận: xoá tài khoản vừa tạo, không có phiên, báo mã mời hỏng", async () => {
    const email = mail("thu-hoi-giua-chung");
    const token = await invite(email);
    const real = authHooks(appPool);
    const racing = appWith({
      acceptInvite: async (t, user) => {
        await revoke(email);
        await real.acceptInvite(t, user);
      },
    });
    const res = await signUp(racing, email, { inviteToken: token });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("SIGN_UP_INVITE_INVALID");
    expect(liveSession(res)).toBe(false);
    expect(await userExists(email)).toBe(false);
  });

  it("lời mời hết hạn giữa lúc kiểm và lúc nhận: cũng vậy", async () => {
    const email = mail("het-han-giua-chung");
    const token = await invite(email);
    const real = authHooks(appPool);
    const racing = appWith({
      acceptInvite: async (t, user) => {
        await admin.query("update hive.invitations set expires_at = now() - interval '1 second' where email = $1", [
          email,
        ]);
        await real.acceptInvite(t, user);
      },
    });
    const res = await signUp(racing, email, { inviteToken: token });
    expect(res.status).toBe(403);
    expect(await userExists(email)).toBe(false);
    // Lời mời mới thì đăng ký lại được.
    expect((await signUp(app, email, { inviteToken: await invite(email) })).status).toBe(200);
  });

  it("nhận lời mời lỗi vì lý do khác: vẫn xoá tài khoản vừa tạo, báo lỗi thử lại", async () => {
    const email = mail("loi-khac");
    const token = await invite(email);
    const broken = appWith({
      acceptInvite: async () => {
        throw new Error("mất kết nối database");
      },
    });
    const res = await signUp(broken, email, { inviteToken: token });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { code: string }).code).toBe("SIGN_UP_INVITE_ACCEPT_FAILED");
    expect(liveSession(res)).toBe(false);
    expect(await userExists(email)).toBe(false);
  });

  it("email có ký tự ngoài ASCII (Kelvin) không khớp được người quản trị hub hay lời mời", async () => {
    const res = await signUp(app, `${KELVIN}ate-${run}@example.com`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("EMAIL_NOT_ASCII");
    expect(await userExists(mail("kate"))).toBe(false);
  });

  it("HIVE_ALLOW_EMAIL_SIGNUP=1: như cũ, ai cũng đăng ký được", async () => {
    expect((await signUp(openApp, mail("tu-do"))).status).toBe(200);
  });
});

describe("người quản trị hub đăng ký bằng mật khẩu khi hub còn trống", () => {
  // Database riêng: database chung luôn có tổ chức do các file test khác tạo.
  const creator = mail("dung-hub");
  const second = mail("dung-hub-2");
  let fresh: { app: App; auth: pg.Pool; pool: pg.Pool; admin: pg.Pool };

  beforeAll(async () => {
    const urls = await freshDatabase(inject("db"));
    const auth = createPool(urls.authUrl);
    const pool = createPool(urls.appUrl);
    const hubApp = createApp({
      config: { port: 0, version: "t", publicUrl: PUBLIC_URL },
      auth: createAuth({ ...authOpts, pool: auth, orgCreators: [creator, second], hooks: authHooks(pool) }),
      pool,
    });
    fresh = { app: hubApp, auth, pool, admin: new pg.Pool({ connectionString: urls.adminUrl }) };
  });

  afterAll(async () => {
    await Promise.all([fresh.auth.end(), fresh.pool.end(), fresh.admin.end()]);
  });

  it("chưa có tổ chức nào: người trong danh sách đăng ký được, người ngoài thì không", async () => {
    expect((await signUp(fresh.app, mail("nguoi-ngoai"))).status).toBe(403);
    const res = await signUp(fresh.app, creator);
    expect(res.status).toBe(200);
    expect(liveSession(res)).toBe(true);
  });

  it("đăng ký lại email đã có: cùng 403 như người ngoài danh sách, không lộ ai đã đăng ký", async () => {
    const res = await signUp(fresh.app, creator);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("SIGN_UP_INVITE_REQUIRED");
  });

  it("đã có tổ chức: người quản trị khác phải vào bằng GitHub/GitLab có email đã xác minh, hoặc lời mời", async () => {
    const login = await send(fresh.app, "POST", "/api/auth/sign-in/email", {
      body: { email: creator, password: PASSWORD },
    });
    const org = await send(fresh.app, "POST", "/api/v1/orgs", {
      cookie: cookieOf(login),
      body: { name: "Tổ chức đầu tiên", slug: `dau-tien-${run}` },
    });
    expect(org.status).toBe(200);
    const res = await signUp(fresh.app, second);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("SIGN_UP_INVITE_REQUIRED");
    expect((await githubSignIn(fresh.app, oauthUser(second))).error).toBeNull();
    const { rows } = await fresh.admin.query(`select 1 from auth."user" where email = $1`, [second]);
    expect(rows).toHaveLength(1);
  });
});

describe("GitHub", () => {
  it("người mới không có lời mời: chuyển về trang đăng nhập kèm mã lỗi, không tạo người dùng, không có phiên", async () => {
    const email = mail("gh-la");
    const r = await githubSignIn(app, oauthUser(email));
    expect(r.location.pathname).toBe("/login");
    expect(r.error).toBe("SIGN_UP_NOT_INVITED");
    expect(r.description).toMatch(/Hub chỉ nhận người được mời/);
    expect(r.sessionCookie).toBe(false);
    expect(await userExists(email)).toBe(false);
  });

  it("có lời mời đúng email: tạo tài khoản rồi nhận lời mời được", async () => {
    const email = mail("gh-moi");
    const token = await invite(email);
    const user = oauthUser(email);
    const r = await githubSignIn(app, user);
    expect(r.error).toBeNull();
    expect(r.location.pathname).toBe("/");
    expect(r.sessionCookie).toBe(true);
    const accept = await send(app, "POST", "/api/v1/invitations/accept", { cookie: r.cookie, body: { token } });
    expect(accept.status).toBe(200);

    // Lời mời đã dùng: lần sau là đăng nhập của người đã có tài khoản, không qua quy tắc tạo người dùng.
    const again = await githubSignIn(app, user);
    expect(again.error).toBeNull();
    expect(again.sessionCookie).toBe(true);
  });

  it("email chưa xác minh: cùng mã lỗi và cùng câu báo dù có hay không có lời mời", async () => {
    const invited = mail("gh-chua-xac-minh");
    await invite(invited);
    const withInvite = await githubSignIn(app, oauthUser(invited, false));
    const withoutInvite = await githubSignIn(app, oauthUser(mail("gh-chua-xac-minh-la"), false));
    expect(withInvite.error).toBe("SIGN_UP_NOT_INVITED");
    expect([withoutInvite.error, withoutInvite.description]).toEqual([withInvite.error, withInvite.description]);
    expect(await userExists(invited)).toBe(false);
  });

  it("email chưa xác minh trong HIVE_ORG_CREATORS: cũng cùng mã đó", async () => {
    const r = await githubSignIn(app, oauthUser(mail("kate"), false));
    expect(r.error).toBe("SIGN_UP_NOT_INVITED");
    expect(await userExists(mail("kate"))).toBe(false);
  });

  it("lời mời của email khác thì không tính", async () => {
    await invite(mail("gh-nguoi-khac"));
    const r = await githubSignIn(app, oauthUser(mail("gh-khong-phai")));
    expect(r.error).toBe("SIGN_UP_NOT_INVITED");
  });

  it("lời mời hết hạn thì không tính", async () => {
    const email = mail("gh-het-han");
    await invite(email);
    await admin.query("update hive.invitations set expires_at = now() - interval '1 minute' where email = $1", [email]);
    const r = await githubSignIn(app, oauthUser(email));
    expect(r.error).toBe("SIGN_UP_NOT_INVITED");
    expect(await userExists(email)).toBe(false);
  });

  it("lời mời bị thu hồi thì không tính", async () => {
    const email = mail("gh-thu-hoi");
    await invite(email);
    await revoke(email);
    const r = await githubSignIn(app, oauthUser(email));
    expect(r.error).toBe("SIGN_UP_NOT_INVITED");
    expect(await userExists(email)).toBe(false);
  });

  it("lời mời đã được nhận thì không tính", async () => {
    const email = mail("gh-da-nhan");
    await invite(email);
    await admin.query("update hive.invitations set accepted_at = now() where email = $1", [email]);
    const r = await githubSignIn(app, oauthUser(email));
    expect(r.error).toBe("SIGN_UP_NOT_INVITED");
    expect(await userExists(email)).toBe(false);
  });

  it("GitHub trả email viết hoa: vẫn khớp lời mời viết thường, tài khoản lưu chữ thường", async () => {
    const email = mail("gh-hoa");
    const token = await invite(email);
    const r = await githubSignIn(app, oauthUser(`GH-Hoa-${run}@Example.COM`));
    expect(r.error).toBeNull();
    expect(await userExists(email)).toBe(true);
    expect((await send(app, "POST", "/api/v1/invitations/accept", { cookie: r.cookie, body: { token } })).status).toBe(
      200,
    );
  });

  it("GitHub trả email viết hoa: khớp HIVE_ORG_CREATORS viết thường", async () => {
    const r = await githubSignIn(app, oauthUser(ADMIN.toUpperCase()));
    expect(r.error).toBeNull();
    expect(await userExists(ADMIN)).toBe(true);
  });

  it("email ngoài ASCII (Kelvin) đã xác minh: không khớp lời mời của email ASCII tương ứng", async () => {
    const email = mail("kelvin-gh");
    await invite(email);
    const r = await githubSignIn(app, oauthUser(`${KELVIN}elvin-gh-${run}@example.com`));
    expect(r.error).toBe("EMAIL_NOT_ASCII");
    expect(await userExists(email)).toBe(false);
  });

  it("người đã có tài khoản email + mật khẩu (chưa xác minh) đăng nhập GitHub cùng email: account_not_linked", async () => {
    // Hành vi người dùng sẽ gặp sau khi đổi sang invite-only: Better Auth không gắn GitHub vào tài khoản có email chưa
    // xác minh (requireLocalEmailVerified), và cũng không tạo người dùng thứ hai.
    const email = mail("gh-co-mat-khau");
    expect((await signUp(openApp, email)).status).toBe(200);
    const r = await githubSignIn(app, oauthUser(email));
    expect(r.error).toBe("account_not_linked");
    expect(r.sessionCookie).toBe(false);
    expect(await usersWithEmail(email)).toBe(1);
  });

  it("người đã có tài khoản (không còn lời mời nào): đăng nhập bình thường", async () => {
    const email = mail("gh-cu");
    const user = oauthUser(email);
    expect((await githubSignIn(openApp, user)).error).toBeNull();
    const r = await githubSignIn(app, user);
    expect(r.error).toBeNull();
    expect(r.sessionCookie).toBe(true);
    const me = await send(app, "GET", "/api/v1/me", { cookie: r.cookie });
    expect(await me.json()).toMatchObject({ email });
  });

  it("HIVE_ALLOW_EMAIL_SIGNUP=1: như cũ, người mới vào thẳng", async () => {
    const email = mail("gh-tu-do");
    const r = await githubSignIn(openApp, oauthUser(email));
    expect(r.error).toBeNull();
    expect(await userExists(email)).toBe(true);
  });
});

describe("GitLab", () => {
  it("người mới không có lời mời: từ chối, không tạo người dùng", async () => {
    const email = mail("gl-la");
    const r = await oauthSignIn(app, oauthUser(email), "gitlab");
    expect(r.error).toBe("SIGN_UP_NOT_INVITED");
    expect(r.sessionCookie).toBe(false);
    expect(await userExists(email)).toBe(false);
  });

  it("có lời mời, email đã xác nhận trên GitLab (confirmed_at): được tạo", async () => {
    const email = mail("gl-moi");
    await invite(email);
    const r = await oauthSignIn(app, oauthUser(email), "gitlab");
    expect(r.error).toBeNull();
    expect(r.sessionCookie).toBe(true);
    expect(await userExists(email)).toBe(true);
  });

  it("có lời mời nhưng email chưa xác nhận: cùng mã như không có lời mời", async () => {
    const email = mail("gl-chua-xac-nhan");
    await invite(email);
    const r = await oauthSignIn(app, oauthUser(email, false), "gitlab");
    expect(r.error).toBe("SIGN_UP_NOT_INVITED");
    expect(await userExists(email)).toBe(false);
  });
});

describe("SSO của tổ chức", () => {
  it("tên miền chưa xác minh: email đúng tên miền, có hay không có lời mời, đều không được tạo (cùng mã)", async () => {
    const plain = await ssoSignIn(mail("nv-chua", CORP));
    const invitedEmail = mail("nv-chua-moi", CORP);
    await invite(invitedEmail);
    const invited = await ssoSignIn(invitedEmail);
    expect(plain.error).toBe("SIGN_UP_NOT_INVITED");
    expect([invited.error, invited.description]).toEqual([plain.error, plain.description]);
    expect(await userExists(mail("nv-chua", CORP))).toBe(false);
    expect(await userExists(invitedEmail)).toBe(false);
  });

  it("tên miền đã xác minh, email đúng tên miền: được tạo, vào tổ chức theo chính sách sso_join", async () => {
    await verifyDomain(true);
    const email = mail("nhan-vien", CORP);
    const r = await ssoSignIn(email);
    expect(r.error).toBeNull();
    const { rows } = await admin.query(
      `select m.status from hive.org_members m join auth."user" u on u.id = m.user_id where m.org_id = $1 and u.email = $2`,
      [orgId, email],
    );
    expect(rows).toEqual([{ status: "pending" }]);
  });

  it("email khác tên miền: từ chối, cùng mã và cùng câu báo dù có lời mời", async () => {
    // Plugin SSO không tin email_verified của IdP, mà IdP của một tổ chức phát được email bất kỳ: tin nó thì tổ chức
    // này chiếm trước được tài khoản của người ngoài tên miền mình. Người đó vào bằng link mời hoặc GitHub/GitLab.
    const stranger = await ssoSignIn(mail("khach", `khac-${run}.test`));
    const partner = mail("doi-tac", `khac-${run}.test`);
    await invite(partner);
    const invited = await ssoSignIn(partner);
    expect(stranger.error).toBe("SIGN_UP_NOT_INVITED");
    expect([invited.error, invited.description]).toEqual([stranger.error, stranger.description]);
    expect(await userExists(mail("khach", `khac-${run}.test`))).toBe(false);
    expect(await userExists(partner)).toBe(false);
  });

  it("email ngoài ASCII (Kelvin) đúng tên miền đã xác minh: từ chối", async () => {
    const r = await ssoSignIn(`${KELVIN}ate-${run}@${CORP}`);
    expect(r.error).toBe("EMAIL_NOT_ASCII");
    expect(await userExists(mail("kate", CORP))).toBe(false);
  });
});

describe("khai tên miền SSO", () => {
  let other = "";
  const put = (domain: string, org = other) =>
    send(app, "PUT", "/api/v1/sso", {
      cookie: ownerCookie,
      org,
      body: { issuer: idp.issuer, domain, clientId: idp.clientId, clientSecret: idp.clientSecret, join: "member" },
    });
  const body = async (res: Response) => (await res.json()) as { message: string; data?: { code?: string } };

  beforeAll(async () => {
    const res = await send(app, "POST", "/api/v1/orgs", {
      cookie: ownerCookie,
      body: { name: `Tổ chức khác ${run}`, slug: `khac-${run}` },
    });
    expect(res.status).toBe(200);
    other = ((await res.json()) as { id: string }).id;
  });

  it("tên miền đã có tổ chức khác khai (kể cả khác hoa thường): 409 với câu tiếng Việt", async () => {
    const res = await put(CORP.toUpperCase());
    expect(res.status).toBe(409);
    const b = await body(res);
    expect(b.data?.code).toBe("SSO_DOMAIN_TAKEN");
    expect(b.message).toMatch(/đã được một tổ chức khác trên hub khai cho SSO/);
    const { rows } = await admin.query(`select 1 from auth."ssoProvider" where "providerId" = $1`, [`org-${other}`]);
    expect(rows).toHaveLength(0);
  });

  it("tên miền thư công cộng: 400", async () => {
    for (const domain of ["gmail.com", "Outlook.com", "proton.me"]) {
      const res = await put(domain);
      expect(res.status).toBe(400);
      expect((await body(res)).data?.code).toBe("SSO_DOMAIN_PUBLIC");
    }
  });

  it("database cũng chặn trùng tên miền khác hoa thường (unique index trên lower(domain)), hub báo cùng lỗi", async () => {
    const domain = `dua-${run}.test`;
    await admin.query(
      `insert into auth."ssoProvider" (id, issuer, "providerId", domain) values ($1, 'https://idp.example.com', $2, $3)`,
      [randomUUID(), `org-${randomUUID()}`, domain.toUpperCase()],
    );
    const res = await put(domain);
    expect(res.status).toBe(409);
    expect((await body(res)).data?.code).toBe("SSO_DOMAIN_TAKEN");
  });

  it("đổi tên miền thì mất xác minh", async () => {
    expect((await put(`khac-${run}.test`)).status).toBe(200);
    await verifyDomain(true, `org-${other}`);
    const res = await put(`khac-moi-${run}.test`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ provider: { domain: `khac-moi-${run}.test`, domainVerified: false } });
  });
});
