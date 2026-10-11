import { randomBytes, randomUUID } from "node:crypto";
import type { NotificationChannelCreateInput } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type MockIdp, startMockIdp } from "../test/oidc-idp.ts";
import { createApp } from "./app.ts";
import { createAuth } from "./modules/identity/index.ts";
import { createChannel, notify } from "./modules/notify/index.ts";
import { createPool, parseMasterKey, withTenant } from "./modules/platform/index.ts";
import { authHooks } from "./modules/tenancy/index.ts";

// Database chung với các file test khác: email có hậu tố riêng để không đụng người dùng của file khác.
const run = randomUUID().slice(0, 8);
const mail = (name: string, domain = "example.com") => `${name}-${run}@${domain}`;
const CORP = `corp-${run}.test`;
const PUBLIC_URL = "http://localhost:3000";
const SECRET = "test-secret-0123456789abcdef-0123456789";
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));

const { adminUrl, appUrl, authUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const authPool = createPool(authUrl);
const appPool = createPool(appUrl);
let idp: MockIdp;
let app: ReturnType<typeof createApp>;
// Cùng database và secret với `app` nên phiên dùng chung được; chỉ để tạo sẵn người dùng khi đăng ký tự do đã tắt.
let openApp: ReturnType<typeof createApp>;

interface Caller {
  id: string;
  email: string;
  cookie: string;
}
const users: Record<string, Caller> = {};
let orgId = "";
let teamId = "";
let pendingChannelId = "";

const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

function send(
  target: ReturnType<typeof createApp>,
  method: string,
  path: string,
  opts: { cookie?: string | undefined; body?: unknown; org?: string | undefined } = {},
) {
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

/** Gọi API hub với tư cách một người (hoặc ẩn danh khi who rỗng), mặc định trong tổ chức đang test. */
async function api(who: string, method: string, path: string, body?: unknown, org: string | null = orgId) {
  const res = await send(app, method, `/api/v1${path}`, {
    cookie: users[who]?.cookie,
    body,
    org: org ?? undefined,
  });
  const json = (await res.json()) as Record<string, unknown> & { message?: string; data?: { code?: string } };
  return { status: res.status, json };
}

async function signUp(target: ReturnType<typeof createApp>, key: string, email: string, extra: object = {}) {
  const res = await send(target, "POST", "/api/auth/sign-up/email", {
    body: { name: `Người ${key}`, email, password: "mat-khau-du-dai-123", ...extra },
  });
  if (res.status === 200) {
    const { user } = (await res.json()) as { user: { id: string } };
    users[key] = { id: user.id, email, cookie: cookieOf(res) };
  }
  return res;
}

async function membership(userId: string) {
  const { rows } = await admin.query<{ role: string; status: string }>(
    "select role, status from hive.org_members where org_id = $1 and user_id = $2",
    [orgId, userId],
  );
  return rows[0];
}

const tokenOf = (link: string) => link.split("/moi/")[1] ?? "";

beforeAll(async () => {
  idp = await startMockIdp();
  const opts = {
    pool: authPool,
    baseURL: PUBLIC_URL,
    secret: SECRET,
    // IdP giả chạy ở 127.0.0.1: plugin SSO chặn host nội bộ trừ khi có trong trustedOrigins (cách dùng cho IdP
    // nội bộ của công ty).
    trustedOrigins: [PUBLIC_URL, idp.issuer],
    hooks: authHooks(appPool, {
      onMemberPending: (tx, member) =>
        notify(tx, {
          orgId: member.orgId,
          event: "member.pending",
          title: `${member.email} chờ duyệt vào tổ chức`,
          body: `${member.name} (${member.email}) vừa đăng nhập bằng SSO. Hãy xem và duyệt thành viên đang chờ.`,
          link: `${PUBLIC_URL}/quan-tri/thanh-vien`,
        }),
    }),
  };
  const config = { port: 0, version: "t", publicUrl: PUBLIC_URL, orgCreators: [mail("owner")] };
  app = createApp({ config, auth: createAuth({ ...opts, allowEmailSignUp: false }), pool: appPool });
  openApp = createApp({ config, auth: createAuth({ ...opts, allowEmailSignUp: true }), pool: appPool });

  for (const key of ["owner", "admin", "member", "other"])
    expect((await signUp(openApp, key, mail(key))).status).toBe(200);
  const org = await api("owner", "POST", "/orgs", { name: `Tổ chức ${run}`, slug: `org-${run}` }, null);
  expect(org.status).toBe(200);
  orgId = org.json.id as string;
  await admin.query(
    "insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'admin'), ($1, $3, 'member')",
    [orgId, users.admin?.id, users.member?.id],
  );
  const team = await api("admin", "POST", "/teams", { name: "Thanh toán", slug: "thanh-toan" });
  teamId = team.json.id as string;
  const channel = await withTenant(appPool, { userId: users.admin?.id ?? "", orgId }, (tx) =>
    createChannel(tx, masterKey, users.admin?.id ?? "", {
      name: `sso-${run}`,
      events: ["member.pending"],
      config: { kind: "telegram", botToken: "123456:ABCdefGhIJKlmnOPQrstUVwxyz0123456789", chatId: "-100" },
    } as NotificationChannelCreateInput),
  );
  pendingChannelId = channel.id;
});

afterAll(async () => {
  await idp.close();
  await Promise.all([admin.end(), authPool.end(), appPool.end()]);
});

describe("tạo và quản lý lời mời", () => {
  it("chỉ quản trị tổ chức được mời", async () => {
    const res = await api("member", "POST", "/invitations", { emails: [mail("x")] });
    expect(res.status).toBe(403);
    expect(res.json.data?.code).toBe("ORG_ROLE_REQUIRED");
  });

  it("tạo nhiều lời mời, link chứa mã chỉ trả một lần, database chỉ giữ bản băm", async () => {
    const res = await api("admin", "POST", "/invitations", {
      emails: [mail("ha"), mail("minh")],
      orgRole: "member",
      teamId,
      teamRole: "viewer",
    });
    expect(res.status).toBe(200);
    const created = res.json.invitations as { id: string; email: string; link: string; expiresAt: string }[];
    expect(created.map((c) => c.email)).toEqual([mail("ha"), mail("minh")]);
    for (const c of created) {
      expect(c.link).toMatch(new RegExp(`^${PUBLIC_URL}/moi/[A-Za-z0-9_-]{43}$`));
      const days = (Date.parse(c.expiresAt) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThanOrEqual(7);
    }
    const { rows } = await admin.query<{ token_hash: string }>(
      "select token_hash from hive.invitations where id = $1",
      [created[0]?.id],
    );
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.token_hash).not.toBe(tokenOf(created[0]?.link ?? ""));

    const list = await api("admin", "GET", "/invitations");
    expect(list.status).toBe(200);
    const mine = (list.json as unknown as { email: string; status: string; teamName: string }[]).filter((i) =>
      [mail("ha"), mail("minh")].includes(i.email),
    );
    expect(mine).toHaveLength(2);
    expect(mine.every((i) => i.status === "pending" && i.teamName === "Thanh toán")).toBe(true);
    // Danh sách không bao giờ lộ mã hay bản băm.
    expect(JSON.stringify(list.json)).not.toContain(rows[0]?.token_hash);
  });

  it("mời làm quản trị cần chủ sở hữu", async () => {
    const res = await api("admin", "POST", "/invitations", { emails: [mail("sep")], orgRole: "admin" });
    expect(res.status).toBe(403);
    expect(res.json.message).toMatch(/chủ sở hữu/);
  });

  it("đội của tổ chức khác hay không tồn tại thì từ chối", async () => {
    const res = await api("admin", "POST", "/invitations", { emails: [mail("y")], teamId: randomUUID() });
    expect(res.status).toBe(404);
  });

  it("thu hồi: link không dùng được nữa", async () => {
    const res = await api("admin", "POST", "/invitations", { emails: [mail("revoke")] });
    const [inv] = res.json.invitations as { id: string; link: string }[];
    expect((await api("member", "DELETE", `/invitations/${inv?.id}`)).status).toBe(403);
    expect((await api("admin", "DELETE", `/invitations/${inv?.id}`)).status).toBe(200);
    const preview = await api("", "POST", "/invitations/preview", { token: tokenOf(inv?.link ?? "") }, null);
    expect(preview.status).toBe(404);
    expect(preview.json.data?.code).toBe("INVITE_NOT_FOUND");
  });
});

describe("xem và nhận lời mời", () => {
  let token = "";
  let invitedEmail = "";

  beforeAll(async () => {
    // Chữ hoa trong email mời: so khớp không phân biệt hoa thường.
    invitedEmail = mail("Lan").replace("Lan", "LAN");
    const res = await api("owner", "POST", "/invitations", {
      emails: [invitedEmail],
      orgRole: "admin",
      teamId,
      teamRole: "member",
    });
    token = tokenOf((res.json.invitations as { link: string }[])[0]?.link ?? "");
    expect((await signUp(openApp, "lan", invitedEmail.toLowerCase())).status).toBe(200);
  });

  it("xem trước không cần đăng nhập: tên tổ chức, email, còn hạn", async () => {
    const res = await api("", "POST", "/invitations/preview", { token }, null);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ orgName: `Tổ chức ${run}`, email: invitedEmail.toLowerCase(), status: "pending" });
  });

  it("mã sai bị từ chối", async () => {
    const wrong = "A".repeat(43);
    expect((await api("", "POST", "/invitations/preview", { token: wrong }, null)).status).toBe(404);
    expect((await api("lan", "POST", "/invitations/accept", { token: wrong }, null)).status).toBe(404);
  });

  it("nhận lời mời cần đăng nhập", async () => {
    expect((await api("", "POST", "/invitations/accept", { token }, null)).status).toBe(401);
  });

  it("sai email bị từ chối, lời mời vẫn còn dùng được", async () => {
    const res = await api("other", "POST", "/invitations/accept", { token }, null);
    expect(res.status).toBe(403);
    expect(res.json.data?.code).toBe("INVITE_EMAIL_MISMATCH");
    expect(res.json.message).toContain(invitedEmail.toLowerCase());
    expect(await membership(users.other?.id ?? "")).toBeUndefined();
  });

  it("đúng email (khác hoa thường): vào tổ chức với vai trò mời, vào đội, lời mời đánh dấu đã dùng", async () => {
    const res = await api("lan", "POST", "/invitations/accept", { token }, null);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ id: orgId, role: "admin" });
    expect(await membership(users.lan?.id ?? "")).toEqual({ role: "admin", status: "active" });
    const team = await admin.query("select role from hive.team_members where team_id = $1 and user_id = $2", [
      teamId,
      users.lan?.id,
    ]);
    expect(team.rows).toEqual([{ role: "member" }]);
    const mine = await api("lan", "GET", "/orgs/mine", undefined, null);
    expect((mine.json.orgs as { id: string }[]).map((o) => o.id)).toContain(orgId);
    const { rows } = await admin.query(
      "select accepted_by from hive.invitations where org_id = $1 and email = $2 and accepted_at is not null",
      [orgId, invitedEmail.toLowerCase()],
    );
    expect(rows).toEqual([{ accepted_by: users.lan?.id }]);
    const audit = await admin.query("select 1 from hive.audit_log where org_id = $1 and action = 'invitation.accept'", [
      orgId,
    ]);
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  it("đã dùng thì không dùng lại được", async () => {
    const res = await api("lan", "POST", "/invitations/accept", { token }, null);
    expect(res.status).toBe(409);
    expect(res.json.data?.code).toBe("INVITE_USED");
    expect((await api("", "POST", "/invitations/preview", { token }, null)).json.status).toBe("accepted");
  });

  it("hết hạn thì bị từ chối", async () => {
    const res = await api("admin", "POST", "/invitations", { emails: [users.other?.email] });
    const expired = tokenOf((res.json.invitations as { link: string }[])[0]?.link ?? "");
    await admin.query(
      "update hive.invitations set expires_at = now() - interval '1 minute' where org_id = $1 and email = $2",
      [orgId, users.other?.email],
    );
    expect((await api("", "POST", "/invitations/preview", { token: expired }, null)).json.status).toBe("expired");
    const accept = await api("other", "POST", "/invitations/accept", { token: expired }, null);
    expect(accept.status).toBe(409);
    expect(accept.json.data?.code).toBe("INVITE_EXPIRED");
    expect(await membership(users.other?.id ?? "")).toBeUndefined();
  });
});

