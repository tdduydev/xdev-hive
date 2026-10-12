import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import {
  Client,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "./app.ts";
import { type Auth, createAuth } from "./modules/identity/index.ts";
import { createPool } from "./modules/platform/index.ts";

// Dùng database chung với file test khác (chạy song song), nên email và slug có hậu tố riêng của lần chạy; người
// tạo tổ chức nằm trong orgCreators để không phụ thuộc hub đã có tổ chức hay chưa.
// Hub chạy trên cổng thật vì client MCP tự đi qua discovery OAuth bằng fetch, và issuer phải khớp baseURL.

const RUN = Date.now().toString(36);
const emailOf = (name: string) => `${name}+${RUN}@example.com`;
const SLUG = { a: `to-chuc-a-${RUN}`, b: `to-chuc-b-${RUN}`, c: `to-chuc-c-${RUN}` };
const CLIENT_ID = "https://cli.example.com/oauth/client.json";
const REDIRECT = "http://127.0.0.1:33418/callback";
const clientDocument = {
  client_id: CLIENT_ID,
  client_name: "CLI thử nghiệm",
  redirect_uris: [REDIRECT],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

const pools: pg.Pool[] = [];
let admin: pg.Pool;
let auth: Auth;
let baseURL = "";
let server: ReturnType<typeof serve>;
let fetchApp: (req: Request) => Response | Promise<Response> = () => new Response(null, { status: 503 });
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};

async function call(path: string, init: RequestInit & { as?: string; org?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.as) headers.set("cookie", cookies[init.as] ?? "");
  if (init.org) headers.set("x-hive-org", init.org);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(`${baseURL}${path}`, { ...init, headers, redirect: "manual" });
}

async function api(as: string, method: string, path: string, body: unknown, org?: string) {
  const res = await call(`/api/v1${path}`, { method, as, ...(org ? { org } : {}), body: JSON.stringify(body) });
  expect(res.status, `${method} ${path}`).toBe(200);
  return (await res.json()) as { id: string };
}

beforeAll(async () => {
  const db = inject("db");
  admin = new pg.Pool({ connectionString: db.adminUrl });
  const authPool = createPool(db.authUrl);
  const appPool = createPool(db.appUrl);
  pools.push(admin, authPool, appPool);

  server = serve({ fetch: (req) => fetchApp(req), port: 0 });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  baseURL = `http://localhost:${(server.address() as AddressInfo).port}`;

  auth = createAuth({
    pool: authPool,
    baseURL,
    secret: "test-secret-0123456789abcdef-0123456789",
    allowEmailSignUp: true,
    // CIMD thật từ chối mọi host không public; thay bằng hàm trả tài liệu client cố định.
    fetchClientMetadata: async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== CLIENT_ID) return new Response("không có", { status: 404 });
      return Response.json(clientDocument, { headers: { "cache-control": "max-age=300" } });
    },
  });
  const app = createApp({
    config: { port: 0, version: "t", publicUrl: baseURL, orgCreators: [emailOf("alice"), emailOf("bob")] },
    auth,
    pool: appPool,
  });
  fetchApp = (req) => app.fetch(req);

  for (const name of ["alice", "bob"]) {
    const res = await call("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ name: `Người ${name}`, email: emailOf(name), password: "mat-khau-du-dai-123" }),
    });
    expect(res.status).toBe(200);
    cookies[name] = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    ids[name] = ((await res.json()) as { user: { id: string } }).user.id;
  }
  // Alice thuộc hai tổ chức (phải truyền org); Bob có tổ chức riêng mà Alice không được thấy.
  ids.orgA = (await api("alice", "POST", "/orgs", { name: "Tổ chức A", slug: SLUG.a }, undefined)).id;
  ids.orgB = (await api("alice", "POST", "/orgs", { name: "Tổ chức B", slug: SLUG.b }, undefined)).id;
  ids.orgC = (await api("bob", "POST", "/orgs", { name: "Tổ chức C", slug: SLUG.c }, undefined)).id;
  ids.teamA = (await api("alice", "POST", "/teams", { name: "Thanh toán", slug: "thanh-toan" }, ids.orgA)).id;
  await api("alice", "POST", "/systems", { teamId: ids.teamA, name: "Cổng thanh toán", slug: "cong-tt" }, ids.orgA);
  await api("alice", "POST", `/teams/${ids.teamA}/members`, { userId: ids.alice, role: "admin" }, ids.orgA);
  const teamC = (await api("bob", "POST", "/teams", { name: "Bí mật", slug: "bi-mat" }, ids.orgC)).id;
  await api("bob", "POST", "/systems", { teamId: teamC, name: "Hệ thống bí mật", slug: "bi-mat" }, ids.orgC);
});

afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await Promise.all(pools.map((p) => p.end()));
});

/** Client OAuth của một CLI: giữ token trong bộ nhớ, "mở trình duyệt" bằng cách ghi lại URL authorize. */
class CliProvider implements OAuthClientProvider {
  clientMetadataUrl = CLIENT_ID;
  authorizationUrl: URL | undefined;
  #client: OAuthClientInformationMixed | undefined;
  #tokens: OAuthTokens | undefined;
  #verifier = "";
  #discovery: OAuthDiscoveryState | undefined;

  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata(): OAuthClientMetadata {
    return clientDocument as OAuthClientMetadata;
  }
  clientInformation() {
    return this.#client;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.#client = info;
  }
  tokens() {
    return this.#tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.#tokens = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.#verifier = verifier;
  }
  codeVerifier() {
    return this.#verifier;
  }
  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.#discovery = state;
  }
  discoveryState() {
    return this.#discovery;
  }
}

/** Người dùng đã đăng nhập mở URL authorize, đồng ý trên trang consent, rồi trình duyệt quay về redirect_uri. */
async function approve(authorizationUrl: URL, as: string, signedIn = true): Promise<URLSearchParams> {
  const res = await fetch(authorizationUrl, {
    headers: signedIn ? { cookie: cookies[as] ?? "" } : {},
    redirect: "manual",
  });
  // Better Auth trả 302 cho trình duyệt, hoặc JSON {redirect, url} khi request không đòi HTML như ở đây.
  const next = res.headers.get("location") ?? ((await res.json()) as { url: string }).url;
  let location = new URL(next, baseURL);
  if (location.pathname === "/login") {
    // Chưa đăng nhập: trang đăng nhập của web gửi kèm query đã ký (oauthProviderClient), hub trả bước kế tiếp.
    expect(signedIn).toBe(false);
    const res = await call("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({
        email: emailOf(as),
        password: "mat-khau-du-dai-123",
        oauth_query: location.search.slice(1),
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { redirect?: boolean; url?: string };
    expect(body.redirect).toBe(true);
    cookies[as] = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    location = new URL(body.url ?? "", baseURL);
  }
  if (location.pathname === "/mcp/consent") {
    const consent = await call("/api/auth/oauth2/consent", {
      method: "POST",
      as,
      body: JSON.stringify({ accept: true, oauth_query: location.search.slice(1) }),
    });
    expect(consent.status).toBe(200);
    // Trang /mcp/consent của web dựa vào đúng dạng này để chuyển trình duyệt về CLI.
    const body = (await consent.json()) as { redirect?: boolean; url?: string };
    expect(body.redirect).toBe(true);
    location = new URL(body.url ?? "");
  }
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
  if (!location.searchParams.get("code")) throw new Error(`Không nhận được code: ${location}`);
  // Trả nguyên tham số callback: client kiểm cả `iss` (RFC 9207), không chỉ `code`.
  return location.searchParams;
}

async function connect(provider: CliProvider) {
  const client = new Client({ name: "cli-thu", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), { authProvider: provider }));
  return client;
}

/** Đi hết luồng OAuth cho một người dùng, trả về client MCP đã kết nối. */
async function login(as: string, signedIn = true) {
  const provider = new CliProvider();
  const transport = new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), { authProvider: provider });
  await expect(new Client({ name: "cli-thu", version: "1.0.0" }).connect(transport)).rejects.toThrow(UnauthorizedError);
  expect(provider.authorizationUrl).toBeDefined();
  await transport.finishAuth(await approve(provider.authorizationUrl as URL, as, signedIn));
  return { provider, client: await connect(provider) };
}

