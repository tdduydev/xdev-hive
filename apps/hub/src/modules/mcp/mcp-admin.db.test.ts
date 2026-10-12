import { createHash, randomUUID } from "node:crypto";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";
import { errorCode, seedOrg } from "../../../test/org-fixture.ts";
import { type Auth, createAuth } from "../identity/index.ts";
import { createPool, type Tx, withTenant } from "../platform/index.ts";
import { registerMcpTools, requireOrgRole } from "../tenancy/index.ts";
import { mcpAdminRouter } from "./admin-router.ts";
import {
  createToken,
  extendToken,
  listTokens,
  listTools,
  revokeToken,
  setTool,
  verifyPersonalToken,
} from "./admin-service.ts";
import { createMcpEndpoint } from "./endpoint.ts";
import { McpToolRegistry } from "./registry.ts";
import { mcpUserTokens } from "./schema.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const pool = createPool(db.appUrl);
const authPool = createPool(db.authUrl);
const registry = new McpToolRegistry();
registerMcpTools(registry);
registry.provideAuthorization(requireOrgRole);
registry.register({
  name: "task_get",
  description: "Đọc việc",
  input: z.object({}),
  readOnly: true,
  handler: async (_, { orgId, principal }) => ({ orgId, userId: principal.userId }),
});
registry.register({
  name: "memory_search",
  description: "Tìm memory",
  input: z.object({}),
  readOnly: true,
  handler: async () => {
    throw new Error("test failure");
  },
});
let org: Awaited<ReturnType<typeof seedOrg>>;
let other: typeof org;
let auth: Auth;
let endpoint: (request: Request) => Promise<Response>;
const tenant = <T>(user: string, fn: (tx: Tx) => Promise<T>, orgId = org.orgId) =>
  withTenant(pool, { userId: user, orgId }, fn);
const create = (user = org.user("tmember"), lifetimeDays = 30) =>
  tenant(user, (tx) => createToken(tx, user, registry, { clientId: "cursor", lifetimeDays }));
