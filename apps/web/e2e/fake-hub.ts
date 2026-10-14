import type { Page, WebSocketRoute } from "@playwright/test";
import {
  type AuditExportInput,
  type CodeDryRunResult,
  defaultProjectSettings,
  outcomeToCodeWorkflow,
  type ReviewWorkflow,
  reviewPhase,
  SYSTEM_ROLE_PERMISSIONS,
  WORKFLOW_PRESETS,
  type WorkflowInput,
} from "@xdev-hive/contracts";

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

export const CODE_WORKFLOW_ID = "3c3c3c3c-0000-4000-8000-0000000000c1";
export const PAYMENT_PROJECT_ID = "7a7a7a7a-0000-4000-8000-000000000001";
const RECONCILE_PROJECT_ID = "7a7a7a7a-0000-4000-8000-000000000002";

/**
 * Quy trình Code cho trang Quy trình duyệt (spec 009, T013): thêm quy trình "Code payment-api" vào `state` của
 * workflowsFixture, kèm hai dự án, các run code đã mở PR để chạy thử, và hai route của hub cho quy trình code
 * (`codeReviews/dryRun`, `codeReviews/workflowFromProject`). Gộp `rpc` trả về sau `workflowsFixture().rpc`; lưu và xoá
 * vẫn do route của quy trình tài liệu xử lý vì cùng một danh sách.
 */
export function codeWorkflowsFixture(state: { workflows: ReviewWorkflow[] }) {
  const now = "2026-10-13T08:00:00.000Z";
  const teamId = "5a5a5a5a-0000-4000-8000-000000000001";
  const codeWorkflow: ReviewWorkflow = {
    id: CODE_WORKFLOW_ID,
    name: "Code payment-api",
    preset: "code-basic",
    subject: "code",
    teamId,
    docPrefixes: [],
    code: {
      projects: ["payment-api"],
      baseBranches: ["main"],
      taskTypes: [],
      paths: [],
      merge: "project",
      maxAgentRevisions: 2,
      dismissStaleApprovals: false,
    },
    phases: WORKFLOW_PRESETS["code-basic"].map((p) => reviewPhase.parse(p)),
    enabled: true,
    updatedAt: now,
    updatedBy: "u1",
    inFlight: 0,
  };
  state.workflows = [...state.workflows, codeWorkflow];

  const projects = [
    { id: PAYMENT_PROJECT_ID, key: "payment-api", name: "Payment API", teamId, state: "active" },
    { id: RECONCILE_PROJECT_ID, key: "reconcile", name: "Reconcile", teamId, state: "active" },
  ];
  const task = (n: number, title: string) => ({
    id: `8b8b8b8b-0000-4000-8000-00000000000${n}`,
    projectId: PAYMENT_PROJECT_ID,
    teamId,
    key: `PAY-${n}`,
    number: n,
    title,
    type: "feature",
    status: "review",
  });
  const tasks = [task(1, "Hoàn tiền một phần"), task(2, "Làm tròn tiền tệ")];
  const codeRun = (n: number, taskId: string, pr: number, sha: string, finishedAt: string, withPr = true) => ({
    id: `6e6e6e6e-0000-4000-8000-00000000010${n}`,
    taskId,
    projectId: PAYMENT_PROJECT_ID,
    teamId,
    kind: "code",
    state: "succeeded",
    branch: `ai/PAY-${n}`,
    headSha: sha,
    prUrl: withPr ? `https://github.com/acme/payment-api/pull/${pr}` : null,
    createdAt: finishedAt,
    finishedAt,
  });
  const runs = [
    codeRun(1, tasks[0]?.id ?? "", 121, "0c4e2ab0000000000000000000000000000000aa", "2026-10-12T09:00:00.000Z"),
    codeRun(2, tasks[1]?.id ?? "", 128, "7ff96370000000000000000000000000000000bb", "2026-10-13T07:00:00.000Z"),
    // Run chưa mở PR không chạy thử được: hub cần PR để tính phạm vi và số liệu diff.
    codeRun(3, tasks[1]?.id ?? "", 0, "1111111000000000000000000000000000000cc", "2026-10-13T07:30:00.000Z", false),
  ];

  const calls = {
    dryRuns: [] as { workflow: WorkflowInput; runId: string }[],
    fromProject: [] as string[],
  };
  const rpc: Record<string, RpcHandler> = {
    "projects/list": () => ok(projects),
    "tasks/list": () => ok(tasks),
    "runs/latest": (input) => {
      const { projectId } = input as { projectId?: string };
      return ok(projectId === PAYMENT_PROJECT_ID ? runs : []);
    },
    "codeReviews/dryRun": (input) => {
      const i = input as { workflow: WorkflowInput; runId: string };
      calls.dryRuns.push(i);
      const run = runs.find((r) => r.id === i.runId);
      const project = projects.find((p) => p.id === run?.projectId) ?? projects[0];
      if (!run || !project) return fail("NOT_FOUND", 404, "Không tìm thấy run.");
      const scope = i.workflow.code?.projects ?? [];
      const matched = !scope.length || scope.includes(project.key);
      const phases = i.workflow.phases.flatMap((p) => p.gates.map((g) => ({ g, phase: p.name })));
      const result: CodeDryRunResult = {
        runId: run.id,
        project: { id: project.id, key: project.key, name: project.name },
        pr: { number: Number(run.prUrl?.split("/").at(-1)), url: run.prUrl ?? "" },
        matched,
        reason: matched
          ? "Dự án payment-api, nhánh đích main, loại task feature đều nằm trong phạm vi."
          : `Dự án ${project.key} không nằm trong phạm vi.`,
        chosen: matched ? { id: i.workflow.id ?? null, name: i.workflow.name } : null,
        outranked: matched ? [{ id: null, name: "Code mặc định của tổ chức" }] : [],
        gates: phases.map(({ g, phase }) => {
          // Mô phỏng điều kiện số dòng: PR thử đổi 84 dòng.
          const min = g.conditions?.minChangedLines;
          const skip = typeof min === "number" && min > 84;
          return {
            gateId: g.id,
            name: g.name,
            kind: g.kind,
            phase,
            runs: !skip,
            reason: skip ? `Chỉ đổi 84 dòng, dưới ngưỡng ${min}.` : "Không có điều kiện, luôn chạy.",
          };
        }),
      };
      return ok(result);
    },
    "codeReviews/workflowFromProject": (input) => {
      const { projectKey } = input as { projectKey: string };
      calls.fromProject.push(projectKey);
      const settings = defaultProjectSettings(0);
      settings.features.crossReview = true;
      settings.merge.requireCi = true;
      settings.merge.requiredApprovals = 1;
      settings.outcome.default.push({ check: "review", required: true, by: "codex", minScore: 8 });
      return ok(outcomeToCodeWorkflow(settings, projectKey));
    },
  };
  return { calls, rpc };
}

