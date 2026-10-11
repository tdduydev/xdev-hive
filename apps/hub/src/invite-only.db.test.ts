import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { type MockIdp, startMockIdp } from "../test/oidc-idp.ts";
import { createApp } from "./app.ts";
import { type AuthOptions, createAuth } from "./modules/identity/index.ts";
import { createPool } from "./modules/platform/index.ts";
import { authHooks } from "./modules/tenancy/index.ts";

// Hub chỉ tạo tài khoản cho người được mời, người quản trị hub (HIVE_ORG_CREATORS) và người vào bằng SSO đúng tên
// miền của tổ chức; quy tắc nằm ở user.validateUserInfo nên áp cho mọi cách đăng nhập.

// Database chung với các file test khác: email có hậu tố riêng để không đụng người dùng của file khác.
const run = randomUUID().slice(0, 8);
const mail = (name: string, domain = "example.com") => `${name}-${run}@${domain}`;
const CORP = `corp-${run}.test`;
const PUBLIC_URL = "http://localhost:3000";
const SECRET = "test-secret-0123456789abcdef-0123456789";
const PASSWORD = "mat-khau-du-dai-123";
const ADMIN = mail("quan-tri");

const { adminUrl, appUrl, authUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const authPool = createPool(authUrl);
const appPool = createPool(appUrl);
let idp: MockIdp;
type App = ReturnType<typeof createApp>;
let app: App;
// Bật HIVE_ALLOW_EMAIL_SIGNUP=1: hành vi cũ cho môi trường dev.
let openApp: App;
let ownerCookie = "";
let orgId = "";

const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

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

async function userExists(email: string) {
  const { rowCount } = await admin.query(`select 1 from auth."user" where email = $1`, [email.toLowerCase()]);
  return rowCount === 1;
}

async function invite(email: string) {
  const res = await send(app, "POST", "/api/v1/invitations", {
    cookie: ownerCookie,
    org: orgId,
    body: { emails: [email] },
  });
  expect(res.status).toBe(200);
  const [inv] = ((await res.json()) as { invitations: { link: string }[] }).invitations;
  return inv?.link.split("/moi/")[1] ?? "";
}

// --- GitHub giả: thay fetch tới github.com và api.github.com, các địa chỉ khác (IdP giả) đi qua như thường. ---

interface GithubUser {
  id: number;
  login: string;
  email: string;
  verified: boolean;
}
let githubNext: GithubUser | undefined;
const githubTokens = new Map<string, GithubUser>();
const realFetch = globalThis.fetch;

function fakeGithubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const json = (body: unknown) => Promise.resolve(Response.json(body));
  if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token") {
    if (!githubNext) return json({ error: "bad_verification_code" });
    const token = randomUUID();
    githubTokens.set(token, githubNext);
    return json({ access_token: token, token_type: "bearer", scope: "read:user,user:email" });
  }
  if (url.origin === "https://api.github.com") {
    const auth = new Headers(input instanceof Request ? input.headers : init?.headers).get("authorization") ?? "";
    const user = githubTokens.get(auth.replace(/^Bearer /i, ""));
    if (!user) return Promise.resolve(Response.json({ message: "Bad credentials" }, { status: 401 }));
    if (url.pathname === "/user") return json({ id: user.id, login: user.login, name: user.login, email: null });
    if (url.pathname === "/user/emails") return json([{ email: user.email, primary: true, verified: user.verified }]);
  }
  return realFetch(input, init);
}

/** Đi hết luồng OAuth của GitHub như trình duyệt; web gửi errorCallbackURL là trang đăng nhập. */
async function githubSignIn(target: App, user: GithubUser) {
  githubNext = user;
  const start = await send(target, "POST", "/api/auth/sign-in/social", {
    body: { provider: "github", callbackURL: "/", errorCallbackURL: "/dang-nhap" },
  });
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state") ?? "";
  const done = await send(target, "GET", `/api/auth/callback/github?code=c-${user.id}&state=${state}`, {
    cookie: cookieOf(start),
  });
  expect(done.status).toBe(302);
  const location = new URL(done.headers.get("location") ?? "", PUBLIC_URL);
  return {
    location,
    error: location.searchParams.get("error"),
    sessionCookie: done.headers.getSetCookie().some((c) => c.includes("session_token=") && !c.includes("Max-Age=0")),
    cookie: cookieOf(done),
  };
}