describe("đăng ký bằng mã mời khi đăng ký tự do đã tắt", () => {
  let token = "";
  const email = mail("moi");

  beforeAll(async () => {
    const res = await api("admin", "POST", "/invitations", { emails: [email], teamId });
    token = tokenOf((res.json.invitations as { link: string }[])[0]?.link ?? "");
  });

  it("không có mã thì không đăng ký được", async () => {
    const res = await signUp(app, "x1", mail("tu-do"));
    expect(res.status).toBe(403);
  });

  it("mã đúng nhưng khác email thì không đăng ký được", async () => {
    const res = await signUp(app, "x2", mail("khac"), { inviteToken: token });
    expect(res.status).toBe(403);
    const { rows } = await admin.query(`select 1 from auth."user" where email = $1`, [mail("khac")]);
    expect(rows).toHaveLength(0);
  });

  it("mã sai thì không đăng ký được", async () => {
    expect((await signUp(app, "x3", email, { inviteToken: "B".repeat(43) })).status).toBe(403);
  });

  it("mã hợp lệ đúng email: tạo tài khoản và tự nhận lời mời", async () => {
    const res = await signUp(app, "moi", email.toUpperCase(), { inviteToken: token });
    expect(res.status).toBe(200);
    expect(await membership(users.moi?.id ?? "")).toEqual({ role: "member", status: "active" });
    const mine = await api("moi", "GET", "/orgs/mine", undefined, null);
    expect((mine.json.orgs as { id: string }[]).map((o) => o.id)).toEqual([orgId]);
    expect((await api("", "POST", "/invitations/preview", { token }, null)).json.status).toBe("accepted");
  });
});

