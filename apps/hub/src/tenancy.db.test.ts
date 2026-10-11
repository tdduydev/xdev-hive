import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { freshDatabase } from "../test/seed.ts";
import { createApp } from "./app.ts";
import { createAuth } from "./modules/identity/index.ts";
import { createPool } from "./modules/platform/index.ts";

// Database riêng: quy tắc "chỉ người đầu tiên tạo được tổ chức" cần hub chưa có tổ chức nào.
const pools: pg.Pool[] = [];
let admin: pg.Pool;
let app: ReturnType<typeof createApp>;

interface Caller {
  id: string;
  cookie: string;
}
const users: Record<string, Caller> = {};
let orgA = "";
let orgB = "";
let teamPay = "";
let teamCrm = "";
let systemId = "";

beforeAll(async () => {
  const db = await freshDatabase(inject("db"));
  admin = new pg.Pool({ connectionString: db.adminUrl });
  const authPool = createPool(db.authUrl);
  const appPool = createPool(db.appUrl);
  pools.push(admin, authPool, appPool);
  const auth = createAuth({
    pool: authPool,
    baseURL: "http://localhost:3000",
    secret: "test-secret-0123456789abcdef-0123456789",
    allowEmailSignUp: true,
  });
  app = createApp({
    config: { port: 0, version: "t", orgCreators: ["creator@example.com"] },
    auth,
    pool: appPool,
  });
  for (const name of ["owner", "admin", "tadmin", "member", "viewer", "outsider", "late", "creator"]) {
    const res = await call("POST", "/api/auth/sign-up/email", {
      body: { name: `Người ${name}`, email: `${name}@example.com`, password: "mat-khau-du-dai-123" },
    });
    expect(res.status).toBe(200);
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    users[name] = { id: ((await res.json()) as { user: { id: string } }).user.id, cookie };
  }
});

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});