export const ACCOUNTS_ORG = {
  id: "0a0a0a0a-0000-4000-8000-00000000000a",
  slug: "acme-dev",
  name: "Acme Software xDev",
  role: "owner",
  emailDomain: null,
  createdAt: "2026-10-01T03:00:00.000Z",
};
export const SHARED_MACHINE_ID = "8e8e8e8e-0000-4000-8000-000000000001";
export const PERSONAL_MACHINE_ID = "8e8e8e8e-0000-4000-8000-000000000002";

/**
 * Gói agent trên trang Máy (T063): hai máy (một dùng chung có `accounts-remote`, một cá nhân) và các route
 * `machines/accounts/*` cùng `machines/setAccount`. Đăng nhập giả lập đúng hợp đồng:
 * - Claude: `waiting` kèm URL và `needsInput`; gửi mã (`loginInput`) thì `done` với `accountId` "claude-2".
 * - Codex: `starting` rồi URL + mã thiết bị; sau `codexPolls` lần hỏi thì `done` với "codex-2".
 * Chữ người dùng dán chỉ được ghi ở `state.pasted` để test kiểm hub nhận đúng, không bao giờ nằm trong phiên trả về.
 */
export function machineAccountsFixture(opts: { codexPolls?: number } = {}) {
  const at = "2026-10-13T08:00:00.000Z";
  const teamId = "7e7e7e7e-0000-4000-8000-000000000001";
  const machine = (id: string, name: string, shared: boolean) => ({
    id,
    teamId,
    kind: "worker",
    name,
    os: "linux",
    version: "1.3.0",
    clis: ["claude", "codex"],
    capacity: 2,
    status: "online",
    lastSeenAt: at,
    createdAt: at,
    shared,
    registeredBy: "u2",
  });
  const account = (id: string, cli: string, label: string, over: Record<string, unknown> = {}) => ({
    id,
    cli,
    label,
    roles: [],
    enabled: true,
    loggedIn: true,
    sessionPct: 32,
    weekPct: 85,
    resetsAt: "2026-10-13T11:00:00.000Z",
    stopAtSession: 0,
    stopAtWeek: 0,
    inUse: 0,
    ...over,
  });
  type Login = Record<string, unknown> & { requestId: string; cli: string; status: string };
  const state = {
    accounts: [
      account("claude-1", "claude", "Claude Max team"),
      account("codex-1", "codex", "Codex Plus", { loggedIn: false, sessionPct: null, weekPct: null, resetsAt: null }),
    ],
    login: null as Login | null,
    polls: 0,
    pasted: [] as string[],
  };
  const codexPolls = opts.codexPolls ?? 2;
  const session = (over: Record<string, unknown>): Login => ({ ...state.login, ...over }) as Login;
  const rpc: Record<string, RpcHandler> = {
    "orgs/mine": () => ok({ orgs: [ACCOUNTS_ORG], canCreateOrg: false }),
    "teams/list": () =>
      ok([
        { id: teamId, slug: "sdlc", name: "AI SDLC", color: "#004CFF", createdAt: at, systemCount: 0, memberCount: 1 },
      ]),
    "projects/list": () => ok([]),
    "orgMembers/list": () => ok([]),
    "machines/workerRelease": () => ok(null),
    "machines/list": () =>
      ok([
        {
          ...machine(SHARED_MACHINE_ID, "sdlc-box-01", true),
          capabilities: ["sdlc", "accounts-remote"],
          accounts: state.accounts,
        },
        { ...machine(PERSONAL_MACHINE_ID, "dev-ha", false), accounts: null },
      ]),
    "machines/accounts/list": (input) => {
      const { machineId } = input as { machineId: string };
      if (machineId === PERSONAL_MACHINE_ID) {
        return ok({ machineId, accounts: null, accountsAt: null, remote: false, reason: "personal", login: null });
      }
      const active = state.login && ["starting", "waiting"].includes(state.login.status) ? state.login : null;
      return ok({ machineId, accounts: state.accounts, accountsAt: at, remote: true, reason: null, login: active });
    },
    "machines/setAccount": (input) => {
      const { machineId, accountId, enabled } = input as { machineId: string; accountId: string; enabled: boolean };
      state.accounts = state.accounts.map((a) => (a.id === accountId ? { ...a, enabled } : a));
      return ok({ ...machine(machineId, "sdlc-box-01", true), accounts: state.accounts });
    },
    "machines/accounts/loginStart": (input) => {
      const { machineId, cli, label, how } = input as {
        machineId: string;
        cli: "claude" | "codex";
        label: string;
        how: string;
      };
      state.polls = 0;
      state.login = {
        requestId: `login-${cli}`,
        machineId,
        cli,
        label,
        how,
        status: cli === "claude" ? "waiting" : "starting",
        url: cli === "claude" ? "https://claude.ai/oauth/authorize?code=true&state=abc" : null,
        code: null,
        needsInput: cli === "claude",
        accountId: null,
        error: null,
        startedBy: "u1",
        startedAt: at,
        expiresAt: "2026-10-13T08:10:00.000Z",
      };
      return ok(state.login);
    },
    "machines/accounts/loginGet": () => {
      if (!state.login) return fail("NOT_FOUND", 404, "Không có phiên đăng nhập.");
      if (state.login.cli === "codex" && state.login.status !== "done") {
        state.polls += 1;
        state.login =
          state.polls > codexPolls
            ? session({ status: "done", url: null, code: null, accountId: "codex-2" })
            : session({ status: "waiting", url: "https://auth.openai.com/codex/device", code: "ABCD-1234" });
        if (state.login.status === "done") {
          state.accounts = [...state.accounts, account("codex-2", "codex", String(state.login.label))];
        }
      }
      return ok(state.login);
    },
    "machines/accounts/loginInput": (input) => {
      const { text } = input as { text: string };
      state.pasted.push(text);
      state.login = session({ status: "done", needsInput: false, accountId: "claude-2" });
      state.accounts = [...state.accounts, account("claude-2", "claude", String(state.login.label))];
      return ok(state.login);
    },
    "machines/accounts/loginCancel": () => {
      state.login = session({ status: "cancelled", needsInput: false });
      return ok(state.login);
    },
  };
  return { state, rpc };
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const fromB64 = (data: string) => Buffer.from(data, "base64").toString("utf8");

export const TERMINAL_ORG = ACCOUNTS_ORG;
export const TERMINAL_PROJECT = { id: "9a9a9a9a-0000-4000-8000-000000000001", key: "PAY", name: "payment-api" };
export const TERMINAL_MACHINE = "8e8e8e8e-0000-4000-8000-0000000000a1";
export const TERMINAL_BUSY_MACHINE = "8e8e8e8e-0000-4000-8000-0000000000a2";
export const TERMINAL_OFFLINE_MACHINE = "8e8e8e8e-0000-4000-8000-0000000000a3";
export const TERMINAL_THREAD = "4d4d4d4d-0000-4000-8000-0000000000a1";
export const TERMINAL_SESSION_ID = "7b7b7b7b-0000-4000-8000-0000000000a1";
const T0 = "2026-10-14T01:00:00.000Z";

export function terminalSession(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TERMINAL_SESSION_ID,
    projectId: TERMINAL_PROJECT.id,
    projectKey: TERMINAL_PROJECT.key,
    projectName: TERMINAL_PROJECT.name,
    machineId: TERMINAL_MACHINE,
    machineName: "sdlc-box-01",
    ownerId: USER.id,
    ownerName: USER.name,
    isOwner: true,
    mode: "propose",
    model: "sonnet",
    advisor: null,
    state: "running",
    visibility: "private",
    permissions: "workspace",
    accountLabel: "Claude Max team",
    threadId: TERMINAL_THREAD,
    cols: 120,
    rows: 32,
    exitCode: null,
    endReason: null,
    bytes: 0,
    createdAt: T0,
    endedAt: null,
    ...over,
  };
}

