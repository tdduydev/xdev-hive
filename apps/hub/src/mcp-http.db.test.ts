// /mcp theo địa chỉ công khai: http + HIVE_MCP_ALLOW_HTTP chỉ nhận run token, https như cũ. App dựng bằng app.fetch
// (không mở cổng) để đặt được baseURL http khác localhost, nơi mcpEnabled trả false.
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import { seedProject } from "../test/project-fixture.ts";
import { createApp } from "./app.ts";
import { type Auth, createAuth } from "./modules/identity/index.ts";
import { createPool, parseMasterKey } from "./modules/platform/index.ts";
import { createMcpRunTokens, runTokenKey, signRunToken } from "./modules/runs/index.ts";

const { adminUrl, appUrl, authUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const authPool = createPool(authUrl);
const secret = "test-secret-0123456789abcdef-0123456789";
const tag = randomUUID().slice(0, 6);

const HTTP_URL = "http://hive.noi-bo:3000";
const HTTPS_URL = "https://hive.example.com";

let org: OrgFixture & { user: (n: string) => string };
let taskId = "";
let runId = "";

interface Hub {
  auth: Auth;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  runToken: () => string;
  userToken: () => Promise<string>;
}

function hub(baseURL: string, mcpAllowHttp: boolean): Hub {
  const auth = createAuth({ pool: authPool, baseURL, secret, allowEmailSignUp: true });
  const app = createApp({
    config: { port: 0, version: "t", publicUrl: baseURL, mcpAllowHttp },
    auth,
    pool,
    runTokens: createMcpRunTokens({ pool, authSecret: secret, publicUrl: baseURL }),
  });
  return {
    auth,
    fetch: async (path, init) => await app.fetch(new Request(`${baseURL}${path}`, init)),
    runToken: () =>
      signRunToken(runTokenKey(secret), baseURL, { runId, taskId, orgId: org.orgId, attempt: 1, ttlSec: 600 }).token,
    userToken: async () => {
      const { baseURL: issuer } = await auth.$context;
      const api = auth.api as unknown as { signJWT: (o: unknown) => Promise<{ token: string }> };
      const { token } = await api.signJWT({
        body: { payload: { sub: org.user("tmember"), aud: `${baseURL}/mcp`, iss: issuer, scope: "openid" } },
      });
      return token;
    },
  };
}

const listTools = (h: Hub, token?: string) =>
  h.fetch("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

const WELL_KNOWN = ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"];

beforeAll(async () => {
  org = await seedOrg(admin, `mcphttp-${tag}`);
  const { projectId } = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey: parseMasterKey(randomBytes(32).toString("base64")),
    key: `MH${tag}`,
  });
  const task = await admin.query(
    `insert into hive.tasks (org_id, team_id, project_id, number, key, title, body, status, created_by)
     values ($1, $2, $3, 1, $4, 'Task', 'Mô tả', 'running', $5) returning id`,
    [org.orgId, org.teamId, projectId, `MH${tag}-1`, org.user("tmember")],
  );
  taskId = task.rows[0].id as string;
  const run = await admin.query(
    `insert into hive.runs (org_id, team_id, task_id, project_id, state, branch, policy_snapshot, created_by)
     values ($1, $2, $3, $4, 'running', $5, '[]'::jsonb, $6) returning id`,
    [org.orgId, org.teamId, taskId, projectId, `ai/MH${tag}-1`, org.user("tmember")],
  );
  runId = run.rows[0].id as string;
});

afterAll(async () => {
  await Promise.all([admin.end(), pool.end(), authPool.end()]);
});

describe("http, cờ HIVE_MCP_ALLOW_HTTP tắt", () => {
  it("không có /mcp và không có /.well-known, kể cả với run token", async () => {
    const h = hub(HTTP_URL, false);
    expect((await listTools(h, h.runToken())).status).toBe(404);
    for (const path of WELL_KNOWN) expect((await h.fetch(path)).status).toBe(404);
  });
});

describe("http, cờ HIVE_MCP_ALLOW_HTTP bật", () => {
  const h = hub(HTTP_URL, true);

  it("run token gọi được tools/list", async () => {
    const res = await listTools(h, h.runToken());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("task_update");
  });

  it("run token hết hiệu lực (run đã kết thúc) bị 401", async () => {
    const token = h.runToken();
    await admin.query("update hive.runs set state = 'succeeded' where id = $1", [runId]);
    try {
      expect((await listTools(h, token)).status).toBe(401);
    } finally {
      await admin.query("update hive.runs set state = 'running' where id = $1", [runId]);
    }
  });

  it("không token, token rác và token OAuth của người dùng bị 401 kèm thông báo rõ", async () => {
    for (const token of [undefined, "khong-phai-jwt", await h.userToken()]) {
      const res = await listTools(h, token);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("run token");
      // Không có metadata OAuth để trỏ tới, nên không gợi ý client mở luồng đăng nhập.
      expect(res.headers.get("www-authenticate")).not.toContain("resource_metadata");
    }
  });

  it("không có /.well-known", async () => {
    for (const path of WELL_KNOWN) expect((await h.fetch(path)).status).toBe(404);
  });
});

describe("https", () => {
  // Cờ bật hay tắt đều không đổi gì khi đã có https.
  for (const flag of [false, true]) {
    it(`nhận cả run token lẫn token OAuth, có metadata (cờ ${flag ? "bật" : "tắt"})`, async () => {
      const h = hub(HTTPS_URL, flag);
      expect((await listTools(h, h.runToken())).status).toBe(200);
      expect((await listTools(h, await h.userToken())).status).toBe(200);
      const anonymous = await listTools(h);
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get("www-authenticate")).toContain(
        `resource_metadata="${HTTPS_URL}/.well-known/oauth-protected-resource/mcp"`,
      );
      expect((await h.fetch(WELL_KNOWN[0] as string)).status).toBe(200);
    });
  }
});
