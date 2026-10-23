// Router fleet đòi tư cách thành viên tổ chức trước mọi handler (spec 034 FR-091, rbac-review R4): RLS chỉ cắt theo
// tổ chức ghi trong header, ai đăng nhập cũng đặt được header đó.
import { randomUUID } from "node:crypto";
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
const tag = randomUUID().slice(0, 8);
let org: OrgFixture;
let app: ReturnType<typeof createApp>;
let outsider = "";
let member = "";

async function signUp(name: string): Promise<{ cookie: string; userId: string }> {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email: `${name}-${tag}@example.com`, password: "test-password-0123456789" }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { cookie, userId: ((await res.json()) as { user: { id: string } }).user.id };
}

beforeAll(async () => {
  org = await seedOrg(admin, `fleetrbac-${tag}`);
  const auth = createAuth({
    pool: authPool,
    baseURL: "http://localhost:3000",
    secret: "test-secret-0123456789abcdef-0123456789",
    allowEmailSignUp: true,
  });
  app = createApp({ config: { port: 0, version: "test" }, auth, pool });
  outsider = (await signUp("outsider")).cookie;
  const joined = await signUp("member");
  member = joined.cookie;
  await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [
    org.orgId,
    joined.userId,
  ]);
});

afterAll(async () => {
  await Promise.all([admin.end(), pool.end(), authPool.end()]);
});

const get = (path: string, cookie: string) =>
  app.request(`/api${path}`, { headers: { cookie, "x-hive-org": org.orgId } });

describe("router fleet kiểm thành viên tổ chức", () => {
  it("người ngoài tổ chức đặt header tổ chức thì bị chặn trước handler", async () => {
    for (const path of [`/v1/teams/${org.teamId}/machines`, "/v1/desktop/connect/options"]) {
      const res = await get(path, outsider);
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { data?: { code?: string } }).data?.code, path).toBe("NOT_ORG_MEMBER");
    }
  });

  it("thành viên tổ chức đi tiếp tới kiểm quyền đội của handler", async () => {
    const options = await get("/v1/desktop/connect/options", member);
    expect(options.status, await options.clone().text()).toBe(200);
    // Không có vai trò trong đội: handler từ chối bằng lỗi quyền đội, không phải lỗi thành viên tổ chức.
    const machines = await get(`/v1/teams/${org.teamId}/machines`, member);
    expect(machines.status).toBe(403);
    expect(((await machines.json()) as { data?: { code?: string } }).data?.code).not.toBe("NOT_ORG_MEMBER");
  });
});