function call(
  method: string,
  path: string,
  opts: { as?: Caller | undefined; body?: unknown; org?: string | undefined } = {},
): Promise<Response> | Response {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.as) headers.cookie = opts.as.cookie;
  if (opts.org) headers["x-hive-org"] = opts.org;
  return app.request(path, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

/** Gọi API của hub với tư cách một người dùng; mặc định trong tổ chức A, null là không gửi header tổ chức. */
async function api(who: string, method: string, path: string, body?: unknown, org: string | null = orgA) {
  const res = await call(method, `/api/v1${path}`, { as: users[who], body, org: org ?? undefined });
  const json = (await res.json()) as Record<string, unknown> & { message?: string; data?: { code?: string } };
  return { status: res.status, json };
}

async function addToOrg(org: string, who: string, role: "owner" | "admin" | "member", status = "active") {
  await admin.query("insert into hive.org_members (org_id, user_id, role, status) values ($1, $2, $3, $4)", [
    org,
    users[who]?.id,
    role,
    status,
  ]);
}

async function auditActions(org: string): Promise<string[]> {
  const { rows } = await admin.query<{ action: string }>(
    "select action from hive.audit_log where org_id = $1 order by created_at, action",
    [org],
  );
  return rows.map((r) => r.action);
}

describe("tạo tổ chức", () => {
  it("chưa đăng nhập thì 401", async () => {
    expect((await call("GET", "/api/v1/orgs/mine")).status).toBe(401);
    expect((await call("POST", "/api/v1/orgs", { body: { name: "X", slug: "xx" } })).status).toBe(401);
  });

  it("hub trống: ai đăng nhập cũng được tạo tổ chức đầu tiên", async () => {
    const mine = await api("owner", "GET", "/orgs/mine");
    expect(mine.json).toEqual({ orgs: [], canCreateOrg: true });
  });

  it("định danh sai quy tắc bị từ chối bằng thông báo tiếng Việt", async () => {
    for (const slug of ["A", "Thanh_Toan", "-abc", "abc-", "a".repeat(41)]) {
      const res = await api("owner", "POST", "/orgs", { name: "FPT", slug });
      expect(res.status, slug).toBe(400);
      expect(res.json.message).toMatch(/Định danh|Dữ liệu không hợp lệ/);
    }
  });

  it("người đầu tiên tạo tổ chức và thành chủ sở hữu", async () => {
    const res = await api("owner", "POST", "/orgs", {
      name: "FPT Software xDev",
      slug: "fpt-xdev",
      emailDomain: "example.com",
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      name: "FPT Software xDev",
      slug: "fpt-xdev",
      emailDomain: "example.com",
      role: "owner",
    });
    orgA = res.json.id as string;
    const mine = await api("owner", "GET", "/orgs/mine");
    expect(mine.json).toMatchObject({ orgs: [{ id: orgA, role: "owner" }] });
    expect(await auditActions(orgA)).toEqual(["org.create"]);
  });

  it("lần sau người khác bị chặn", async () => {
    const res = await api("late", "POST", "/orgs", { name: "Khác", slug: "khac" }, null);
    expect(res.status).toBe(403);
    expect(res.json.data?.code).toBe("ORG_CREATE_NOT_ALLOWED");
    expect(res.json.message).toMatch(/lời mời/);
    expect((await api("late", "GET", "/orgs/mine")).json).toEqual({ orgs: [], canCreateOrg: false });
  });

  it("người trong HIVE_ORG_CREATORS vẫn tạo thêm được", async () => {
    expect((await api("creator", "GET", "/orgs/mine")).json).toMatchObject({ canCreateOrg: true });
    const res = await api("creator", "POST", "/orgs", { name: "Tổ chức B", slug: "to-chuc-b" }, null);
    expect(res.status).toBe(200);
    orgB = res.json.id as string;
  });

  it("trùng định danh trả CONFLICT nêu rõ định danh", async () => {
    const res = await api("creator", "POST", "/orgs", { name: "Trùng", slug: "fpt-xdev" }, null);
    expect(res.status).toBe(409);
    expect(res.json.message).toContain('"fpt-xdev"');
    expect(res.json.data?.code).toBe("SLUG_TAKEN");
  });
});

describe("chọn tổ chức", () => {
  beforeAll(async () => {
    await addToOrg(orgA, "admin", "admin");
    await addToOrg(orgA, "tadmin", "member");
    await addToOrg(orgA, "member", "member");
    await addToOrg(orgA, "viewer", "member");
  });

  it("thiếu header tổ chức thì 400", async () => {
    const res = await api("owner", "GET", "/teams", undefined, null);
    expect(res.status).toBe(400);
    expect(res.json.message).toMatch(/Chưa chọn tổ chức/);
  });

  it("không thấy tổ chức mình không thuộc", async () => {
    expect((await api("owner", "GET", `/orgs/${orgB}`)).status).toBe(403);
    expect((await api("owner", "GET", "/teams", undefined, orgB)).status).toBe(403);
    expect((await api("outsider", "GET", "/teams")).status).toBe(403);
    const mine = await api("owner", "GET", "/orgs/mine");
    expect((mine.json.orgs as { id: string }[]).map((o) => o.id)).toEqual([orgA]);
  });

  it("orgs.get trả vai trò của người gọi", async () => {
    expect((await api("admin", "GET", `/orgs/${orgA}`)).json).toMatchObject({ id: orgA, role: "admin" });
  });

  it("orgs.update cần quản trị trở lên", async () => {
    expect((await api("member", "PATCH", `/orgs/${orgA}`, { name: "Đổi" })).status).toBe(403);
    const res = await api("admin", "PATCH", `/orgs/${orgA}`, { name: "FPT xDev" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ name: "FPT xDev", slug: "fpt-xdev" });
  });
});

describe("đội", () => {
  it("chỉ quản trị tổ chức tạo được đội", async () => {
    const denied = await api("member", "POST", "/teams", { name: "X", slug: "x-team" });
    expect(denied.status).toBe(403);
    expect(denied.json.data?.code).toBe("ORG_ROLE_REQUIRED");
    const res = await api("admin", "POST", "/teams", {
      name: "Thanh toán",
      slug: "thanh-toan",
      color: "#7B61FF",
      adminUserId: users.tadmin?.id,
    });
    expect(res.status).toBe(200);
    teamPay = res.json.id as string;
    teamCrm = (await api("owner", "POST", "/teams", { name: "CRM", slug: "crm" })).json.id as string;
  });

  it("adminUserId phải là thành viên tổ chức", async () => {
    const res = await api("admin", "POST", "/teams", { name: "Y", slug: "y-team", adminUserId: users.outsider?.id });
    expect(res.status).toBe(404);
    // Lỗi xảy ra sau khi đã ghi đội: cả transaction phải rollback.
    const { rows } = await admin.query("select 1 from hive.teams where slug = 'y-team'");
    expect(rows).toHaveLength(0);
  });

  it("trùng định danh đội trong tổ chức thì 409", async () => {
    const res = await api("admin", "POST", "/teams", { name: "Lại", slug: "thanh-toan" });
    expect(res.status).toBe(409);
    expect(res.json.message).toContain('"thanh-toan"');
  });

  it("định danh đội trùng với tổ chức khác thì không sao", async () => {
    expect((await api("creator", "POST", "/teams", { name: "TT", slug: "thanh-toan" }, orgB)).status).toBe(200);
  });

  it("quản trị đội sửa được đội của mình, thành viên thường thì không", async () => {
    expect((await api("member", "PATCH", `/teams/${teamPay}`, { color: "#000000" })).status).toBe(403);
    expect((await api("tadmin", "PATCH", `/teams/${teamCrm}`, { color: "#000000" })).status).toBe(403);
    const res = await api("tadmin", "PATCH", `/teams/${teamPay}`, { color: "#112233" });
    expect(res.json).toMatchObject({ id: teamPay, color: "#112233" });
  });

  it("đội của tổ chức khác coi như không có", async () => {
    const teamB = (await api("creator", "GET", "/teams", undefined, orgB)).json as unknown as { id: string }[];
    const res = await api("owner", "PATCH", `/teams/${teamB[0]?.id}`, { name: "Bị sửa" });
    expect(res.status).toBe(404);
  });
});

describe("thành viên đội", () => {
  it("quản trị đội thêm người; người thường không thêm được", async () => {
    const add = (who: string, userId: string | undefined, role: string) =>
      api(who, "POST", `/teams/${teamPay}/members`, { userId, role });
    expect((await add("member", users.viewer?.id, "viewer")).status).toBe(403);
    const ok = await add("tadmin", users.member?.id, "member");
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ userId: users.member?.id, role: "member", email: "member@example.com" });
    expect((await add("tadmin", users.viewer?.id, "viewer")).status).toBe(200);
    expect((await add("tadmin", users.member?.id, "admin")).status).toBe(409);
    expect((await add("tadmin", users.outsider?.id, "member")).status).toBe(404);
  });

  it("người xem được xem danh sách; người ngoài đội thì không", async () => {
    const res = await api("viewer", "GET", `/teams/${teamPay}/members`);
    expect(res.status).toBe(200);
    expect((res.json as unknown as { email: string }[]).map((m) => m.email).sort()).toEqual([
      "member@example.com",
      "tadmin@example.com",
      "viewer@example.com",
    ]);
    expect((await api("member", "GET", `/teams/${teamCrm}/members`)).status).toBe(403);
  });

  it("đổi vai trò và gỡ khỏi đội cần quản trị đội", async () => {
    const path = `/teams/${teamPay}/members/${users.viewer?.id}`;
    expect((await api("member", "PATCH", path, { role: "admin" })).status).toBe(403);
    expect((await api("tadmin", "PATCH", path, { role: "member" })).json).toMatchObject({ role: "member" });
    expect((await api("tadmin", "PATCH", path, { role: "viewer" })).json).toMatchObject({ role: "viewer" });
    expect((await api("member", "DELETE", `/teams/${teamPay}/members/${users.tadmin?.id}`)).status).toBe(403);
    expect((await api("tadmin", "DELETE", `/teams/${teamCrm}/members/${users.member?.id}`)).status).toBe(403);
    expect((await api("owner", "DELETE", `/teams/${teamCrm}/members/${users.member?.id}`)).status).toBe(404);
  });
});