/** Đi hết luồng OIDC như trình duyệt: hub → IdP authorize → callback của hub. Trả cookie phiên. */
async function ssoSignIn(email: string, pick: object = { email }): Promise<{ cookie: string; location: string }> {
  idp.signInAs({ sub: `sub-${email}`, email, name: email.split("@")[0] ?? email });
  const start = await send(app, "POST", "/api/auth/sign-in/sso", { body: { ...pick, callbackURL: "/" } });
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  expect(url.startsWith(`${idp.issuer}/authorize`)).toBe(true);
  const authorize = await fetch(url, { redirect: "manual" });
  expect(authorize.status).toBe(302);
  const callback = new URL(authorize.headers.get("location") ?? "");
  expect(callback.origin + callback.pathname).toBe(`${PUBLIC_URL}/api/auth/sso/callback/org-${orgId}`);
  const done = await send(app, "GET", callback.pathname + callback.search, { cookie: cookieOf(start) });
  expect(done.status).toBe(302);
  return { cookie: cookieOf(done), location: done.headers.get("location") ?? "" };
}

async function userIdOf(cookie: string) {
  const me = await send(app, "GET", "/api/v1/me", { cookie });
  expect(me.status).toBe(200);
  return ((await me.json()) as { id: string }).id;
}

describe("SSO (OIDC) theo tổ chức", () => {
  const ssoBody = () => ({
    issuer: idp.issuer,
    domain: CORP,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    join: "pending",
  });

  it("API quản lý nhà cung cấp của Better Auth bị tắt, chỉ đi qua hub", async () => {
    const res = await send(app, "POST", "/api/auth/sso/register", {
      cookie: users.admin?.cookie,
      body: { providerId: "x", issuer: idp.issuer, domain: CORP, oidcConfig: { clientId: "a", clientSecret: "b" } },
    });
    expect(res.status).toBe(404);
  });

  it("chưa cấu hình: vẫn có callback URL để dán sang nhà cung cấp", async () => {
    expect((await api("member", "GET", "/sso")).status).toBe(403);
    const res = await api("admin", "GET", "/sso");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      providerId: `org-${orgId}`,
      callbackUrl: `${PUBLIC_URL}/api/auth/sso/callback/org-${orgId}`,
      join: "pending",
      provider: null,
    });
  });

  it("lần đầu phải có client secret", async () => {
    const { clientSecret: _, ...noSecret } = ssoBody();
    const res = await api("admin", "PUT", "/sso", noSecret);
    expect(res.status).toBe(400);
    expect(res.json.data?.code).toBe("SSO_SECRET_REQUIRED");
  });

  it("issuer không đọc được discovery thì báo lỗi tiếng Việt", async () => {
    const res = await api("admin", "PUT", "/sso", { ...ssoBody(), issuer: `${idp.issuer}/khong-co` });
    expect(res.status).toBe(400);
    expect(res.json.message).toMatch(/Không đọc được cấu hình OIDC/);
  });

  it("thành viên thường không cấu hình được", async () => {
    expect((await api("member", "PUT", "/sso", ssoBody())).status).toBe(403);
  });

  it("quản trị lưu cấu hình; secret không bao giờ trả về", async () => {
    const res = await api("admin", "PUT", "/sso", ssoBody());
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      join: "pending",
      provider: { issuer: idp.issuer, domain: CORP, clientIdLastFour: idp.clientId.slice(-4) },
    });
    expect(JSON.stringify(res.json)).not.toContain(idp.clientSecret);
  });

  it("người mới đăng nhập SSO, chính sách chờ duyệt: vào org_members ở trạng thái pending", async () => {
    const { cookie, location } = await ssoSignIn(mail("khoa", CORP));
    expect(location).toBe("/");
    const id = await userIdOf(cookie);
    users.khoa = { id, email: mail("khoa", CORP), cookie };
    expect(await membership(id)).toEqual({ role: "member", status: "pending" });
    expect(await pendingNotifications()).toBe(1);
    // Đang chờ thì chưa vào được tổ chức.
    expect((await api("khoa", "GET", "/teams")).status).toBe(403);
    expect((await api("khoa", "GET", "/orgs/mine", undefined, null)).json.orgs).toEqual([]);
  });

  it("đăng nhập SSO lần nữa không đổi trạng thái", async () => {
    await ssoSignIn(mail("khoa", CORP));
    expect(await membership(users.khoa?.id ?? "")).toEqual({ role: "member", status: "pending" });
    expect(await pendingNotifications()).toBe(1);
  });

  it("quản trị duyệt người đang chờ", async () => {
    expect((await api("member", "POST", `/members/${users.khoa?.id}/approve`)).status).toBe(403);
    const res = await api("admin", "POST", `/members/${users.khoa?.id}/approve`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "active", role: "member" });
    expect((await api("khoa", "GET", "/teams")).status).toBe(200);
    // Chỉ duyệt được người đang chờ.
    const again = await api("admin", "POST", `/members/${users.khoa?.id}/approve`);
    expect(again.status).toBe(409);
    expect(again.json.data?.code).toBe("MEMBER_NOT_PENDING");
  });

  it("từ chối thì bị khoá, đăng nhập SSO lại vẫn bị khoá", async () => {
    const { cookie } = await ssoSignIn(mail("tu-choi", CORP));
    const id = await userIdOf(cookie);
    expect(await membership(id)).toEqual({ role: "member", status: "pending" });
    const res = await api("admin", "POST", `/members/${id}/deny`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "blocked" });
    await ssoSignIn(mail("tu-choi", CORP));
    expect(await membership(id)).toEqual({ role: "member", status: "blocked" });
  });

  it("email khác tên miền đã khai, không có lời mời: không tạo tài khoản", async () => {
    // Plugin tìm nhà cung cấp theo tên miền của email, nên email lạ phải chọn nhà cung cấp bằng providerId.
    const { cookie, location } = await ssoSignIn(mail("khach", `khac-${run}.test`), { providerId: `org-${orgId}` });
    expect(location).toMatch(/[?&]error=SIGN_UP_NOT_INVITED/);
    expect(cookie).not.toMatch(/session_token=/);
    const { rows } = await admin.query(`select 1 from auth."user" where email = $1`, [
      mail("khach", `khac-${run}.test`),
    ]);
    expect(rows).toHaveLength(0);
  });

  it("đổi chính sách sang thành viên (giữ secret cũ): người mới vào thẳng, trạng thái active", async () => {
    const { clientSecret: _, ...noSecret } = ssoBody();
    const res = await api("owner", "PUT", "/sso", { ...noSecret, join: "member" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ join: "member", provider: { issuer: idp.issuer } });
    // Secret cũ vẫn dùng được: luồng đăng nhập bên dưới phải đổi được code lấy token.
    const notificationsBefore = await pendingNotifications();
    const { cookie } = await ssoSignIn(mail("binh", CORP));
    const id = await userIdOf(cookie);
    expect(await membership(id)).toEqual({ role: "member", status: "active" });
    expect(await pendingNotifications()).toBe(notificationsBefore);
    expect((await api("", "GET", "/orgs/mine", undefined, null)).status).toBe(401);
  });

  it("đã có người đăng nhập thì không đổi được issuer", async () => {
    const res = await api("admin", "PUT", "/sso", { ...ssoBody(), issuer: "https://login.example.com" });
    expect(res.status).toBe(409);
    expect(res.json.data?.code).toBe("SSO_HAS_ACCOUNTS");
  });

  it("gỡ SSO: còn callback URL, không còn nhà cung cấp; ghi audit", async () => {
    const res = await api("admin", "DELETE", "/sso");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ provider: null, providerId: `org-${orgId}` });
    expect((await api("admin", "DELETE", "/sso")).status).toBe(404);
    const { rows } = await admin.query<{ action: string }>(
      "select action from hive.audit_log where org_id = $1 and action like 'sso.%' order by created_at",
      [orgId],
    );
    expect(rows.map((r) => r.action)).toEqual(["sso.update", "sso.update", "sso.remove"]);
  });
});

async function pendingNotifications() {
  const { rows } = await admin.query<{ count: string }>(
    "select count(*) from hive.notifications where org_id = $1 and channel_id = $2 and event = 'member.pending'",
    [orgId, pendingChannelId],
  );
  return Number(rows[0]?.count ?? 0);
}