export function terminalProposal(over: Record<string, unknown> = {}) {
  return {
    id: "6f6f6f6f-0000-4000-8000-0000000000a1",
    threadId: TERMINAL_THREAD,
    action: {
      type: "task.create",
      projectId: TERMINAL_PROJECT.id,
      title: "Thêm hoàn tiền một phần",
      body: "",
      tier: "medium",
      tierReason: "Một màn UI kèm e2e.",
    },
    status: "pending",
    expiresAt: "2026-10-15T01:00:00.000Z",
    decidedBy: null,
    reason: null,
    createdAt: "2026-10-14T01:05:00.000Z",
    ...over,
  };
}

/**
 * Terminal Leader (route `terminal.*`): máy, phiên, đề xuất và nhật ký Bypass. `state` cho test đọc body đã gửi lên
 * và đổi dữ liệu giữa các lần hỏi lại. Máy `busy` và máy offline có sẵn để thử cách hộp thoại xử lý.
 */
export function terminalFixture(
  opts: { session?: Record<string, unknown>; options?: Record<string, unknown>; chunks?: string[] } = {},
) {
  const state = {
    session: terminalSession(opts.session),
    sessions: [] as Record<string, unknown>[],
    proposals: [terminalProposal()] as Record<string, unknown>[],
    actions: [] as Record<string, unknown>[],
    canInput: true,
    tickets: 0,
    opened: [] as unknown[],
    approved: [] as unknown[],
    rejected: [] as unknown[],
    closed: 0,
    visibility: [] as unknown[],
    chunkCalls: [] as unknown[],
  };
  state.sessions = [state.session];
  const chunks = (opts.chunks ?? []).map((text, seq) => ({ seq, data: b64(text) }));
  const machine = (id: string, name: string, over: Record<string, unknown> = {}) => ({
    id,
    name,
    online: true,
    fullAccess: false,
    busy: false,
    accounts: [
      { id: "claude-1", label: "Claude Max team", loggedIn: true, sessionPct: 32, weekPct: 85 },
      { id: "claude-2", label: "Claude Pro Ha", loggedIn: false, sessionPct: null, weekPct: null },
    ],
    ...over,
  });
  const rpc: Record<string, RpcHandler> = {
    "orgs/mine": () => ok({ orgs: [TERMINAL_ORG], canCreateOrg: false }),
    "projects/list": () => ok([TERMINAL_PROJECT]),
    "leader/threads/list": () => ok([]),
    "leader/approvals/list": () => ok([]),
    "terminal/options": () =>
      ok({
        enabled: true,
        allowed: true,
        machines: [
          machine(TERMINAL_MACHINE, "sdlc-box-01", { fullAccess: true }),
          machine(TERMINAL_BUSY_MACHINE, "sdlc-box-02", { busy: true }),
          machine(TERMINAL_OFFLINE_MACHINE, "sdlc-box-03", { online: false }),
        ],
        defaultModel: "sonnet",
        advisor: null,
        costs: [
          { model: "sonnet", avgRunUsd: 0.42, runs: 31 },
          { model: "opus", avgRunUsd: null, runs: 0 },
        ],
        ...opts.options,
      }),
    "terminal/open": (input) => {
      state.opened.push(input);
      const body = input as { mode: string; model: string; machineId: string };
      state.session = terminalSession({
        ...opts.session,
        mode: body.mode,
        model: body.model,
        machineId: body.machineId,
      });
      state.sessions = [state.session];
      return ok(state.session);
    },
    "terminal/list": () => ok(state.sessions),
    "terminal/get": () => ok(state.session),
    "terminal/ticket": () => {
      state.tickets += 1;
      return ok({ ticket: `ticket-${state.tickets}`, expiresAt: "2026-10-14T01:01:00.000Z", canInput: state.canInput });
    },
    "terminal/activity": () => ok({ proposals: state.proposals, actions: state.actions }),
    "terminal/chunks": (input) => {
      state.chunkCalls.push(input);
      const { after } = input as { after: number };
      return ok({ chunks: chunks.filter((chunk) => chunk.seq > after), more: false });
    },
    "terminal/close": () => {
      state.closed += 1;
      state.session = { ...state.session, state: "closed", endReason: "closed", endedAt: T0 };
      return ok(state.session);
    },
    "terminal/setVisibility": (input) => {
      state.visibility.push(input);
      state.session = { ...state.session, visibility: (input as { visibility: string }).visibility };
      return ok(state.session);
    },
    "leader/approvals/approve": (input) => {
      state.approved.push(input);
      const { id, tier } = input as { id: string; tier?: string };
      state.proposals = state.proposals.map((p) =>
        p.id === id ? { ...p, status: "approved", action: { ...(p.action as object), ...(tier ? { tier } : {}) } } : p,
      );
      return ok({ approval: state.proposals[0], result: { taskKey: "PAY-12" } });
    },
    "leader/approvals/reject": (input) => {
      state.rejected.push(input);
      const { id, reason } = input as { id: string; reason: string };
      state.proposals = state.proposals.map((p) => (p.id === id ? { ...p, status: "rejected", reason } : p));
      return ok(state.proposals[0]);
    },
  };
  return { state, rpc };
}