describe("hệ thống", () => {
  it("quản trị đội thêm hệ thống; thành viên, người xem thì không", async () => {
    const body = { teamId: teamPay, name: "Cổng thanh toán", slug: "payment-gateway", description: "Cổng" };
    expect((await api("member", "POST", "/systems", body)).status).toBe(403);
    expect((await api("viewer", "POST", "/systems", body)).status).toBe(403);
    const res = await api("tadmin", "POST", "/systems", body);
    expect(res.status).toBe(200);
    systemId = res.json.id as string;
    expect((await api("tadmin", "POST", "/systems", body)).status).toBe(409);
    // Cùng định danh nhưng khác đội thì được.
    expect((await api("owner", "POST", "/systems", { ...body, teamId: teamCrm })).status).toBe(200);
  });

  it("thành viên tổ chức xem được, lọc theo đội", async () => {
    const all = await api("viewer", "GET", "/systems");
    expect(all.json).toHaveLength(2);
    const pay = await api("viewer", "GET", `/systems?teamId=${teamPay}`);
    expect((pay.json as unknown as { id: string }[]).map((s) => s.id)).toEqual([systemId]);
  });

  it("sửa, xoá cần quản trị đội sở hữu hệ thống", async () => {
    expect((await api("member", "PATCH", `/systems/${systemId}`, { name: "X" })).status).toBe(403);
    expect((await api("tadmin", "PATCH", `/systems/${systemId}`, { name: "Cổng TT" })).json).toMatchObject({
      name: "Cổng TT",
    });
    const crm = (await api("owner", "GET", `/systems?teamId=${teamCrm}`)).json as unknown as { id: string }[];
    expect((await api("tadmin", "DELETE", `/systems/${crm[0]?.id}`)).status).toBe(403);
    expect((await api("owner", "DELETE", `/systems/${crm[0]?.id}`)).status).toBe(200);
  });

  it("danh sách đội kèm số hệ thống và số người", async () => {
    const res = await api("member", "GET", "/teams");
    const teams = res.json as unknown as { id: string; systemCount: number; memberCount: number }[];
    expect(teams.find((t) => t.id === teamPay)).toMatchObject({ systemCount: 1, memberCount: 3 });
    expect(teams.find((t) => t.id === teamCrm)).toMatchObject({ systemCount: 0, memberCount: 0 });
  });
});

