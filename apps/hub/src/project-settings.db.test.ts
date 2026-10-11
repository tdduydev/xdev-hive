import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedProject } from "../test/project-fixture.ts";
import { createApp } from "./app.ts";
import { createAuth } from "./modules/identity/index.ts";
import { createPool, parseMasterKey } from "./modules/platform/index.ts";

// Kiểm lớp API của projects.updateSettings qua HTTP (OpenAPI): route theo project key nằm cạnh route theo id, khoá
// lạ thành 400, thiếu quyền thành 403 kèm mã. Nghiệp vụ chi tiết nằm ở modules/catalog/settings.db.test.ts.
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
const key = `ps-api-${suffix}`;

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
  for (const name of ["owner", "tmember"]) {
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
    `ps-api-${suffix}`,
    ids.owner,
  ]);
  for (const [n, role] of [
    ["owner", "owner"],
    ["tmember", "member"],
  ] as const)
    await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, $3)", [
      orgId,
      ids[n],
      role,
    ]);
  const teamId = (
    await admin.query("insert into hive.teams (org_id, slug, name) values ($1, 'nen-tang', 'Nền tảng') returning id", [
      orgId,
    ])
  ).rows[0].id as string;
  await admin.query("insert into hive.team_members (team_id, org_id, user_id, role) values ($1, $2, $3, 'member')", [
    teamId,
    orgId,
    ids.tmember,
  ]);
  const systemId = (
    await admin.query(
      "insert into hive.systems (org_id, team_id, slug, name) values ($1, $2, 'cong', 'Cổng') returning id",
      [orgId, teamId],
    )
  ).rows[0].id as string;
  await seedProject(admin, appPool, {
    orgId,
    teamId,
    systemId,
    adminUserId: ids.owner as string,
    masterKey: parseMasterKey(randomBytes(32).toString("base64")),
    key,
  });
});

afterAll(async () => {
  await Promise.all([admin.end(), authPool.end(), appPool.end()]);
});

describe("API projects.updateSettings", () => {
  it("bật merge queue theo project key, trả settings sau khi đổi", async () => {
    const res = await api("owner", "PATCH", `/projects/${key}/settings`, {
      settings: { features: { mergeQueue: true }, merge: { mode: "auto" } },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ features: { mergeQueue: true }, merge: { mode: "auto" } });
  });

  it("khoá lạ thành 400 và nêu trường sai", async () => {
    const res = await api("owner", "PATCH", `/projects/${key}/settings`, {
      settings: { features: { mergeQueu: true } },
    });
    expect(res.status).toBe(400);
    expect(String(res.json.message)).toContain("features");
  });

  it("thành viên đội nhận 403 TEAM_ROLE_REQUIRED", async () => {
    const res = await api("tmember", "PATCH", `/projects/${key}/settings`, {
      settings: { features: { sandbox: true } },
    });
    expect([res.status, res.json.data?.code]).toEqual([403, "TEAM_ROLE_REQUIRED"]);
  });
});
