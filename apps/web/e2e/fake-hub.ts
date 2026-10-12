import type { Page } from "@playwright/test";
import type { AuditExportInput } from "@xdev-hive/contracts";

export const USER = { id: "u1", name: "Trần Đức Duy", email: "duy@example.com", image: null };

type Reply = { status: number; json: unknown };

/** Một lời gọi oRPC mà web gửi tới hub giả. `path` bỏ tiền tố /rpc/, ví dụ "teams/list". */
export interface RpcCall {
  path: string;
  method: string;
  /** Header x-hive-org, nếu có. */
  org: string | undefined;
  input: unknown;
}

export type RpcHandler = (input: unknown, call: RpcCall, hub: FakeHub) => Reply;

export interface FakeHub {
  signedIn: boolean;
  /** Lời gọi Better Auth đã nhận, theo thứ tự. `path` bỏ tiền tố /api/auth. */
  authCalls: { path: string; body: unknown }[];
  meMethods: string[];
  rpcCalls: RpcCall[];
}

/** Phản hồi thành công theo định dạng RPC của oRPC. */
export const ok = (value: unknown): Reply => ({ status: 200, json: { json: value } });

/** Lỗi đã khai báo trong hợp đồng, đúng dạng hub trả (`defined: true`, message tiếng Việt của hub). */
export const fail = (code: string, status: number, message: string, data?: unknown): Reply => ({
  status,
  json: { json: { defined: true, code, status, message, ...(data === undefined ? {} : { data }) } },
});

/**
 * Thay hub bằng route giả trong trình duyệt. Định dạng oRPC (`{"json": ...}`) và lỗi UNAUTHORIZED chép từ phản hồi
 * thật của apps/hub; Better Auth trả `{ code, message }` khi lỗi. Thủ tục chưa khai báo trong `rpc` trả NOT_FOUND để
 * test hỏng rõ ràng thay vì treo.
 */
export async function fakeHub(
  page: Page,
  opts: {
    signedIn?: boolean;
    auth?: Record<string, (body: unknown, hub: FakeHub) => Reply>;
    rpc?: Record<string, RpcHandler>;
  } = {},
): Promise<FakeHub> {
  const hub: FakeHub = { signedIn: opts.signedIn ?? false, authCalls: [], meMethods: [], rpcCalls: [] };
  const rpc: Record<string, RpcHandler> = {
    "orgs/mine": () => ok({ orgs: [], canCreateOrg: false }),
    ...opts.rpc,
  };
  await page.route("**/rpc/**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/rpc\//, "");
    if (path === "me/get") {
      hub.meMethods.push(request.method());
      return route.fulfill(
        hub.signedIn
          ? ok(USER)
          : {
              status: 401,
              json: { json: { defined: true, code: "UNAUTHORIZED", status: 401, message: "Chưa đăng nhập." } },
            },
      );
    }
    // Thủ tục chỉ đọc đi bằng GET với input trong ?data=, còn lại gửi trong body.
    const raw = request.method() === "GET" ? url.searchParams.get("data") : request.postData();
    const input = raw ? (JSON.parse(raw) as { json?: unknown }).json : undefined;
    const call: RpcCall = { path, method: request.method(), org: request.headers()["x-hive-org"], input };
    hub.rpcCalls.push(call);
    const handler = rpc[path];
    return route.fulfill(handler ? handler(input, call, hub) : fail("NOT_FOUND", 404, `Hub giả chưa có ${path}.`));
  });
  await page.route("**/api/auth/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api\/auth/, "");
    const body = route.request().postDataJSON();
    hub.authCalls.push({ path, body });
    const handler = opts.auth?.[path];
    return route.fulfill(handler ? handler(body, hub) : { status: 404, json: { message: "Not Found" } });
  });
  return hub;
}

/** Fixtures for MCP administration only; the secret is deliberately not a valid hub token. */
export function mcpAdminFixture(role: "owner" | "admin" | "member" = "admin") {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const tool = {
    id: "doc_get",
    name: "doc_get",
    description: "Đọc một tài liệu",
    group: "knowledge",
    caller: "both",
    enabled: true,
    calls: 12,
    errors: 1,
  };
  const token = (id: number, userId = USER.id) => ({
    id: `0a0a0a0a-0000-4000-8000-${String(id).padStart(12, "0")}`,
    userId,
    ownerName: userId === USER.id ? USER.name : "Người dùng khác",
    prefix: `hive_pat_test${id}`,
    clientId: "cursor",
    createdAt,
    expiresAt,
    lastUsedAt: null as string | null,
    revokedAt: null as string | null,
  });
  const state = {
    tools: [tool],
    tokens: [token(1), token(2, "u2")],
    rawToken: "hive_pat_test_only_never_a_real_token",
    nextId: 3,
  };
  const rpc: Record<string, RpcHandler> = {
    "mcpAdmin/listTools": () => ok({ tools: state.tools }),
    "mcpAdmin/setTool": (input) => {
      if (role === "member") return fail("FORBIDDEN", 403, "Chỉ quản trị được bật/tắt tool.");
      const data = input as { toolName: string; enabled: boolean };
      const found = state.tools.find((t) => t.name === data.toolName);
      if (!found) return fail("NOT_FOUND", 404, "Không tìm thấy tool MCP.");
      found.enabled = data.enabled;
      return ok({ enabled: found.enabled });
    },
    "mcpAdmin/listTokens": () =>
      ok({ tokens: role === "member" ? state.tokens.filter((t) => t.userId === USER.id) : state.tokens }),
    "mcpAdmin/createToken": (input) => {
      const data = input as { clientId: string; lifetimeDays: number };
      const info = {
        ...token(state.nextId++),
        clientId: data.clientId,
        expiresAt: new Date(Date.now() + data.lifetimeDays * 86_400_000).toISOString(),
      };
      state.tokens.push(info);
      return ok({ token: state.rawToken, info });
    },
    "mcpAdmin/revokeToken": (input) => {
      const found = state.tokens.find((t) => t.id === (input as { id: string }).id);
      if (!found) return fail("NOT_FOUND", 404, "Không tìm thấy token MCP.");
      if (role === "member" && found.userId !== USER.id)
        return fail("FORBIDDEN", 403, "Bạn chỉ được thu hồi token của mình.");
      found.revokedAt = new Date().toISOString();
      return ok({ revoked: true });
    },
    "mcpAdmin/extendToken": (input) => {
      if (role === "member") return fail("FORBIDDEN", 403, "Chỉ quản trị được gia hạn.");
      const data = input as { id: string; lifetimeDays: number };
      const found = state.tokens.find((t) => t.id === data.id);
      if (!found) return fail("NOT_FOUND", 404, "Không tìm thấy token MCP.");
      found.expiresAt = new Date(Date.now() + data.lifetimeDays * 86_400_000).toISOString();
      return ok(found);
    },
  };
  return { state, rpc };
}

/** Audit export uses oRPC's multipart File response rather than a JSON fixture. */
export async function fakeAuditExport(
  page: Page,
  hub: FakeHub,
  createFile: (input: AuditExportInput) => File,
): Promise<void> {
  await page.route("**/rpc/audit/export", async (route) => {
    const request = route.request();
    const input = request.postDataJSON().json;
    hub.rpcCalls.push({ path: "audit/export", method: request.method(), org: request.headers()["x-hive-org"], input });
    const form = new FormData();
    form.set("data", JSON.stringify({ json: {}, maps: [[]] }));
    form.set("0", createFile(input));
    const response = new Response(form);
    await route.fulfill({
      status: 200,
      contentType: response.headers.get("content-type") ?? "",
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
}