describe("thành viên tổ chức", () => {
  it("danh sách kèm tên, email, vai trò, đội", async () => {
    const res = await api("member", "GET", "/members");
    expect(res.status).toBe(200);
    const list = res.json as unknown as { userId: string; name: string; email: string; teams: { teamId: string }[] }[];
    expect(list).toHaveLength(5);
    expect(list.find((m) => m.userId === users.tadmin?.id)).toMatchObject({
      name: "Người tadmin",
      email: "tadmin@example.com",
      role: "member",
      status: "active",
      teams: [{ teamId: teamPay, name: "Thanh toán", role: "admin" }],
    });
  });

  it("chỉ chủ sở hữu đổi được vai trò tổ chức", async () => {
    expect((await api("admin", "PATCH", `/members/${users.member?.id}/role`, { role: "admin" })).status).toBe(403);
    const res = await api("owner", "PATCH", `/members/${users.member?.id}/role`, { role: "admin" });
    expect(res.json).toMatchObject({ role: "admin", status: "active" });
    await api("owner", "PATCH", `/members/${users.member?.id}/role`, { role: "member" });
  });

  it("không hạ được chủ sở hữu cuối cùng", async () => {
    const res = await api("owner", "PATCH", `/members/${users.owner?.id}/role`, { role: "admin" });
    expect(res.status).toBe(409);
    expect(res.json.data?.code).toBe("LAST_OWNER");
    expect((await api("owner", "GET", `/orgs/${orgA}`)).json).toMatchObject({ role: "owner" });
  });

  it("có chủ sở hữu khác thì tự hạ được", async () => {
    await api("owner", "PATCH", `/members/${users.admin?.id}/role`, { role: "owner" });
    expect((await api("owner", "PATCH", `/members/${users.owner?.id}/role`, { role: "admin" })).status).toBe(200);
    expect((await api("admin", "PATCH", `/members/${users.owner?.id}/role`, { role: "owner" })).status).toBe(200);
    expect((await api("owner", "PATCH", `/members/${users.admin?.id}/role`, { role: "admin" })).status).toBe(200);
  });

  it("quản trị khoá được thành viên; người bị khoá mất quyền", async () => {
    expect((await api("member", "PATCH", `/members/${users.viewer?.id}/status`, { status: "blocked" })).status).toBe(
      403,
    );
    const res = await api("admin", "PATCH", `/members/${users.viewer?.id}/status`, { status: "blocked" });
    expect(res.json).toMatchObject({ status: "blocked" });
    expect((await api("viewer", "GET", "/teams")).status).toBe(403);
    expect((await api("viewer", "GET", "/orgs/mine")).json).toMatchObject({ orgs: [] });
    expect((await api("admin", "PATCH", `/members/${users.viewer?.id}/status`, { status: "active" })).status).toBe(200);
    expect((await api("viewer", "GET", "/teams")).status).toBe(200);
  });

  it("quản trị không khoá được chủ sở hữu, không tự khoá mình", async () => {
    expect((await api("admin", "PATCH", `/members/${users.owner?.id}/status`, { status: "blocked" })).status).toBe(403);
    expect((await api("owner", "PATCH", `/members/${users.owner?.id}/status`, { status: "blocked" })).status).toBe(403);
  });

  it("duyệt người đang chờ", async () => {
    await addToOrg(orgA, "late", "member", "pending");
    expect((await api("late", "GET", "/teams")).status).toBe(403);
    expect((await api("admin", "PATCH", `/members/${users.late?.id}/status`, { status: "active" })).status).toBe(200);
    expect((await api("late", "GET", "/teams")).status).toBe(200);
  });

  it("người không thuộc tổ chức thì 404", async () => {
    expect((await api("owner", "PATCH", `/members/${users.outsider?.id}/role`, { role: "admin" })).status).toBe(404);
  });
});