const text = (result: unknown) => {
  const r = result as { content: { type: string; text: string }[]; isError?: boolean };
  return { isError: r.isError ?? false, text: r.content.map((c) => c.text).join("\n") };
};
const json = (result: unknown) => JSON.parse(text(result).text) as Record<string, unknown>;

const rpc = (headers: Record<string, string> = {}) =>
  fetch(`${baseURL}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

describe("xác thực ở /mcp", () => {
  it("không có token: 401 kèm WWW-Authenticate trỏ tới protected resource metadata", async () => {
    const res = await rpc();
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    const url = challenge.match(/resource_metadata="([^"]+)"/)?.[1];
    expect(url).toBe(`${baseURL}/.well-known/oauth-protected-resource/mcp`);

    const meta = await fetch(url as string);
    expect(meta.status).toBe(200);
    const body = (await meta.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe(`${baseURL}/mcp`);
    expect(body.authorization_servers).toEqual([`${baseURL}/api/auth`]);
  });

  it("token rác: 401 invalid_token", async () => {
    const res = await rpc({ authorization: "Bearer khong-phai-jwt" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/error="invalid_token"/);
  });

  const sign = async (aud: string) => {
    const { baseURL: issuer } = await auth.$context;
    const api = auth.api as unknown as { signJWT: (o: unknown) => Promise<{ token: string }> };
    return (await api.signJWT({ body: { payload: { sub: ids.alice, aud, iss: issuer, scope: "openid" } } })).token;
  };

  it("token đúng chữ ký nhưng sai audience: 401; cùng token đúng audience thì qua", async () => {
    const wrong = await rpc({ authorization: `Bearer ${await sign("https://khac.example.com/mcp")}` });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toMatch(/error="invalid_token"/);
    // Đối chứng: chỉ đổi aud thì được nhận, nên 401 ở trên đúng là do audience.
    const right = await rpc({ authorization: `Bearer ${await sign(`${baseURL}/mcp`)}` });
    expect(right.status).toBe(200);
  });

  it("chỉ phục vụ POST: GET có token hợp lệ trả 405 vì cổng không giữ phiên", async () => {
    expect((await fetch(`${baseURL}/mcp`)).status).toBe(401);
    const res = await fetch(`${baseURL}/mcp`, { headers: { authorization: `Bearer ${await sign(`${baseURL}/mcp`)}` } });
    expect(res.status).toBe(405);
  });
});

describe("luồng OAuth đầy đủ rồi gọi tool", () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await login("alice"));
  });

  afterAll(async () => {
    await client?.close();
  });

  it("tools/list có các tool của tenancy, runs và knowledge, tool nào cũng nhận tham số org", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "doc_check_submit",
      "doc_get",
      "doc_list",
      "doc_propose",
      "hive_whoami",
      "mcp_server_list",
      "memory_search",
      "memory_write",
      "orgs_list",
      "plan_submit",
      "project_list",
      "review_submit",
      "run_list",
      "skill_get",
      "skill_list",
      "skill_propose",
      "systems_list",
      "task_get",
      "task_update",
      "teams_list",
    ]);
    // plan_submit và review_submit ghi lên hub nhưng vẫn khai chỉ đọc: run plan và run review chạy Claude Code ở chế độ
    // plan, chỉ gọi được tool MCP chỉ đọc.
    const writes = ["task_update", "memory_write", "doc_propose", "skill_propose"];
    for (const t of tools) {
      expect(t.inputSchema.properties).toHaveProperty("org");
      expect(t.annotations?.readOnlyHint).toBe(!writes.includes(t.name));
    }
  });

  it("người dùng nhiều tổ chức phải truyền org; lỗi liệt kê các tổ chức", async () => {
    const r = text(await client.callTool({ name: "hive_whoami", arguments: {} }));
    expect(r.isError).toBe(true);
    expect(r.text).toContain(SLUG.a);
    expect(r.text).toContain(SLUG.b);
    expect(r.text).not.toContain(SLUG.c);
  });

  it("hive_whoami trả người dùng, client và vai trò trong tổ chức", async () => {
    const me = json(await client.callTool({ name: "hive_whoami", arguments: { org: SLUG.a } }));
    expect(me).toMatchObject({
      kind: "user",
      user: { id: ids.alice, email: emailOf("alice") },
      clientId: CLIENT_ID,
      org: { id: ids.orgA, slug: SLUG.a, role: "owner" },
    });
    // Đội lấy theo tổ chức đang chọn (RLS): không lẫn đội của tổ chức khác.
    expect((me as { teams: unknown }).teams).toEqual([{ id: ids.teamA, name: "Thanh toán", role: "admin" }]);
  });

  it("orgs_list chỉ có tổ chức của mình", async () => {
    const { orgs } = json(await client.callTool({ name: "orgs_list", arguments: { org: ids.orgA } })) as {
      orgs: { slug: string }[];
    };
    expect(orgs.map((o) => o.slug)).toEqual([SLUG.a, SLUG.b]);
  });

  it("teams_list và systems_list chỉ thấy dữ liệu của tổ chức đã chọn", async () => {
    const { teams } = json(await client.callTool({ name: "teams_list", arguments: { org: SLUG.a } })) as {
      teams: { name: string; systemCount: number }[];
    };
    expect(teams).toEqual([expect.objectContaining({ name: "Thanh toán", systemCount: 1 })]);
    const { systems } = json(await client.callTool({ name: "systems_list", arguments: { org: SLUG.a } })) as {
      systems: { name: string }[];
    };
    expect(systems.map((s) => s.name)).toEqual(["Cổng thanh toán"]);
    const empty = json(await client.callTool({ name: "teams_list", arguments: { org: SLUG.b } }));
    expect(empty.teams).toEqual([]);
  });

  it("không vào được tổ chức của người khác, kể cả biết id", async () => {
    for (const org of [SLUG.c, ids.orgC as string]) {
      const r = text(await client.callTool({ name: "teams_list", arguments: { org } }));
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain("Bí mật");
    }
  });

  it("mỗi lời gọi tool thành công ghi một dòng audit mcp.<tên tool> trong tổ chức đã chọn", async () => {
    const { rows } = await admin.query<{ action: string; org_id: string; actor_user_id: string; data: unknown }>(
      `select action, org_id, actor_user_id, data from hive.audit_log
       where action like 'mcp.%' and org_id = any($1::uuid[]) order by created_at`,
      [[ids.orgA, ids.orgB, ids.orgC]],
    );
    expect(rows.map((r) => r.action)).toEqual([
      "mcp.hive_whoami",
      "mcp.orgs_list",
      "mcp.teams_list",
      "mcp.systems_list",
      "mcp.teams_list",
    ]);
    expect(rows.every((r) => r.actor_user_id === ids.alice)).toBe(true);
    expect(rows[0]?.org_id).toBe(ids.orgA);
    expect(rows[4]?.org_id).toBe(ids.orgB);
    expect(rows[0]?.data).toMatchObject({ via: "user", clientId: CLIENT_ID });
    // Không ghi gì vào tổ chức của Bob.
    expect(rows.some((r) => r.org_id === ids.orgC)).toBe(false);
  });

  it("người chưa đăng nhập trên trình duyệt; người chỉ có một tổ chức không cần truyền org", async () => {
    const bob = await login("bob", false);
    try {
      const me = json(await bob.client.callTool({ name: "hive_whoami", arguments: {} }));
      expect(me).toMatchObject({ user: { id: ids.bob }, org: { id: ids.orgC } });
      const { teams } = json(await bob.client.callTool({ name: "teams_list", arguments: {} })) as {
        teams: { name: string }[];
      };
      expect(teams.map((t) => t.name)).toEqual(["Bí mật"]);
    } finally {
      await bob.client.close();
    }
  });
});
