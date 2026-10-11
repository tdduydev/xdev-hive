import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type MockIdp, startMockIdp } from "../test/oidc-idp.ts";
import { createApp } from "./app.ts";
import { createAuth } from "./modules/identity/index.ts";
import { createPool } from "./modules/platform/index.ts";
import { authHooks } from "./modules/tenancy/index.ts";

// Xác minh tên miền SSO bằng bản ghi TXT (DNS giả), giành tên miền từ tổ chức chưa xác minh, và định tuyến đăng nhập
// SSO theo tên miền email.

// Database chung với các file test khác: email và tên miền có hậu tố riêng.
const run = randomUUID().slice(0, 8);
const mail = (name: string) => `${name}-${run}@example.com`;
const domainOf = (name: string) => `${name}-${run}.test`;
const PUBLIC_URL = "http://localhost:3000";
const SECRET = "test-secret-0123456789abcdef-0123456789";
const PASSWORD = "mat-khau-du-dai-123";
const OWNER = mail("chu");

const { adminUrl, appUrl, authUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const authPool = createPool(authUrl);
const appPool = createPool(appUrl);
let idp: MockIdp;
type App = ReturnType<typeof createApp>;
let app: App;
let ownerCookie = "";
let memberCookie = "";

/** DNS giả: tên bản ghi → các bản ghi TXT (mỗi bản ghi là mảng chuỗi con, như resolveTxt của Node). */
const dns = new Map<string, string[][]>();
const dnsQueries: string[] = [];
async function resolveTxt(hostname: string): Promise<string[][]> {
  dnsQueries.push(hostname);
  const records = dns.get(hostname);
  if (!records) throw Object.assign(new Error(`queryTxt ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
  return records;
}

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

interface Verification {
  domain: string;
  recordName: string;
  recordValue: string;
  expiresAt: string;
  verified: boolean;
}
interface Settings {
  provider: { domain: string; domainVerified: boolean } | null;
  domainVerification: Verification | null;
}
type ApiResult = { status: number; json: Settings & { message?: string; data?: { code?: string } } };

async function api(
  org: string,
  method: string,
  path: string,
  body?: unknown,
  cookie = ownerCookie,
): Promise<ApiResult> {
  const res = await send(app, method, `/api/v1${path}`, { cookie, org, body });
  return { status: res.status, json: (await res.json()) as ApiResult["json"] };
}

const putSso = (org: string, domain: string) =>
  api(org, "PUT", "/sso", {
    issuer: idp.issuer,
    domain,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    join: "pending",
  });
const requestVerification = (org: string, domain?: string) =>
  api(org, "POST", "/sso/domain-verification", domain ? { domain } : {});
const checkVerification = (org: string) => api(org, "POST", "/sso/domain-verification/check");

async function createOrg(name: string): Promise<string> {
  const res = await send(app, "POST", "/api/v1/orgs", {
    cookie: ownerCookie,
    body: { name: `${name} ${run}`, slug: `${name}-${run}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

/** Đặt bản ghi TXT đúng như hub yêu cầu. */
const publish = (v: Verification) => dns.set(v.recordName, [[v.recordValue]]);

async function providerRow(org: string) {
  const { rows } = await admin.query<{ domain: string; domainVerified: boolean }>(
    `select domain, "domainVerified" from auth."ssoProvider" where "providerId" = $1`,
    [`org-${org}`],
  );
  return rows[0] ?? null;
}

async function auditActions(org: string) {
  const { rows } = await admin.query<{ action: string; data: Record<string, unknown> }>(
    "select action, data from hive.audit_log where org_id = $1 order by created_at",
    [org],
  );
  return rows;
}

const setVerified = (org: string, verified: boolean) =>
  admin.query(`update auth."ssoProvider" set "domainVerified" = $1 where "providerId" = $2`, [verified, `org-${org}`]);

beforeAll(async () => {
  idp = await startMockIdp();
  const auth = createAuth({
    pool: authPool,
    baseURL: PUBLIC_URL,
    secret: SECRET,
    // IdP giả chạy ở 127.0.0.1: plugin SSO chặn host nội bộ trừ khi có trong trustedOrigins.
    trustedOrigins: [PUBLIC_URL, idp.issuer],
    allowEmailSignUp: true,
    hooks: authHooks(appPool),
  });
  app = createApp({
    config: { port: 0, version: "t", publicUrl: PUBLIC_URL, orgCreators: [OWNER] },
    auth,
    pool: appPool,
    resolveTxt,
  });

  const owner = await send(app, "POST", "/api/auth/sign-up/email", {
    body: { name: "Chủ", email: OWNER, password: PASSWORD },
  });
  expect(owner.status).toBe(200);
  ownerCookie = cookieOf(owner);
  const member = await send(app, "POST", "/api/auth/sign-up/email", {
    body: { name: "Thành viên", email: mail("thanh-vien"), password: PASSWORD },
  });
  expect(member.status).toBe(200);
  memberCookie = cookieOf(member);
});

afterAll(async () => {
  await idp.close();
  await Promise.all([admin.end(), authPool.end(), appPool.end()]);
});

describe("xác minh tên miền bằng TXT", () => {
  const DOMAIN = domainOf("xac-minh");
  let org = "";

  beforeAll(async () => {
    org = await createOrg("xac-minh");
    expect((await putSso(org, DOMAIN)).status).toBe(200);
    const { rows } = await admin.query<{ id: string }>(`select id from auth."user" where email = $1`, [
      mail("thanh-vien"),
    ]);
    await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [
      org,
      rows[0]?.id,
    ]);
  });

  it("chỉ quản trị tổ chức lấy và kiểm được bản ghi; chưa đăng nhập thì 401", async () => {
    expect((await api(org, "POST", "/sso/domain-verification", {}, memberCookie)).status).toBe(403);
    expect((await api(org, "POST", "/sso/domain-verification/check", undefined, memberCookie)).status).toBe(403);
    expect((await api(org, "POST", "/sso/domain-verification", {}, "")).status).toBe(401);
    expect(await auditActions(org)).not.toContainEqual(
      expect.objectContaining({ action: "sso.domain_verification_request" }),
    );
  });

  it("lấy bản ghi TXT: tên miền của cấu hình đang lưu, gọi lại thì giữ nguyên bản ghi", async () => {
    const first = await requestVerification(org);
    expect(first.status).toBe(200);
    const v = first.json.domainVerification;
    expect(v).toMatchObject({ domain: DOMAIN, recordName: `_xdev-hive-verification.${DOMAIN}`, verified: false });
    expect(v?.recordValue).toMatch(/^xdev-hive-verification=[\w-]{43}$/);
    expect(new Date(v?.expiresAt ?? 0).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);
    const again = await requestVerification(org);
    expect(again.json.domainVerification).toEqual(v);
    // GET cũng trả bản ghi đang chờ, để trang cài đặt hiện lại sau khi tải lại.
    expect((await api(org, "GET", "/sso")).json.domainVerification).toEqual(v);
  });

  it("hub không lưu mã: dòng trong database không chứa giá trị bản ghi", async () => {
    const v = (await requestVerification(org)).json.domainVerification;
    const token = v?.recordValue.split("=")[1] ?? "";
    const { rows } = await admin.query<{ value: string }>(`select value from auth.verification where identifier = $1`, [
      `hive-sso-domain-verification:org-${org}`,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).not.toContain(token);
  });

  it("chưa có bản ghi trên DNS, hoặc bản ghi sai mã: 400, chưa xác minh", async () => {
    const v = (await requestVerification(org)).json.domainVerification as Verification;
    const missing = await checkVerification(org);
    expect(missing.status).toBe(400);
    expect(missing.json.data?.code).toBe("SSO_VERIFICATION_FAILED");
    expect(missing.json.message).toContain(v.recordValue);
    expect(dnsQueries).toContain(v.recordName);

    dns.set(v.recordName, [["xdev-hive-verification=ma-sai"], ["v=spf1 -all"]]);
    const wrong = await checkVerification(org);
    expect(wrong.status).toBe(400);
    expect(wrong.json.data?.code).toBe("SSO_VERIFICATION_FAILED");
    expect((await providerRow(org))?.domainVerified).toBe(false);
  });

  it("mã của tổ chức khác không xác minh được tên miền cho tổ chức này", async () => {
    const otherOrg = await createOrg("ma-khac");
    const otherDomain = domainOf("ma-khac");
    expect((await putSso(otherOrg, otherDomain)).status).toBe(200);
    const own = (await requestVerification(otherOrg)).json.domainVerification as Verification;
    // Dán bản ghi của tổ chức `org` (cùng tên bản ghi, mã của tổ chức kia) vào DNS của otherDomain.
    const foreign = (await requestVerification(org)).json.domainVerification as Verification;
    dns.set(own.recordName, [[foreign.recordValue]]);
    expect((await checkVerification(otherOrg)).status).toBe(400);
    expect((await providerRow(otherOrg))?.domainVerified).toBe(false);
  });

  it("bản ghi hết hạn: 404, phải lấy bản ghi mới (mã mới)", async () => {
    const old = (await requestVerification(org)).json.domainVerification as Verification;
    publish(old);
    await admin.query(`update auth.verification set "expiresAt" = now() - interval '1 minute' where identifier = $1`, [
      `hive-sso-domain-verification:org-${org}`,
    ]);
    const expired = await checkVerification(org);
    expect(expired.status).toBe(404);
    expect(expired.json.data?.code).toBe("SSO_VERIFICATION_NOT_FOUND");
    expect((await api(org, "GET", "/sso")).json.domainVerification).toBeNull();
    const fresh = (await requestVerification(org)).json.domainVerification as Verification;
    expect(fresh.recordValue).not.toBe(old.recordValue);
    expect((await providerRow(org))?.domainVerified).toBe(false);
  });

  it("bản ghi đúng (TXT chia nhiều chuỗi con, có khoảng trắng): xác minh, xoá bản ghi chờ, ghi audit", async () => {
    const v = (await requestVerification(org)).json.domainVerification as Verification;
    const half = Math.floor(v.recordValue.length / 2);
    dns.set(v.recordName, [["v=spf1 -all"], [` ${v.recordValue.slice(0, half)}`, `${v.recordValue.slice(half)} `]]);
    const res = await checkVerification(org);
    expect(res.status).toBe(200);
    expect(res.json.provider).toMatchObject({ domain: DOMAIN, domainVerified: true });
    expect(res.json.domainVerification).toBeNull();
    expect(await auditActions(org)).toContainEqual({
      action: "sso.domain_verify",
      data: { domain: DOMAIN, applied: true },
    });
  });

  it("đã xác minh: lấy bản ghi nữa thì 409; đổi tên miền thì mất xác minh như cũ", async () => {
    const again = await requestVerification(org);
    expect(again.status).toBe(409);
    expect(again.json.data?.code).toBe("SSO_DOMAIN_ALREADY_VERIFIED");
    const moved = await putSso(org, domainOf("xac-minh-moi"));
    expect(moved.json.provider).toMatchObject({ domainVerified: false });
  });

  it("tên miền thư công cộng và thiếu tên miền: 400", async () => {
    const pub = await requestVerification(org, "gmail.com");
    expect(pub.status).toBe(400);
    expect(pub.json.data?.code).toBe("SSO_DOMAIN_PUBLIC");
    const empty = await createOrg("chua-sso");
    const none = await requestVerification(empty);
    expect(none.status).toBe(400);
    expect(none.json.data?.code).toBe("SSO_DOMAIN_REQUIRED");
    expect((await checkVerification(empty)).json.data?.code).toBe("SSO_VERIFICATION_NOT_FOUND");
  });
});

describe("giành tên miền từ tổ chức chưa xác minh", () => {
  const DOMAIN = domainOf("gianh");
  let squatter = "";
  let owner = "";

  beforeAll(async () => {
    squatter = await createOrg("chiem-cho");
    owner = await createOrg("chu-that");
    expect((await putSso(squatter, DOMAIN)).status).toBe(200);
  });

  it("tổ chức thật xác minh bằng TXT: gỡ khai báo của bên chưa xác minh, ghi audit cả hai bên, lưu thì đã xác minh", async () => {
    const taken = await putSso(owner, DOMAIN);
    expect(taken.status).toBe(409);
    expect(taken.json.data?.code).toBe("SSO_DOMAIN_TAKEN");
    expect(taken.json.message).toMatch(/xác minh bằng bản ghi TXT/);

    const requested = await requestVerification(owner, DOMAIN.toUpperCase());
    expect(requested.status).toBe(200);
    expect(requested.json.provider).toBeNull();
    const v = requested.json.domainVerification as Verification;
    expect(v.domain).toBe(DOMAIN);
    publish(v);

    const checked = await checkVerification(owner);
    expect(checked.status).toBe(200);
    // Chưa có cấu hình SSO để gắn: giữ bằng chứng tới khi lưu cấu hình.
    expect(checked.json.domainVerification).toMatchObject({ domain: DOMAIN, verified: true });
    expect(await providerRow(squatter)).toBeNull();
    expect(await auditActions(owner)).toContainEqual({
      action: "sso.domain_claim",
      data: { domain: DOMAIN, fromOrgId: squatter },
    });
    expect(await auditActions(squatter)).toContainEqual({
      action: "sso.domain_lost",
      data: { domain: DOMAIN, claimedByOrgId: owner },
    });

    const saved = await putSso(owner, DOMAIN);
    expect(saved.status).toBe(200);
    expect(saved.json.provider).toMatchObject({ domain: DOMAIN, domainVerified: true });
    expect(saved.json.domainVerification).toBeNull();
  });

  it("bên chưa xác minh không khai lại được tên miền đã xác minh", async () => {
    const res = await putSso(squatter, DOMAIN);
    expect(res.status).toBe(409);
    expect(res.json.data?.code).toBe("SSO_DOMAIN_TAKEN");
    expect(res.json.message).toMatch(/đã được một tổ chức khác trên hub xác minh/);
    const req = await requestVerification(squatter, DOMAIN);
    expect(req.status).toBe(409);
    expect(req.json.data?.code).toBe("SSO_DOMAIN_TAKEN");
  });

  it("bên chưa xác minh khai lại giữa lúc bên kia đã xác minh mà chưa lưu: lần lưu của bên có bằng chứng vẫn thắng", async () => {
    const domain = domainOf("gianh-lai");
    const fresh = await createOrg("chiem-lai");
    expect((await putSso(fresh, domain)).status).toBe(200);
    const claimant = await createOrg("chu-lai");
    publish((await requestVerification(claimant, domain)).json.domainVerification as Verification);
    expect((await checkVerification(claimant)).status).toBe(200);
    expect(await providerRow(fresh)).toBeNull();
    // Bên chưa xác minh khai lại trước khi bên kia lưu.
    expect((await putSso(fresh, domain)).status).toBe(200);
    const saved = await putSso(claimant, domain);
    expect(saved.status).toBe(200);
    expect(saved.json.provider).toMatchObject({ domain, domainVerified: true });
    expect(await providerRow(fresh)).toBeNull();
    expect(await auditActions(fresh)).toContainEqual(
      expect.objectContaining({ action: "sso.domain_lost", data: { domain, claimedByOrgId: claimant } }),
    );
  });

  it("tổ chức đã có SSO với tên miền khác: kiểm xong thì giành, lưu tên miền mới thì đã xác minh", async () => {
    const domain = domainOf("doi-ten-mien");
    const holder = await createOrg("giu-cu");
    expect((await putSso(holder, domain)).status).toBe(200);
    const mover = await createOrg("doi-sang");
    expect((await putSso(mover, domainOf("ten-mien-cu"))).status).toBe(200);
    publish((await requestVerification(mover, domain)).json.domainVerification as Verification);
    const checked = await checkVerification(mover);
    expect(checked.json.provider).toMatchObject({ domain: domainOf("ten-mien-cu"), domainVerified: false });
    expect(checked.json.domainVerification).toMatchObject({ domain, verified: true });
    expect(await providerRow(holder)).toBeNull();
    expect((await putSso(mover, domain)).json.provider).toMatchObject({ domain, domainVerified: true });
  });
});

describe("định tuyến SSO theo tên miền email", () => {
  /** providerId mà hub chọn: nằm trong redirect_uri của URL authorize. */
  async function routed(body: Record<string, string>): Promise<string | number> {
    const res = await send(app, "POST", "/api/auth/sign-in/sso", {
      body: { callbackURL: "/", errorCallbackURL: "/login", ...body },
    });
    if (res.status !== 200) return res.status;
    const { url } = (await res.json()) as { url: string };
    const redirect = new URL(url).searchParams.get("redirect_uri") ?? "";
    return redirect.split("/sso/callback/")[1] ?? redirect;
  }

  const PARENT = domainOf("dinh-tuyen");
  let parentOrg = "";
  let childOrg = "";
  let unverifiedOrg = "";

  beforeAll(async () => {
    parentOrg = await createOrg("cha");
    childOrg = await createOrg("con");
    unverifiedOrg = await createOrg("chua-xac-minh");
    expect((await putSso(parentOrg, PARENT)).status).toBe(200);
    expect((await putSso(childOrg, `con.${PARENT}`)).status).toBe(200);
    expect((await putSso(unverifiedOrg, domainOf("chua-xm"))).status).toBe(200);
  });

  it("khớp đúng tên miền: dùng nhà cung cấp đó, kể cả chưa xác minh, không phân biệt hoa thường", async () => {
    expect(await routed({ email: `a@${domainOf("chua-xm")}` })).toBe(`org-${unverifiedOrg}`);
    expect(await routed({ domain: domainOf("CHUA-XM").toUpperCase() })).toBe(`org-${unverifiedOrg}`);
  });

  it("tên miền con của nhà cung cấp chưa xác minh: không khớp hậu tố", async () => {
    expect(await routed({ email: `a@sub.${domainOf("chua-xm")}` })).toBe(404);
    expect(await routed({ email: `a@sau.sub.${PARENT}` })).toBe(404);
  });

  it("tên miền cha đã xác minh: nhận tên miền con không có nhà cung cấp riêng", async () => {
    await setVerified(parentOrg, true);
    expect(await routed({ email: `a@sau.sub.${PARENT}` })).toBe(`org-${parentOrg}`);
    expect(await routed({ domain: PARENT })).toBe(`org-${parentOrg}`);
  });

  it("tên miền cha đã xác minh thắng nhà cung cấp chưa xác minh khớp đúng tên miền con", async () => {
    expect(await routed({ email: `a@con.${PARENT}` })).toBe(`org-${parentOrg}`);
  });

  it("khớp đúng và đã xác minh: chỉ dùng nhà cung cấp đó, cả cho tên miền con của nó", async () => {
    await setVerified(childOrg, true);
    expect(await routed({ email: `a@con.${PARENT}` })).toBe(`org-${childOrg}`);
    expect(await routed({ email: `a@x.con.${PARENT}` })).toBe(`org-${childOrg}`);
    expect(await routed({ email: `a@khac.${PARENT}` })).toBe(`org-${parentOrg}`);
  });

  it("gọi thẳng theo providerId thì giữ nguyên", async () => {
    expect(await routed({ providerId: `org-${unverifiedOrg}`, email: `a@con.${PARENT}` })).toBe(`org-${unverifiedOrg}`);
  });
});