describe("xoá đội", () => {
  it("chỉ chủ sở hữu, kéo theo hệ thống và thành viên đội", async () => {
    expect((await api("admin", "DELETE", `/teams/${teamPay}`)).status).toBe(403);
    expect((await api("tadmin", "DELETE", `/teams/${teamPay}`)).status).toBe(403);
    expect((await api("owner", "DELETE", `/teams/${teamPay}`)).status).toBe(200);
    expect((await api("owner", "GET", "/systems")).json).toEqual([]);
    expect((await api("owner", "DELETE", `/teams/${teamPay}`)).status).toBe(404);
  });
});

describe("audit", () => {
  it("mọi thao tác ghi thành công đều có nhật ký, thao tác bị từ chối thì không", async () => {
    const actions = await auditActions(orgA);
    for (const a of [
      "org.create",
      "org.update",
      "team.create",
      "team.update",
      "team.delete",
      "team_member.add",
      "team_member.set_role",
      "system.create",
      "system.update",
      "system.delete",
      "org_member.set_role",
      "org_member.set_status",
    ])
      expect(actions, a).toContain(a);
    // Hai đội tạo thành công ở A; lần tạo bị rollback (adminUserId sai) và lần trùng định danh không để lại dòng.
    expect(actions.filter((a) => a === "team.create")).toHaveLength(2);
  });

  it("người làm là người gọi API", async () => {
    const { rows } = await admin.query(
      "select actor_user_id from hive.audit_log where org_id = $1 and action = 'team.delete'",
      [orgA],
    );
    expect(rows).toEqual([{ actor_user_id: users.owner?.id }]);
  });

  it("nhật ký nằm đúng tổ chức", async () => {
    expect(await auditActions(orgB)).toEqual(["org.create", "team.create"]);
  });
});

describe("RPC", () => {
  it("lỗi phân quyền đi qua /rpc cũng là FORBIDDEN có mã", async () => {
    const res = await app.request("/rpc/teams/create", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: users.member?.cookie ?? "", "x-hive-org": orgA },
      body: JSON.stringify({ json: { name: "Z", slug: "zz" } }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      json: { code: "FORBIDDEN", defined: true, data: { code: "ORG_ROLE_REQUIRED" } },
    });
  });
});