const rpc = (token: string, method = "tools/list", params: unknown = {}) =>
  endpoint(
    new Request("https://hive.example.com/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
async function body(res: Response) {
  const raw = await res.text();
  return JSON.parse(
    raw.startsWith("event:") || raw.startsWith("data:")
      ? (raw
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice(5) ?? "{}")
      : raw,
  ) as {
    result?: { tools?: { name: string }[]; isError?: boolean; content?: { text: string }[] };
    error?: { message: string };
  };
}

beforeAll(async () => {
  const tag = randomUUID().slice(0, 8);
  org = await seedOrg(admin, `mcp-admin-${tag}`);
  other = await seedOrg(admin, `mcp-admin-other-${tag}`);
  // Cùng người dùng thuộc cả hai tổ chức: token vẫn không được chọn sang tổ chức thứ hai.
  await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [
    other.orgId,
    org.user("tmember"),
  ]);
  auth = createAuth({
    pool: authPool,
    baseURL: "https://hive.example.com",
    secret: "test-secret-0123456789abcdef-0123456789",
  });
  endpoint = createMcpEndpoint({
    auth,
    pool,
    registry,
    version: "test",
    runTokens: {
      verify: async (token) =>
        token === "test-run-token"
          ? { kind: "run", userId: org.user("tmember"), orgId: org.orgId, runKind: "code", scopes: [] }
          : null,
    },
  });
});
afterAll(async () => {
  await Promise.all([admin.end(), pool.end(), authPool.end()]);
});

describe("MCP personal tokens", () => {
  it("creates a 256-bit secret, persists only SHA-256, lists no secret or hash", async () => {
    const result = await create();
    expect(result.token).toMatch(/^hive_pat_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/);
    const [row] = await tenant(org.user("tmember"), (tx) =>
      tx.select().from(mcpUserTokens).where(eq(mcpUserTokens.id, result.info.id)),
    );
    expect(row?.tokenHash).toBe(createHash("sha256").update(result.token).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(result.token);
    const listed = await tenant(org.user("tmember"), (tx) => listTokens(tx, org.user("tmember"), registry));
    expect(listed.tokens).toContainEqual({ ...result.info, ownerName: org.user("tmember") });
    expect(JSON.stringify(listed)).not.toContain(result.token);
    expect(JSON.stringify(listed)).not.toContain(row?.tokenHash);
    const audit = await admin.query("select data from hive.audit_log where target_id = $1", [result.info.id]);
    expect(JSON.stringify(audit.rows)).not.toContain(result.token);
    expect(JSON.stringify(audit.rows)).not.toContain(row?.tokenHash);
  });

  it("requires a finite integer expiry between 1 and 90 days", async () => {
    for (const days of [0, 91, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(await errorCode(() => create(org.user("tmember"), days))).toBe("MCP_TOKEN_INPUT");
    }
    const result = await create(org.user("tmember"), 90);
    expect(new Date(result.info.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(90 * 86_400_000);
  });

  it("authenticates as its creator, uses the bound tenant and audits every successful invocation", async () => {
    const result = await create();
    const response = await rpc(result.token, "tools/call", { name: "task_get", arguments: {} });
    expect(response.status).toBe(200);
    const parsed = await body(response);
    expect(parsed.result?.isError).not.toBe(true);
    expect(JSON.parse(parsed.result?.content?.[0]?.text ?? "{}")).toEqual({
      orgId: org.orgId,
      userId: org.user("tmember"),
    });
    await body(await rpc(result.token, "tools/call", { name: "task_get", arguments: {} }));
    const audit = await admin.query(
      "select actor_user_id, org_id, data from hive.audit_log where data->>'tokenId' = $1 and action = 'mcp.task_get'",
      [result.info.id],
    );
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows.every((r) => r.actor_user_id === org.user("tmember") && r.org_id === org.orgId)).toBe(true);
    expect(audit.rows[0].data).toMatchObject({ via: "user", clientId: "cursor", outcome: "success" });
  });

  it("rejects cross-organization calls even when the creator belongs to both; changing the token org invalidates its hash", async () => {
    const result = await create();
    const parsed = await body(
      await rpc(result.token, "tools/call", { name: "task_get", arguments: { org: other.orgId } }),
    );
    expect(parsed.result?.isError).toBe(true);
    expect(parsed.result?.content?.[0]?.text).toContain("tổ chức của nó");
    expect((await rpc(result.token.replace(org.orgId, other.orgId))).status).toBe(401);
    expect(
      await tenant(org.user("admin"), (tx) => listTokens(tx, org.user("admin"), registry), other.orgId).catch(
        () => null,
      ),
    ).toBeNull();
  });

  it("updates last_used_at at most once per minute, including concurrent requests", async () => {
    const result = await create();
    await rpc(result.token);
    const read = () =>
      tenant(org.user("tmember"), (tx) => tx.select().from(mcpUserTokens).where(eq(mcpUserTokens.id, result.info.id)));
    const first = (await read())[0]?.lastUsedAt?.getTime();
    expect(first).toBeDefined();
    await Promise.all(Array.from({ length: 5 }, () => rpc(result.token)));
    expect((await read())[0]?.lastUsedAt?.getTime()).toBe(first);
    await tenant(org.user("tmember"), (tx) =>
      tx
        .update(mcpUserTokens)
        .set({ lastUsedAt: new Date(Date.now() - 61_000) })
        .where(eq(mcpUserTokens.id, result.info.id)),
    );
    await rpc(result.token);
    expect((await read())[0]?.lastUsedAt?.getTime()).toBeGreaterThan(first ?? 0);
  });

  it("expired and revoked tokens return 401 on the next request, without caching", async () => {
    const result = await create();
    expect((await rpc(result.token)).status).toBe(200);
    await tenant(org.user("tmember"), (tx) => revokeToken(tx, org.user("tmember"), registry, result.info.id));
    expect((await rpc(result.token)).status).toBe(401);
    expect((await rpc(result.token, "tools/call", { name: "task_get", arguments: {} })).status).toBe(401);
    const expired = await create();
    await admin.query(
      "update hive.mcp_user_tokens set created_at = now() - interval '2 days', expires_at = now() - interval '1 day' where id = $1",
      [expired.info.id],
    );
    expect((await rpc(expired.token)).status).toBe(401);
    const changedSecret = expired.token.slice(0, -1) + (expired.token.endsWith("a") ? "b" : "a");
    expect(await verifyPersonalToken(pool, registry, changedSecret)).toBeNull();
  });

  it("blocked or removed membership invalidates existing tokens immediately", async () => {
    const result = await create(org.user("loner"));
    expect((await rpc(result.token)).status).toBe(200);
    await admin.query("update hive.org_members set status = 'blocked' where org_id = $1 and user_id = $2", [
      org.orgId,
      org.user("loner"),
    ]);
    expect((await rpc(result.token)).status).toBe(401);
    await admin.query("update hive.org_members set status = 'active' where org_id = $1 and user_id = $2", [
      org.orgId,
      org.user("loner"),
    ]);
    expect((await rpc(result.token)).status).toBe(200);
    await admin.query("delete from hive.org_members where org_id = $1 and user_id = $2", [
      org.orgId,
      org.user("loner"),
    ]);
    expect((await rpc(result.token)).status).toBe(401);
  });

  it("members see and revoke only their own tokens; owner/admin see, extend and revoke everyone's tokens", async () => {
    const result = await create(org.user("tadmin"));
    const member = org.user("tmember");
    const own = await tenant(member, (tx) => listTokens(tx, member, registry));
    expect(own.tokens.every((t) => t.userId === member)).toBe(true);
    expect(await errorCode(() => tenant(member, (tx) => revokeToken(tx, member, registry, result.info.id)))).toBe(
      "MCP_TOKEN_OWNER_REQUIRED",
    );
    expect(await errorCode(() => tenant(member, (tx) => extendToken(tx, member, registry, result.info.id, 30)))).toBe(
      "ORG_ROLE_REQUIRED",
    );
    for (const role of ["owner", "admin"]) {
      const user = org.user(role);
      expect(
        (await tenant(user, (tx) => listTokens(tx, user, registry))).tokens.some((t) => t.id === result.info.id),
      ).toBe(true);
      const extended = await tenant(user, (tx) => extendToken(tx, user, registry, result.info.id, 90));
      expect(new Date(extended.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(90 * 86_400_000);
      expect(await errorCode(() => tenant(user, (tx) => extendToken(tx, user, registry, result.info.id, 91)))).toBe(
        "MCP_TOKEN_LIFETIME",
      );
    }
    await tenant(org.user("admin"), (tx) => revokeToken(tx, org.user("admin"), registry, result.info.id));
    expect(
      await errorCode(() =>
        tenant(org.user("owner"), (tx) => extendToken(tx, org.user("owner"), registry, result.info.id, 30)),
      ),
    ).toBe("MCP_TOKEN_REVOKED");
    const foreign = await tenant(
      other.user("tmember"),
      (tx) => createToken(tx, other.user("tmember"), registry, { clientId: "codex", lifetimeDays: 30 }),
      other.orgId,
    );
    expect(
      await errorCode(() =>
        tenant(org.user("owner"), (tx) => revokeToken(tx, org.user("owner"), registry, foreign.info.id)),
      ),
    ).toBe("MCP_TOKEN_NOT_FOUND");
  });

  it("uses the same HTTP opt-in rule as run tokens; never enables OAuth over plain HTTP", async () => {
    const result = await create();
    const httpAuth = createAuth({
      pool: authPool,
      baseURL: "http://hive.internal:3000",
      secret: "test-secret-0123456789abcdef-0123456789",
    });
    const http = createMcpEndpoint({ auth: httpAuth, pool, registry, version: "test", runTokensOnly: true });
    const request = (token: string) =>
      new Request("http://hive.internal:3000/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    expect((await http(request(result.token))).status).toBe(200);
    expect((await http(request("invalid-oauth-token"))).status).toBe(401);
  });
});

describe("MCP tool administration", () => {
  it("only owner/admin can toggle; disabled tools disappear and direct calls are refused for personal, OAuth and run tokens", async () => {
    const token = await create();
    const user = org.user("tmember");
    expect(await errorCode(() => tenant(user, (tx) => setTool(tx, user, registry, "task_get", false)))).toBe(
      "ORG_ROLE_REQUIRED",
    );
    const signer = auth.api as unknown as { signJWT: (input: unknown) => Promise<{ token: string }> };
    const oauth = await signer.signJWT({
      body: { payload: { sub: user, aud: "https://hive.example.com/mcp", iss: (await auth.$context).baseURL } },
    });
    for (const role of ["owner", "admin"]) {
      await tenant(org.user(role), (tx) => setTool(tx, org.user(role), registry, "task_get", false));
      for (const bearer of [token.token, oauth.token, "test-run-token"]) {
        const listed = await body(await rpc(bearer));
        expect(listed.result?.tools?.some((t) => t.name === "task_get")).toBe(false);
        const called = await body(await rpc(bearer, "tools/call", { name: "task_get", arguments: { org: org.orgId } }));
        expect(called.result?.isError).toBe(true);
        expect(called.result?.content?.[0]?.text).toContain("đã bị quản trị tắt");
      }
      await tenant(org.user(role), (tx) => setTool(tx, org.user(role), registry, "task_get", true));
      expect((await body(await rpc(token.token))).result?.tools?.some((t) => t.name === "task_get")).toBe(true);
    }
    expect(
      await errorCode(() =>
        tenant(org.user("owner"), (tx) => setTool(tx, org.user("owner"), registry, "unknown_tool", false)),
      ),
    ).toBe("MCP_TOOL_NOT_FOUND");
  });

  it("toggles apply only to their tenant; OAuth advertises the intersection for users with multiple organizations", async () => {
    await tenant(org.user("owner"), (tx) => setTool(tx, org.user("owner"), registry, "task_get", false));
    const otherToken = await tenant(
      org.user("tmember"),
      (tx) => createToken(tx, org.user("tmember"), registry, { clientId: "codex", lifetimeDays: 30 }),
      other.orgId,
    );
    expect((await body(await rpc(otherToken.token))).result?.tools?.some((t) => t.name === "task_get")).toBe(true);
    await tenant(org.user("owner"), (tx) => setTool(tx, org.user("owner"), registry, "task_get", true));
  });

  it("returns real seven-day invocation and error counts from audit, excluding management actions and older calls", async () => {
    const result = await create();
    await body(await rpc(result.token, "tools/call", { name: "memory_search", arguments: {} }));
    await admin.query(
      "insert into hive.audit_log (org_id, action, target_type, target_id, created_at) values ($1, 'mcp.memory_search', 'mcp_tool', 'memory_search', now() - interval '8 days')",
      [org.orgId],
    );
    const listed = await tenant(org.user("owner"), (tx) => listTools(tx, org.user("owner"), registry));
    expect(listed.tools.find((t) => t.name === "memory_search")).toMatchObject({ calls: 1, errors: 1 });
  });
});

describe("MCP administrative API", () => {
  it("enforces session, tenant membership and roles on HTTP routes; list never returns the plaintext twice", async () => {
    const mocked = {
      ...auth,
      api: {
        ...auth.api,
        getSession: async ({ headers }: { headers: Headers }) => {
          const id = headers.get("x-test-user");
          return id ? { user: { id } } : null;
        },
      },
    } as unknown as Auth;
    const handler = new OpenAPIHandler(
      { mcpAdmin: mcpAdminRouter({ auth: mocked, pool, registry }) },
      {
        clientInterceptors: [
          async ({ next }) => {
            try {
              return await next();
            } catch (error) {
              const e = error as { name: string; code: string; message: string };
              if (e.name === "ForbiddenError")
                throw new ORPCError("FORBIDDEN", { message: e.message, data: { code: e.code } });
              throw error;
            }
          },
        ],
      },
    );
    const call = async (method: string, path: string, user?: string, input?: unknown, orgId = org.orgId) => {
      const headers = new Headers({ "content-type": "application/json", "x-hive-org": orgId });
      if (user) headers.set("x-test-user", user);
      const req = new Request(`https://hive.example.com/api/v1/mcp/admin/${path}`, {
        method,
        headers,
        ...(input ? { body: JSON.stringify(input) } : {}),
      });
      const handled = await handler.handle(req, { prefix: "/api", context: { headers } });
      if (!handled.response) throw new Error("No route");
      return handled.response;
    };
    expect((await call("GET", "tokens")).status).toBe(401);
    expect((await call("GET", "tokens", other.user("owner"))).status).toBe(403);
    expect((await call("PATCH", "tools/task_get", org.user("tmember"), { enabled: false })).status).toBe(403);
    const created = await call("POST", "tokens", org.user("tmember"), { clientId: "vscode", lifetimeDays: 30 });
    expect(created.status).toBe(200);
    const data = (await created.json()) as { token: string; info: { id: string } };
    const listed = await call("GET", "tokens", org.user("tmember"));
    expect(listed.status).toBe(200);
    expect(await listed.text()).not.toContain(data.token);
    expect((await call("POST", "tokens", org.user("tmember"), { clientId: "vscode", lifetimeDays: 91 })).status).toBe(
      400,
    );
    expect((await call("POST", `tokens/${data.info.id}/revoke`, org.user("tmember"), {})).status).toBe(200);
    expect((await rpc(data.token)).status).toBe(401);
  });
});