/**
 * WebSocket `/ws/terminal` giả. Mỗi lần nối là một phần tử của `sockets`: ghi khung trình duyệt gửi (`received`),
 * trả `hello` ngay khi nối, phát `out` cho khung `in` (echo) và `pong` cho `ping`. Test chủ động `send` hoặc `drop`.
 */
export async function fakeTerminalSocket(
  page: Page,
  fixture: ReturnType<typeof terminalFixture>,
  opts: { echo?: boolean } = {},
) {
  type Frame = Record<string, unknown> & { t: string };
  const sockets: { url: string; received: Frame[]; ws: WebSocketRoute; seq: number }[] = [];
  const controller = {
    sockets,
    /** Khung `out` cuối cùng đã phát, để test kiểm `resume`. */
    get last() {
      return sockets[sockets.length - 1];
    },
    send(frame: unknown) {
      controller.last?.ws.send(JSON.stringify(frame));
    },
    out(text: string) {
      const socket = controller.last;
      if (!socket) return;
      socket.ws.send(JSON.stringify({ t: "out", seq: socket.seq, data: b64(text) }));
      socket.seq += 1;
    },
    drop(code = 1006) {
      controller.last?.ws.close({ code, reason: "test" });
    },
    inputs(): string[] {
      return sockets.flatMap((s) => s.received.filter((f) => f.t === "in").map((f) => fromB64(String(f.data))));
    },
  };
  await page.routeWebSocket(/\/ws\/terminal/, (ws) => {
    const socket = { url: ws.url(), received: [] as Frame[], ws, seq: 0 };
    // `seq` tiếp nối giữa các lần nối: hub đánh số trong phiên, không theo kết nối.
    const previous = sockets[sockets.length - 1];
    if (previous) socket.seq = previous.seq;
    sockets.push(socket);
    ws.send(JSON.stringify({ t: "hello", session: fixture.state.session, canInput: fixture.state.canInput }));
    ws.onMessage((raw) => {
      const frame = JSON.parse(String(raw)) as Frame;
      socket.received.push(frame);
      if (frame.t === "ping") ws.send(JSON.stringify({ t: "pong" }));
      if (frame.t === "in" && opts.echo !== false && fixture.state.canInput)
        controller.out(fromB64(String(frame.data)));
    });
  });
  return controller;
}