let nextGithubId = Number.parseInt(run, 16) % 1_000_000_000;
const githubUser = (email: string, verified = true): GithubUser => ({
  id: ++nextGithubId,
  login: email.split("@")[0] ?? "x",
  email,
  verified,
});

/** Luồng OIDC như trình duyệt: hub → IdP authorize → callback của hub. */
async function ssoSignIn(email: string) {
  idp.signInAs({ sub: `sub-${email}`, email, name: email.split("@")[0] ?? email });
  const start = await send(app, "POST", "/api/auth/sign-in/sso", {
    body: { providerId: `org-${orgId}`, callbackURL: "/", errorCallbackURL: "/dang-nhap" },
  });
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const authorize = await fetch(url, { redirect: "manual" });
  const callback = new URL(authorize.headers.get("location") ?? "");
  const done = await send(app, "GET", callback.pathname + callback.search, { cookie: cookieOf(start) });
  expect(done.status).toBe(302);
  const location = new URL(done.headers.get("location") ?? "", PUBLIC_URL);
  return { error: location.searchParams.get("error"), cookie: cookieOf(done) };
}

beforeAll(async () => {
  vi.stubGlobal("fetch", fakeGithubFetch);
  idp = await startMockIdp();
  const opts: AuthOptions = {
    pool: authPool,
    baseURL: PUBLIC_URL,
    secret: SECRET,
    // IdP giả chạy ở 127.0.0.1: plugin SSO chặn host nội bộ trừ khi có trong trustedOrigins.
    trustedOrigins: [PUBLIC_URL, idp.issuer],
    github: { clientId: "gh-client", clientSecret: "gh-secret" },
    orgCreators: [ADMIN],
    hooks: authHooks(appPool),
  };
  // Chủ tổ chức của file này nằm trong danh sách tạo tổ chức của tenancy: database dùng chung nên file khác có thể đã
  // tạo tổ chức đầu tiên. Danh sách của đăng nhập (opts.orgCreators) chỉ có ADMIN.
  const config = { port: 0, version: "t", publicUrl: PUBLIC_URL, orgCreators: [ADMIN, mail("chu")] };
  app = createApp({ config, auth: createAuth({ ...opts, allowEmailSignUp: false }), pool: appPool });
  openApp = createApp({ config, auth: createAuth({ ...opts, allowEmailSignUp: true }), pool: appPool });

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

  it("email trong HIVE_ORG_CREATORS (khác hoa thường): được tạo, có phiên", async () => {
    const res = await signUp(app, ADMIN.toUpperCase());
    expect(res.status).toBe(200);
    expect(cookieOf(res)).toMatch(/session_token=/);
    expect(await userExists(ADMIN)).toBe(true);
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

  it("HIVE_ALLOW_EMAIL_SIGNUP=1: như cũ, ai cũng đăng ký được", async () => {
    expect((await signUp(openApp, mail("tu-do"))).status).toBe(200);
  });
});

describe("GitHub", () => {
  it("người mới không có lời mời: chuyển về trang đăng nhập kèm mã lỗi, không tạo người dùng, không có phiên", async () => {
    const email = mail("gh-la");
    const r = await githubSignIn(app, githubUser(email));
    expect(r.location.pathname).toBe("/dang-nhap");
    expect(r.error).toBe("SIGN_UP_NOT_INVITED");
    expect(r.location.searchParams.get("error_description")).toMatch(/Hub chỉ nhận người được mời/);
    expect(r.sessionCookie).toBe(false);
    expect(await userExists(email)).toBe(false);
  });

  it("có lời mời đúng email: tạo tài khoản rồi nhận lời mời được", async () => {
    const email = mail("gh-moi");
    const token = await invite(email);
    const user = githubUser(email);
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

  it("có lời mời nhưng email trên GitHub chưa xác minh: từ chối", async () => {
    const email = mail("gh-chua-xac-minh");
    await invite(email);
    const r = await githubSignIn(app, githubUser(email, false));
    expect(r.error).toBe("SIGN_UP_EMAIL_UNVERIFIED");
    expect(await userExists(email)).toBe(false);
  });

  it("lời mời của email khác thì không tính", async () => {
    await invite(mail("gh-nguoi-khac"));
    const r = await githubSignIn(app, githubUser(mail("gh-khong-phai")));
    expect(r.error).toBe("SIGN_UP_NOT_INVITED");
  });

  it("lời mời hết hạn thì không tính", async () => {
    const email = mail("gh-het-han");
    await invite(email);
    await admin.query("update hive.invitations set expires_at = now() - interval '1 minute' where email = $1", [email]);
    const r = await githubSignIn(app, githubUser(email));
    expect(r.error).toBe("SIGN_UP_NOT_INVITED");
    expect(await userExists(email)).toBe(false);
  });

  it("email trong HIVE_ORG_CREATORS: được tạo", async () => {
    // Người quản trị khác cũng có thể vào bằng GitHub; dùng app riêng để danh sách khác ADMIN đã đăng ký ở trên.
    const email = mail("quan-tri-gh");
    const gh = createApp({
      config: { port: 0, version: "t", publicUrl: PUBLIC_URL },
      auth: createAuth({
        pool: authPool,
        baseURL: PUBLIC_URL,
        secret: SECRET,
        github: { clientId: "gh-client", clientSecret: "gh-secret" },
        orgCreators: [email],
        hooks: authHooks(appPool),
      }),
      pool: appPool,
    });
    const r = await githubSignIn(gh, githubUser(email));
    expect(r.error).toBeNull();
    expect(await userExists(email)).toBe(true);
  });

  it("người đã có tài khoản (không còn lời mời nào): đăng nhập bình thường", async () => {
    const email = mail("gh-cu");
    const user = githubUser(email);
    expect((await githubSignIn(openApp, user)).error).toBeNull();
    const r = await githubSignIn(app, user);
    expect(r.error).toBeNull();
    expect(r.sessionCookie).toBe(true);
    const me = await send(app, "GET", "/api/v1/me", { cookie: r.cookie });
    expect(await me.json()).toMatchObject({ email });
  });

  it("HIVE_ALLOW_EMAIL_SIGNUP=1: như cũ, người mới vào thẳng", async () => {
    const email = mail("gh-tu-do");
    const r = await githubSignIn(openApp, githubUser(email));
    expect(r.error).toBeNull();
    expect(await userExists(email)).toBe(true);
  });
});

describe("SSO của tổ chức", () => {
  it("email đúng tên miền đã khai: được tạo, vào tổ chức theo chính sách sso_join", async () => {
    const email = mail("nhan-vien", CORP);
    const r = await ssoSignIn(email);
    expect(r.error).toBeNull();
    const { rows } = await admin.query(
      `select m.status from hive.org_members m join auth."user" u on u.id = m.user_id where m.org_id = $1 and u.email = $2`,
      [orgId, email],
    );
    expect(rows).toEqual([{ status: "pending" }]);
  });

  it("email khác tên miền, không có lời mời: từ chối, không tạo người dùng", async () => {
    const email = mail("khach", `khac-${run}.test`);
    const r = await ssoSignIn(email);
    expect(r.error).toBe("SIGN_UP_NOT_INVITED");
    expect(await userExists(email)).toBe(false);
  });

  it("email khác tên miền dù có lời mời: từ chối, người đó vào bằng link mời hoặc GitHub/GitLab", async () => {
    // Plugin SSO không tin email_verified của IdP, mà IdP của một tổ chức phát được email bất kỳ: tin nó thì tổ chức
    // này chiếm trước được tài khoản của người ngoài tên miền mình.
    const email = mail("doi-tac", `khac-${run}.test`);
    await invite(email);
    const r = await ssoSignIn(email);
    expect(r.error).toBe("SIGN_UP_EMAIL_UNVERIFIED");
    expect(await userExists(email)).toBe(false);
  });
});
