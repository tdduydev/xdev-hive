import type { Page } from "@playwright/test";
import { type AuditExportInput, SYSTEM_ROLE_PERMISSIONS } from "@xdev-hive/contracts";

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
  const project = { id: "0a0a0a0a-0000-4000-8000-0000000000b1", key: "mobile-app", name: "Mobile app" };
  type Launch = { transport: "stdio"; command: string; args: string[] } | { transport: "http"; url: string };
  type ServerRule = {
    id: string;
    name: string;
    key: string;
    rule: "allow" | "deny";
    matchType: "name" | "url" | "command" | "wildcard";
    pattern: string;
    projectId: string | null;
    projectKey: string | null;
    launch: Launch | null;
    updatedBy: string;
    createdAt: string;
    updatedAt: string;
  };
  const serverRule = (n: number, fields: Partial<ServerRule> & Pick<ServerRule, "name" | "rule" | "pattern">) => ({
    id: `0a0a0a0a-0000-4000-8000-${String(100 + n).padStart(12, "0")}`,
    key: fields.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
    matchType: "name" as const,
    projectId: null,
    projectKey: null,
    launch: null,
    updatedBy: USER.id,
    createdAt,
    updatedAt: createdAt,
    ...fields,
  });
  const state = {
    tools: [tool],
    tokens: [token(1), token(2, "u2")],
    rawToken: "hive_pat_test_only_never_a_real_token",
    nextId: 3,
    servers: [
      serverRule(1, {
        name: "GitHub",
        rule: "allow",
        pattern: "github",
        launch: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      }),
      serverRule(2, {
        name: "Filesystem",
        rule: "deny",
        matchType: "command",
        pattern: "npx @modelcontextprotocol/server-filesystem",
      }),
      serverRule(3, { name: "Mọi server khác", rule: "deny", matchType: "wildcard", pattern: "*" }),
    ] as ServerRule[],
    nextServer: 4,
  };
  const serverInput = (input: unknown) => {
    const data = input as Omit<ServerRule, "id" | "key" | "projectKey" | "updatedBy" | "createdAt" | "updatedAt">;
    return {
      ...data,
      key: data.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
      pattern: data.matchType === "wildcard" ? "*" : data.pattern || data.name.toLowerCase(),
      projectKey: data.projectId === project.id ? project.key : null,
    };
  };
  const forbidServers = () => fail("FORBIDDEN", 403, "Cần vai trò quản trị của tổ chức trở lên.");
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
    "roles/mine": () => ok({ permissions: [...SYSTEM_ROLE_PERMISSIONS[role]] }),
    "projects/list": () => ok([project]),
    "mcpAdmin/listServers": () => (role === "member" ? forbidServers() : ok({ rules: state.servers })),
    "mcpAdmin/createServer": (input) => {
      if (role === "member") return forbidServers();
      const created = serverRule(state.nextServer++, serverInput(input));
      state.servers.push(created);
      return ok(created);
    },
    "mcpAdmin/updateServer": (input) => {
      if (role === "member") return forbidServers();
      const found = state.servers.find((r) => r.id === (input as { id: string }).id);
      if (!found) return fail("NOT_FOUND", 404, "Không tìm thấy quy tắc MCP server.");
      Object.assign(found, serverInput(input), { updatedAt: new Date().toISOString() });
      return ok(found);
    },
    "mcpAdmin/deleteServer": (input) => {
      if (role === "member") return forbidServers();
      const before = state.servers.length;
      state.servers = state.servers.filter((r) => r.id !== (input as { id: string }).id);
      if (state.servers.length === before) return fail("NOT_FOUND", 404, "Không tìm thấy quy tắc MCP server.");
      return ok({ deleted: true });
    },
    "mcpAdmin/previewServers": (input) => {
      if (role === "member") return forbidServers();
      const projectId = (input as { projectId?: string } | undefined)?.projectId ?? null;
      const scoped = state.servers.filter((r) => r.projectId === null || r.projectId === projectId);
      // Bản rút gọn của bộ quyết định ở hub: quy tắc chặn theo tên thắng định nghĩa cho phép.
      const servers = scoped.flatMap((r) => {
        if (!r.launch) return [];
        const deny = scoped.find((d) => d.rule === "deny" && d.matchType === "name" && d.pattern === r.key);
        const by = deny ?? r;
        return [
          {
            ruleId: r.id,
            name: r.name,
            key: r.key,
            projectId: r.projectId,
            launch: r.launch,
            allowed: by.rule === "allow",
            decidedBy: { id: by.id, name: by.name, rule: by.rule, projectId: by.projectId },
          },
        ];
      });
      return ok({ servers });
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

/** Vai trò cho màn /admin/roles: vai trò hệ thống lấy đúng bộ quyền của contracts, vai trò tự tạo giữ trong state. */
export function rolesFixture(opts: { mine?: string[] } = {}) {
  const now = "2026-10-12T08:00:00.000Z";
  const state = {
    custom: [
      {
        id: "7e7e7e7e-0000-4000-8000-000000000001",
        name: "Kiểm toán",
        description: "Chỉ xem chi phí và nhật ký.",
        scope: "org" as const,
        permissions: ["members.read", "costs.read", "audit.read", "audit.export"],
        assignments: [{ kind: "member" as const, userId: "u-lan", name: "Trần Lan", email: "lan@acme.vn" }],
        updatedAt: now,
      },
    ] as Array<{
      id: string;
      name: string;
      description: string | null;
      scope: "org" | "team";
      permissions: string[];
      assignments: Array<
        { kind: "member"; userId: string; name: string; email: string } | { kind: "team"; teamId: string; name: string }
      >;
      updatedAt: string;
    }>,
    calls: [] as { path: string; input: unknown }[],
  };
  const members = [
    {
      userId: "u-lan",
      name: "Trần Lan",
      email: "lan@acme.vn",
      image: null,
      role: "member",
      status: "active",
      joinedAt: now,
      teams: [],
    },
    {
      userId: "u-ha",
      name: "Phạm Hà",
      email: "ha@acme.vn",
      image: null,
      role: "member",
      status: "active",
      joinedAt: now,
      teams: [],
    },
  ];
  const teamsList = [
    {
      id: "5a5a5a5a-0000-4000-8000-000000000001",
      slug: "pay",
      name: "Thanh toán",
      color: null,
      createdAt: now,
      systemCount: 0,
      memberCount: 2,
    },
  ];
  const system = (Object.keys(SYSTEM_ROLE_PERMISSIONS) as (keyof typeof SYSTEM_ROLE_PERMISSIONS)[]).map((id) => ({
    id,
    scope: id.startsWith("team-") ? "team" : "org",
    permissions: [...SYSTEM_ROLE_PERMISSIONS[id]],
    memberCount: id === "owner" ? 1 : 2,
  }));
  const find = (id: string) => state.custom.find((r) => r.id === id);
  const rpc: Record<string, RpcHandler> = {
    "roles/list": () => ok({ system, custom: state.custom }),
    "roles/mine": () => ok({ permissions: opts.mine ?? [...SYSTEM_ROLE_PERMISSIONS.admin] }),
    "roles/create": (input) => {
      const i = input as {
        name: string;
        description?: string;
        scope: "org" | "team";
        permissions: string[];
        copyOf?: keyof typeof SYSTEM_ROLE_PERMISSIONS;
      };
      state.calls.push({ path: "roles/create", input });
      const role = {
        id: `7e7e7e7e-0000-4000-8000-00000000000${state.custom.length + 1}`,
        name: i.name,
        description: i.description || null,
        scope: i.scope,
        permissions: i.copyOf ? [...SYSTEM_ROLE_PERMISSIONS[i.copyOf]] : i.permissions,
        assignments: [],
        updatedAt: now,
      };
      state.custom.push(role);
      return ok(role);
    },
    "roles/update": (input) => {
      const i = input as { roleId: string; name?: string; description?: string; permissions?: string[] };
      state.calls.push({ path: "roles/update", input });
      const role = find(i.roleId);
      if (!role) return fail("NOT_FOUND", 404, "Không tìm thấy vai trò.");
      if (i.permissions) role.permissions = i.permissions;
      if (i.name) role.name = i.name;
      role.updatedAt = new Date().toISOString();
      return ok(role);
    },
    "roles/remove": (input) => {
      const i = input as { roleId: string };
      const role = find(i.roleId);
      if (role?.assignments.length)
        return fail(
          "CONFLICT",
          409,
          `Vai trò đang gán cho ${role.assignments.length} người hoặc đội; gỡ hết trước khi xoá.`,
          {
            code: "ROLE_IN_USE",
          },
        );
      state.custom = state.custom.filter((r) => r.id !== i.roleId);
      return ok({ ok: true });
    },
    "roles/assign": (input) => {
      const i = input as
        | { roleId: string; kind: "member"; userId: string }
        | { roleId: string; kind: "team"; teamId: string };
      state.calls.push({ path: "roles/assign", input });
      const role = find(i.roleId);
      if (!role) return fail("NOT_FOUND", 404, "Không tìm thấy vai trò.");
      if (i.kind === "member") {
        const m = members.find((x) => x.userId === i.userId);
        if (m) role.assignments.push({ kind: "member", userId: m.userId, name: m.name, email: m.email });
      } else {
        const tm = teamsList.find((x) => x.id === i.teamId);
        if (tm) role.assignments.push({ kind: "team", teamId: tm.id, name: tm.name });
      }
      role.updatedAt = new Date().toISOString();
      return ok(role);
    },
    "roles/unassign": (input) => {
      const i = input as
        | { roleId: string; kind: "member"; userId: string }
        | { roleId: string; kind: "team"; teamId: string };
      const role = find(i.roleId);
      if (!role) return fail("NOT_FOUND", 404, "Không tìm thấy vai trò.");
      role.assignments = role.assignments.filter((a) =>
        a.kind === "member"
          ? !(i.kind === "member" && a.userId === i.userId)
          : !(i.kind === "team" && a.teamId === i.teamId),
      );
      role.updatedAt = new Date().toISOString();
      return ok(role);
    },
    "orgMembers/list": () => ok(members),
    "teams/list": () => ok(teamsList),
  };
  return { state, rpc };
}
