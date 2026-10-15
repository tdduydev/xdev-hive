import { execFileSync } from "node:child_process";
import { createHash, type KeyObject, randomUUID, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { Page, Request, WebSocketRoute } from "@playwright/test";
import {
  buildCsp,
  buildFrameDocument,
  buildPublicPage,
  type LibManifest,
  publicPageHeaders,
} from "@xdev-hive/artifacts-runtime";
import { LIB_DIST_DIR, readLibManifest } from "@xdev-hive/artifacts-runtime/node";
import {
  type AgentPolicyInput,
  type ArtifactPublicLink,
  type AuditExportInput,
  agentPolicyInput,
  type CodeDryRunResult,
  DEFAULT_AGENT_POLICY,
  DEFAULT_ORG_ARTIFACT_POLICY,
  defaultProjectSettings,
  orgArtifactPolicy,
  outcomeToCodeWorkflow,
  type ReviewWorkflow,
  reviewPhase,
  SYSTEM_ROLE_PERMISSIONS,
  WORKFLOW_PRESETS,
  type WorkflowInput,
} from "@xdev-hive/contracts";
import {
  challengeBytes,
  deriveInputKey,
  fromBase64url,
  inputMac,
  inputMacPayload,
  PASSKEY_KEY_INFO,
  toBase64url,
} from "@xdev-hive/contracts/terminal-auth";

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
    /** Người đăng nhập; mặc định `USER`. */
    user?: typeof USER;
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
          ? ok(opts.user ?? USER)
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

// ---- Điều khiển từ xa (specs/010): route `remote.*` --------------------------------------------------------------------

export const REMOTE_SESSION_LIVE = "7b7b7b7b-0000-4000-8000-0000000000b1";
export const REMOTE_SESSION_ENDED = "7b7b7b7b-0000-4000-8000-0000000000b2";
export const REMOTE_SESSION_COLLEAGUE = "7b7b7b7b-0000-4000-8000-0000000000b3";

export function remoteSession(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REMOTE_SESSION_ENDED,
    machineId: TERMINAL_MACHINE,
    machineName: "sdlc-box-01",
    ownerId: USER.id,
    ownerName: USER.name,
    isOwner: true,
    origin: "local",
    cli: "claude",
    accountLabel: "Claude Max team",
    cwdLabel: "payment-api/apps/hub",
    projectId: TERMINAL_PROJECT.id,
    projectKey: TERMINAL_PROJECT.key,
    taskId: null,
    taskKey: null,
    state: "closed",
    visibility: "private",
    remote: true,
    controller: null,
    cols: 100,
    rows: 30,
    exitCode: 0,
    endReason: "exit",
    bytes: 12_595,
    createdAt: "2026-10-14T01:00:00.000Z",
    endedAt: "2026-10-14T01:05:00.000Z",
    ...over,
  };
}

/**
 * Phiên tương tác và máy cá nhân (route `remote.*`). Mặc định có một phiên đang chạy gắn việc PAY-12, một phiên đã
 * kết thúc có bản ghi và một phiên của đồng nghiệp (chỉ xem). `pageSize` ép `remote.chunks` trả từng trang nhỏ để thử
 * phát lại theo trang. `pairError` cho `remote.pairComplete` trả lỗi của hub (mã hết hạn, máy của người khác).
 */
export function remoteFixture(
  opts: {
    chunks?: string[];
    pageSize?: number;
    sessions?: Record<string, unknown>[];
    devices?: RemoteDeviceRow[];
    pairError?: Reply;
    revokeError?: Reply;
  } = {},
) {
  const state = {
    sessions: opts.sessions ?? [
      remoteSession({
        id: REMOTE_SESSION_LIVE,
        state: "running",
        exitCode: null,
        endReason: null,
        endedAt: null,
        bytes: 812,
        createdAt: "2026-10-15T01:00:00.000Z",
        taskId: "5a5a5a5a-0000-4000-8000-0000000000b1",
        taskKey: "PAY-12",
        controller: "local",
      }),
      remoteSession(),
      remoteSession({
        id: REMOTE_SESSION_COLLEAGUE,
        ownerId: COLLEAGUE.id,
        ownerName: COLLEAGUE.name,
        isOwner: false,
        visibility: "team",
        machineName: "minh-anh-mac",
        createdAt: "2026-10-12T01:00:00.000Z",
        endedAt: "2026-10-12T01:30:00.000Z",
      }),
    ],
    chunkCalls: [] as { id: string; after: number; limit: number }[],
    devices: opts.devices ?? [
      remoteDevice({ id: "dev-ipad-01", machineId: TERMINAL_MACHINE, label: "iPad của Duy", synced: true }),
      remoteDevice({ id: "dev-pixel-01", machineId: TERMINAL_OFFLINE_MACHINE, label: "Pixel 9", lastUsedAt: null }),
    ],
    pairOptionsCalls: [] as { machineId: string; pairId: string }[],
    pairCalls: [] as Record<string, unknown>[],
    revokeCalls: [] as { machineId: string; deviceId: string }[],
    ticketCalls: 0,
    /** Giả mất mạng: xin vé trả 503 (lỗi tạm) nên trang cứ nối lại theo backoff. */
    offline: false,
  };
  const chunks = (opts.chunks ?? []).map((text, seq) => ({ seq, data: b64(text) }));
  const machine = (id: string, name: string, over: Record<string, unknown> = {}) => ({
    id,
    name,
    online: true,
    terminal: true,
    remote: {
      enabled: true,
      roots: [{ id: "r1", label: "payment-api" }],
      clis: ["claude"],
      accounts: [],
      totp: { enabled: false, locked: false, lockedUntil: null },
      confirmOnMachine: true,
      updatedAt: "2026-10-15T00:00:00.000Z",
    },
    totpAllowed: false,
    sessions: [],
    ...over,
  });
  const rpc = {
    "orgs/mine": () => ok({ orgs: [TERMINAL_ORG], canCreateOrg: false }),
    "remote/machines": () =>
      ok([
        machine(TERMINAL_MACHINE, "sdlc-box-01", {
          sessions: state.sessions.filter((s) => s.machineId === TERMINAL_MACHINE),
        }),
        machine(TERMINAL_BUSY_MACHINE, "tắt-từ-xa", { remote: { ...machine("x", "x").remote, enabled: false } }),
        machine(TERMINAL_OFFLINE_MACHINE, "máy-offline", { online: false }),
      ]),
    "remote/list": (input: unknown) => {
      const { taskId, projectId } = (input ?? {}) as { taskId?: string; projectId?: string };
      return ok(
        state.sessions.filter(
          (s) => (!taskId || s.taskId === taskId) && (!projectId || !s.projectId || s.projectId === projectId),
        ),
      );
    },
    "remote/get": (input: unknown) => {
      const found = state.sessions.find((s) => s.id === (input as { id: string }).id);
      return found ? ok(found) : fail("SESSION_NOT_FOUND", 404, "Không tìm thấy phiên.");
    },
    "remote/chunks": (input: unknown) => {
      const call = input as { id: string; after: number; limit: number };
      state.chunkCalls.push(call);
      const rest = chunks.filter((chunk) => chunk.seq > call.after);
      const size = opts.pageSize ?? call.limit;
      return ok({ chunks: rest.slice(0, size), more: rest.length > size });
    },
    "remote/pairOptions": (input: unknown) => {
      const call = input as { machineId: string; pairId: string };
      state.pairOptionsCalls.push(call);
      return ok({
        machineName: "sdlc-box-01",
        userId: USER.id,
        publicKey: {
          // Trang e2e chạy ở localhost nên rp.id phải là localhost thì trình duyệt mới tạo passkey.
          rp: { id: "localhost", name: "xDev Hive" },
          user: { id: Buffer.from(USER.id).toString("base64url"), name: USER.email, displayName: USER.name },
          challenge: Buffer.alloc(32, 7).toString("base64url"),
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          timeout: 60_000,
          authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
          attestation: "none",
          excludeCredentials: [],
        },
      });
    },
    "remote/pairComplete": (input: unknown) => {
      const call = input as { machineId: string; label: string; synced?: boolean };
      state.pairCalls.push(call as Record<string, unknown>);
      if (opts.pairError) return opts.pairError;
      const device = remoteDevice({
        id: `dev-new-${state.pairCalls.length}`,
        machineId: call.machineId,
        label: call.label,
        synced: call.synced ?? false,
        lastUsedAt: null,
      });
      state.devices.push(device);
      const { machineId: _, ...row } = device;
      return ok(row);
    },
    "remote/ticket": (input: unknown) => {
      state.ticketCalls += 1;
      if (state.offline) return fail("SERVICE_UNAVAILABLE", 503, "Hub tạm thời không phản hồi.");
      const found = state.sessions.find((s) => s.id === (input as { id: string }).id);
      if (!found) return fail("SESSION_NOT_FOUND", 404, "Không tìm thấy phiên.");
      return ok({
        ticket: `r.ticket-${state.ticketCalls}`,
        expiresAt: "2026-10-15T01:01:00.000Z",
        canControl: found.isOwner === true,
      });
    },
    "remote/devices": (input: unknown) => {
      const { machineId } = input as { machineId: string };
      return ok(state.devices.filter((d) => d.machineId === machineId).map(({ machineId: _, ...row }) => row));
    },
    "remote/revokeDevice": (input: unknown) => {
      const call = input as { machineId: string; deviceId: string };
      state.revokeCalls.push(call);
      if (opts.revokeError) return opts.revokeError;
      state.devices = state.devices.filter((d) => d.id !== call.deviceId);
      return ok(call);
    },
  };
  return { state, rpc };
}

/**
 * Hub và worker giả cho WebSocket của phiên trên máy cá nhân (`remoteClientFrame`). Kiểm như worker thật: chữ ký passkey
 * trên đúng challenge (`connId` của kết nối, `deviceId`, người dùng), suy khoá ECDH + HKDF, rồi HMAC và `seq` tăng của
 * từng gói `in`/`resize`. Gói sai thì thu quyền (`input_rejected`) như `remoteauth`. Nối lại bằng `resumeToken` giữ khoá
 * và `seq`. Output đánh số theo phiên và phát lại sau `resume.after`.
 */
export async function fakeRemoteSocket(
  page: Page,
  fixture: ReturnType<typeof remoteFixture>,
  opts: { sessionId: string; deviceId: string; passkey: KeyObject },
) {
  type Frame = Record<string, unknown> & { t: string };
  const worker = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const workerEphPub = toBase64url(new Uint8Array(await crypto.subtle.exportKey("raw", worker.publicKey)));
  const RESUME_TOKEN = "cmVzdW1lLXRva2VuLTE";
  const session = () => fixture.state.sessions.find((s) => s.id === opts.sessionId) ?? {};
  const sockets: { connId: string; received: Frame[]; ws: WebSocketRoute }[] = [];
  const state = {
    outputs: [] as string[],
    inputs: [] as string[],
    resizes: [] as { cols: number; rows: number }[],
    grant: null as { key: CryptoKey; last: number; connId: string } | null,
    rejected: [] as string[],
    controls: 0,
    resumes: [] as Frame[],
  };
  const send = (frame: unknown) => sockets.at(-1)?.ws.send(JSON.stringify(frame));
  const controller = {
    state,
    sockets,
    out(text: string) {
      state.outputs.push(text);
      send({ t: "out", seq: state.outputs.length - 1, data: b64(text) });
    },
    drop(code = 1006) {
      sockets.at(-1)?.ws.close({ code, reason: "test" });
    },
    /** Terminal tại máy (hoặc thiết bị khác) giành quyền. */
    takeOver() {
      state.grant = null;
      send({ t: "revoked", reason: "taken" });
    },
  };

  async function handle(socket: (typeof sockets)[number], frame: Frame): Promise<void> {
    const { ws, connId } = socket;
    if (frame.t === "ping") ws.send(JSON.stringify({ t: "pong" }));
    if (frame.t === "resume") {
      state.resumes.push(frame);
      const after = Number(frame.after);
      state.outputs.forEach((text, seq) => {
        if (seq > after) ws.send(JSON.stringify({ t: "out", seq, data: b64(text) }));
      });
      if (frame.resumeToken !== undefined) {
        if (state.grant && frame.resumeToken === RESUME_TOKEN && frame.deviceId === opts.deviceId) {
          state.grant.connId = connId;
          ws.send(JSON.stringify({ t: "granted", workerEphPub, resumeToken: RESUME_TOKEN }));
        } else {
          ws.send(JSON.stringify({ t: "denied", code: "AUTH_STALE", message: "Phiên xác thực đã hết hạn." }));
        }
      }
    }
    if (frame.t === "control") {
      state.controls += 1;
      const auth = frame.auth as {
        kind: string;
        ephPub: string;
        ts: number;
        nonce: string;
        assertion: { authenticatorData: string; clientDataJSON: string; signature: string };
      };
      const challenge = await challengeBytes({
        machineId: String(session().machineId),
        action: "control",
        params: { userId: USER.id, deviceId: opts.deviceId, sessionId: opts.sessionId, connId },
        ephPub: auth.ephPub,
        ts: auth.ts,
        nonce: auth.nonce,
      });
      const clientData = JSON.parse(Buffer.from(fromBase64url(auth.assertion.clientDataJSON)).toString("utf8")) as {
        challenge: string;
      };
      const signed = Buffer.concat([
        fromBase64url(auth.assertion.authenticatorData),
        createHash("sha256").update(fromBase64url(auth.assertion.clientDataJSON)).digest(),
      ]);
      const valid =
        frame.deviceId === opts.deviceId &&
        clientData.challenge === toBase64url(challenge) &&
        verify("sha256", signed, opts.passkey, fromBase64url(auth.assertion.signature));
      if (!valid) {
        ws.send(JSON.stringify({ t: "denied", code: "ASSERTION_INVALID", message: "Chữ ký passkey không hợp lệ." }));
        return;
      }
      const key = await deriveInputKey(worker.privateKey, auth.ephPub, challenge, PASSKEY_KEY_INFO);
      state.grant = { key, last: 0, connId };
      ws.send(JSON.stringify({ t: "granted", workerEphPub, resumeToken: RESUME_TOKEN }));
    }
    if (frame.t === "release") state.grant = null;
    if (frame.t === "in" || frame.t === "resize") {
      const grant = state.grant;
      // Hub chỉ chuyển gói của kết nối đang giữ quyền.
      if (!grant || grant.connId !== connId) {
        ws.send(JSON.stringify({ t: "error", code: "TERMINAL_READ_ONLY", message: "Bạn chỉ xem phiên này." }));
        return;
      }
      const seq = Number(frame.seq);
      const base = { sessionId: opts.sessionId, connId, seq };
      const payload =
        frame.t === "in"
          ? inputMacPayload({ ...base, kind: "in", data: String(frame.data) })
          : inputMacPayload({ ...base, kind: "resize", cols: Number(frame.cols), rows: Number(frame.rows) });
      if (seq <= grant.last || (await inputMac(grant.key, payload)) !== frame.mac) {
        state.rejected.push(frame.t);
        state.grant = null;
        ws.send(JSON.stringify({ t: "revoked", reason: "input_rejected" }));
        return;
      }
      grant.last = seq;
      if (frame.t === "resize") state.resizes.push({ cols: Number(frame.cols), rows: Number(frame.rows) });
      else {
        const text = fromB64(String(frame.data));
        state.inputs.push(text);
        // CLI giả: in lại chữ gõ được (bỏ ký tự điều khiển) để test thấy trên xterm.
        const printable = [...text].filter((char) => char >= " ").join("");
        if (printable) controller.out(printable);
      }
    }
  }

  await page.routeWebSocket(/\/ws\/terminal/, (ws) => {
    const socket = { connId: `conn-${String(sockets.length + 1).padStart(4, "0")}`, received: [] as Frame[], ws };
    sockets.push(socket);
    ws.send(JSON.stringify({ t: "hello", session: session(), connId: socket.connId, canControl: true }));
    // Xử lý tuần tự như hub: WebCrypto bất đồng bộ không được làm đảo thứ tự gói.
    let queue = Promise.resolve();
    ws.onMessage((raw) => {
      const frame = JSON.parse(String(raw)) as Frame;
      socket.received.push(frame);
      queue = queue.then(() => handle(socket, frame));
    });
  });
  return controller;
}

export interface RemoteDeviceRow {
  id: string;
  machineId: string;
  label: string;
  userId: string;
  synced: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
}

/** Thiết bị đã ghép; `machineId` chỉ để fixture lọc theo máy, hub không trả trường này. */
export function remoteDevice(over: Partial<RemoteDeviceRow> & Pick<RemoteDeviceRow, "id" | "machineId">) {
  return {
    label: "iPhone",
    userId: USER.id,
    synced: false,
    createdAt: "2026-10-01T02:00:00.000Z",
    lastUsedAt: "2026-10-14T09:00:00.000Z",
    ...over,
  };
}

// ---- Artifact (specs/012) ---------------------------------------------------------------------------------------------

export const ARTIFACT_ORG = { id: "0a0a0a0a-0000-4000-8000-0000000000a7", slug: "acme", name: "Acme" };
export const ARTIFACT_PROJECT = { id: "9a9a9a9a-0000-4000-8000-0000000000a7", key: "PAY", name: "payment-api" };
export const ARTIFACT_THREAD_ID = "4d4d4d4d-0000-4000-8000-0000000000a7";
/** Đồng nghiệp cùng dự án: mở artifact được chia sẻ ở một ngữ cảnh trình duyệt khác. */
export const COLLEAGUE = { id: "u2", name: "Lê Minh Anh", email: "anh@example.com", image: null };
const ARTIFACT_RUN_ID = "7c7c7c7c-0000-4000-8000-0000000000a7";

type ArtifactViewer = typeof USER | typeof COLLEAGUE;

interface FakeArtifactVersion {
  version: number;
  content: string | null;
  /** Bản ESM đã biên dịch của `react`, như hub lưu sau `compileReact`. */
  compiled: string | null;
  compileError: string | null;
  name: string | null;
  message: string | null;
  origin: "leader" | "manual";
  authorUser: { id: string; name: string } | null;
  authorRunId: string | null;
  restoredFrom: number | null;
  createdAt: string;
}

export interface FakeArtifact {
  id: string;
  title: string;
  type: "markdown" | "code" | "html" | "mermaid" | "react";
  language: string | null;
  scope: "private" | "project";
  project: typeof ARTIFACT_PROJECT | null;
  ownerId: string;
  deletedAt: string | null;
  createdAt: string;
  versions: FakeArtifactVersion[];
}

type FakeChatMessage = {
  id: string;
  role: "user" | "leader" | "system";
  content: string;
  runId: string | null;
  createdAt: string;
  artifact: { id: string; version: number; title: string; type: FakeArtifact["type"]; deleted: boolean } | null;
  pageErrors: { kind: "error" | "console" | "compile"; message: string }[] | null;
};

type FrameTicket =
  | { kind: "version"; id: string; version: number; theme: "light" | "dark"; publicLinkId?: string }
  | { kind: "preview"; type: FakeArtifact["type"]; content: string; theme: "light" | "dark" };

const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (text: string | null) =>
  createHash("sha256")
    .update(text ?? "")
    .digest("hex");
const sizeOf = (text: string | null) => Buffer.byteLength(text ?? "");

/**
 * Hub giả của artifact: state dùng chung giữa nhiều trang (chủ và đồng nghiệp ở hai ngữ cảnh trình duyệt), quyền đọc theo
 * phạm vi như hub (`private` chỉ chủ, `project` thành viên dự án), vé khung trỏ tới phiên bản để route `/_artifact/frame`
 * dựng tài liệu bằng `buildFrameDocument` thật.
 */
export function artifactsFixture() {
  let seq = 0;
  const next = () => ++seq;
  const now = () => new Date(Date.UTC(2026, 9, 14, 8, 0, seq)).toISOString();
  const state = {
    artifacts: [] as FakeArtifact[],
    messages: [] as FakeChatMessage[],
    tickets: new Map<string, FrameTicket>(),
    publicLinks: [] as (ArtifactPublicLink & { tokenSha256: string })[],
    policy: {
      ...structuredClone(DEFAULT_AGENT_POLICY),
      artifacts: structuredClone(DEFAULT_ORG_ARTIFACT_POLICY),
      updatedAt: "2026-10-14T08:00:00.000Z",
      updatedBy: USER.id,
      templateSync: null,
      defaultTemplates: { agents: "", claude: "", mcp: "" },
    },
    publicRequests: [] as number[],
    publicLinkRequests: new Map<string, number[]>(),
    // Các test T030 dùng một cuộc trò chuyện; T031 đặt id khác để thử đích mới của người xem.
    fixThreadId: ARTIFACT_THREAD_ID,
    /** Lời "Nhờ Leader sửa" hub đã nhận. */
    fixRequests: [] as unknown[],
    /** Tin người dùng gửi cho leader; test trả lời thay run `leader`. */
    onSend: undefined as ((content: string) => void) | undefined,
  };

  const message = (fields: Partial<FakeChatMessage> & Pick<FakeChatMessage, "role" | "content">) => {
    const m: FakeChatMessage = {
      id: uuid("5e5e5e5e", next()),
      runId: null,
      createdAt: now(),
      artifact: null,
      pageErrors: null,
      ...fields,
    };
    state.messages.push(m);
    return m;
  };

  const canRead = (a: FakeArtifact, viewer: ArtifactViewer) => a.ownerId === viewer.id || a.scope === "project";
  const access = (a: FakeArtifact, viewer: ArtifactViewer) => {
    const owner = a.ownerId === viewer.id;
    return { write: owner || a.scope === "project", manage: owner, owner };
  };
  const ownerOf = (a: FakeArtifact) => (a.ownerId === USER.id ? USER : COLLEAGUE);
  const latestOf = (a: FakeArtifact) => a.versions[a.versions.length - 1] as FakeArtifactVersion;
  const summary = (a: FakeArtifact) => ({
    id: a.id,
    title: a.title,
    type: a.type,
    language: a.language,
    scope: a.scope,
    teamId: null,
    project: a.project,
    originProjectId: ARTIFACT_PROJECT.id,
    owner: { id: ownerOf(a).id, name: ownerOf(a).name },
    origin: "leader",
    latestVersion: latestOf(a).version,
    sizeBytes: a.versions.reduce((n, v) => n + sizeOf(v.content) + sizeOf(v.compiled), 0),
    duplicatedFrom: null,
    deletedAt: a.deletedAt,
    createdAt: a.createdAt,
    updatedAt: latestOf(a).createdAt,
  });
  const meta = (v: FakeArtifactVersion) => ({
    version: v.version,
    sha256: sha(v.content),
    sizeBytes: sizeOf(v.content),
    authorUser: v.authorUser,
    authorRunId: v.authorRunId,
    origin: v.origin,
    message: v.message,
    name: v.name,
    restoredFrom: v.restoredFrom,
    hasCompileError: v.compileError !== null,
    tombstonedAt: null,
    createdAt: v.createdAt,
  });
  const writeResult = (a: FakeArtifact, v: FakeArtifactVersion) => ({
    artifact: summary(a),
    version: meta(v),
    compileError: v.compileError,
  });

  /** Thêm phiên bản như `artifact_create`/`artifact_update` của run `leader`, kèm tin nhắn thẻ trong cuộc trò chuyện. */
  function leaderSave(input: {
    id?: string;
    type?: FakeArtifact["type"];
    title?: string;
    content: string;
    compiled?: string;
    compileError?: string;
  }): FakeArtifact {
    let a = input.id ? state.artifacts.find((x) => x.id === input.id) : undefined;
    if (!a) {
      a = {
        id: uuid("a1a1a1a1", next()),
        title: input.title ?? "Artifact",
        type: input.type ?? "markdown",
        language: input.type === "code" ? "ts" : null,
        scope: "private",
        project: null,
        ownerId: USER.id,
        deletedAt: null,
        createdAt: now(),
        versions: [],
      };
      state.artifacts.push(a);
    }
    a.versions.push({
      version: a.versions.length + 1,
      content: input.content,
      compiled: input.compiled ?? null,
      compileError: input.compileError ?? null,
      name: null,
      message: null,
      origin: "leader",
      authorUser: null,
      authorRunId: ARTIFACT_RUN_ID,
      restoredFrom: null,
      createdAt: now(),
    });
    const v = latestOf(a);
    message({
      role: "leader",
      content: a.title,
      runId: ARTIFACT_RUN_ID,
      artifact: { id: a.id, version: v.version, title: a.title, type: a.type, deleted: false },
    });
    return a;
  }

  /** Bản mới do người dùng lưu (Sửa, Khôi phục). */
  function userSave(a: FakeArtifact, viewer: ArtifactViewer, fields: Partial<FakeArtifactVersion>) {
    const base = latestOf(a);
    a.versions.push({
      ...base,
      version: base.version + 1,
      name: null,
      message: null,
      origin: "manual",
      authorUser: { id: viewer.id, name: viewer.name },
      authorRunId: null,
      restoredFrom: null,
      createdAt: now(),
      ...fields,
    });
    return latestOf(a);
  }

  const notFound = () => fail("NOT_FOUND", 404, "Không tìm thấy artifact.", { code: "ARTIFACT_NOT_FOUND" });
  const ticketUrl = (ticket: FrameTicket) => {
    const id = randomUUID();
    state.tickets.set(id, ticket);
    return { url: `/_artifact/frame/${id}`, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
  };

  /** Thủ tục `artifacts.*` và Leader tối thiểu cho một người xem. */
  function rpcFor(viewer: ArtifactViewer, role: "member" | "admin" | "owner" = "member"): Record<string, RpcHandler> {
    const find = (id: unknown) => {
      const a = state.artifacts.find((x) => x.id === id);
      return a && canRead(a, viewer) ? a : undefined;
    };
    return {
      "orgs/mine": () =>
        ok({
          orgs: [{ ...ARTIFACT_ORG, role, emailDomain: null, createdAt: "2026-10-01T00:00:00.000Z" }],
          canCreateOrg: false,
        }),
      "projects/list": () => ok([ARTIFACT_PROJECT]),
      "roles/mine": () => ok({ permissions: [...SYSTEM_ROLE_PERMISSIONS[role]] }),
      "inbox/unreadCount": () => ok({ count: 0 }),
      "policies/get": () => ok(state.policy),
      "policies/update": (input) => {
        if (role === "member") return fail("FORBIDDEN", 403, "Bạn không có quyền sửa chính sách.");
        state.policy = {
          ...state.policy,
          ...agentPolicyInput.parse(input),
          artifacts: (input as AgentPolicyInput).artifacts
            ? orgArtifactPolicy.parse((input as AgentPolicyInput).artifacts)
            : state.policy.artifacts,
          updatedAt: new Date().toISOString(),
        };
        return ok(state.policy);
      },
      "leader/threads/list": () =>
        ok([
          {
            id: state.fixThreadId,
            projectId: ARTIFACT_PROJECT.id,
            title: "Luồng thanh toán",
            createdAt: "2026-10-14T08:00:00.000Z",
            updatedAt: state.messages.at(-1)?.createdAt ?? "2026-10-14T08:00:00.000Z",
          },
        ]),
      "leader/threads/get": () =>
        ok({
          thread: {
            id: state.fixThreadId,
            projectId: ARTIFACT_PROJECT.id,
            title: "Luồng thanh toán",
            createdAt: "2026-10-14T08:00:00.000Z",
            updatedAt: state.messages.at(-1)?.createdAt ?? "2026-10-14T08:00:00.000Z",
          },
          // Thẻ của artifact người xem không đọc được thì như hub: `artifact` null.
          messages: state.messages.map((m) => {
            const a = m.artifact && state.artifacts.find((x) => x.id === m.artifact?.id);
            if (!m.artifact) return m;
            if (!a || !canRead(a, viewer)) return { ...m, artifact: null };
            return { ...m, artifact: { ...m.artifact, deleted: a.deletedAt !== null } };
          }),
        }),
      "leader/threads/send": (input) => {
        const { content } = input as { content: string };
        message({ role: "user", content });
        state.onSend?.(content);
        return ok({ id: state.messages.at(-1)?.id });
      },
      "leader/approvals/list": () => ok([]),
      "terminal/list": () => ok([]),
      "audit/list": () => ok({ items: [], nextCursor: null }),
      "artifacts/settings": () =>
        ok({
          enabled: true,
          types: ["markdown", "code", "html", "mermaid", "react"],
          scopes: ["private", "project"],
          maxVersionBytes: 1_048_576,
          maxVersions: 200,
          publicLinks: state.policy.artifacts.publicLinks,
        }),
      "artifacts/list": (input) => {
        const q = input as { trash?: boolean; type?: string; query?: string; mine?: boolean };
        const items = state.artifacts
          .filter((a) => canRead(a, viewer))
          .filter((a) => (q.trash ? a.deletedAt !== null && a.ownerId === viewer.id : a.deletedAt === null))
          .filter((a) => !q.type || a.type === q.type)
          .filter((a) => !q.mine || a.ownerId === viewer.id)
          .filter((a) => !q.query || a.title.toLocaleLowerCase().includes(q.query.toLocaleLowerCase()))
          .reverse();
        return ok({ items: items.map(summary), nextCursor: null });
      },
      "artifacts/get": (input) => {
        const { id, version } = input as { id: string; version?: number };
        const a = find(id);
        const v = a && (version === undefined ? latestOf(a) : a.versions.find((x) => x.version === Number(version)));
        if (!a || !v) return notFound();
        return ok({
          artifact: summary(a),
          version: { ...meta(v), content: v.content, compileError: v.compileError },
          access: access(a, viewer),
        });
      },
      "artifacts/versions/list": (input) => {
        const a = find((input as { id: string }).id);
        return a ? ok(a.versions.map(meta).reverse()) : notFound();
      },
      "artifacts/versions/rename": (input) => {
        const { id, version, name } = input as { id: string; version: number; name: string | null };
        const v = find(id)?.versions.find((x) => x.version === version);
        if (!v) return notFound();
        v.name = name;
        return ok(meta(v));
      },
      "artifacts/versions/restore": (input) => {
        const { id, version } = input as { id: string; version: number };
        const a = find(id);
        const from = a?.versions.find((x) => x.version === version);
        if (!a || !from) return notFound();
        const v = userSave(a, viewer, {
          content: from.content,
          compiled: from.compiled,
          compileError: from.compileError,
          restoredFrom: from.version,
        });
        return ok(writeResult(a, v));
      },
      "artifacts/update": (input) => {
        const { id, content, baseVersion, message } = input as {
          id: string;
          content: string;
          baseVersion?: number;
          message?: string;
        };
        const a = find(id);
        if (!a) return notFound();
        const latest = latestOf(a);
        if (baseVersion !== undefined && baseVersion !== latest.version)
          return fail("CONFLICT", 409, "Artifact đã có bản mới hơn. Đọc lại rồi sửa.", {
            code: "ARTIFACT_VERSION_CONFLICT",
            latest: { version: latest.version, content: latest.content },
          });
        return ok(writeResult(a, userSave(a, viewer, { content, message: message ?? null })));
      },
      "artifacts/setScope": (input) => {
        const { id, scope, projectKey } = input as { id: string; scope: "private" | "project"; projectKey?: string };
        const a = find(id);
        if (!a) return notFound();
        a.scope = scope;
        a.project = scope === "project" && projectKey === ARTIFACT_PROJECT.key ? ARTIFACT_PROJECT : null;
        return ok(summary(a));
      },
      "artifacts/delete": (input) => {
        const a = find((input as { id: string }).id);
        if (!a) return notFound();
        a.deletedAt = now();
        return ok(summary(a));
      },
      "artifacts/restore": (input) => {
        const a = find((input as { id: string }).id);
        if (!a) return notFound();
        a.deletedAt = null;
        return ok(summary(a));
      },
      "artifacts/links/list": (input) =>
        find((input as { id: string }).id)
          ? ok([
              {
                targetKind: "chat_thread",
                targetId: ARTIFACT_THREAD_ID,
                title: "Luồng thanh toán",
                createdByUserId: null,
                createdByRunId: ARTIFACT_RUN_ID,
                createdAt: "2026-10-14T08:00:00.000Z",
              },
            ])
          : notFound(),
      "artifacts/frameUrl": (input) => {
        const { id, version, theme } = input as { id: string; version: number; theme?: "light" | "dark" };
        const a = find(id);
        if (!a?.versions.some((v) => v.version === Number(version))) return notFound();
        return ok(ticketUrl({ kind: "version", id, version: Number(version), theme: theme ?? "light" }));
      },
      "artifacts/preview": (input) => {
        const { type, content, theme } = input as { type: FakeArtifact["type"]; content: string; theme?: "light" };
        return ok({ ...ticketUrl({ kind: "preview", type, content, theme: theme ?? "light" }), compileError: null });
      },
      "artifacts/askLeaderFix": (input) => {
        const data = input as {
          id: string;
          version: number;
          errors: FakeChatMessage["pageErrors"];
          note?: string;
          threadId?: string;
        };
        const a = find(data.id);
        if (!a) return notFound();
        state.fixRequests.push(data);
        const m = message({
          role: "user",
          content: data.note ?? "Nhờ Leader sửa",
          pageErrors: data.errors,
          artifact: { id: a.id, version: data.version, title: a.title, type: a.type, deleted: false },
        });
        state.onSend?.(m.content);
        return ok({ threadId: data.threadId ?? state.fixThreadId, messageId: m.id, runId: ARTIFACT_RUN_ID });
      },
      "artifacts/publicLinks/create": (input) => {
        const data = input as { id: string; version: number; expiresInDays: number };
        const a = find(data.id);
        if (!a) return notFound();
        if (a.ownerId !== viewer.id) return fail("FORBIDDEN", 403, "Chỉ chủ artifact được tạo link công khai.");
        if (!state.policy.artifacts.publicLinks.enabled) return fail("FORBIDDEN", 403, "Link công khai đang tắt.");
        if (data.expiresInDays < 1 || data.expiresInDays > state.policy.artifacts.publicLinks.maxDays)
          return fail("BAD_REQUEST", 400, "Hạn link vượt chính sách của tổ chức.");
        const token = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
        const link = {
          id: uuid("abababab", next()),
          artifactId: a.id,
          version: data.version,
          createdBy: viewer.id,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + data.expiresInDays * 86_400_000).toISOString(),
          revokedAt: null,
          revokedBy: null,
          revokeReason: null,
          viewCount: 0,
          lastViewedAt: null,
          active: true,
        };
        state.publicLinks.push({ ...link, tokenSha256: sha(token) });
        return ok({ link, url: `/_artifact/s/${token}` });
      },
      "artifacts/publicLinks/list": (input) => {
        const a = state.artifacts.find((x) => x.id === (input as { id: string }).id);
        if (!a || (a.ownerId !== viewer.id && role === "member")) return notFound();
        return ok(state.publicLinks.filter((l) => l.artifactId === a.id).map(({ tokenSha256: _, ...l }) => l));
      },
      "artifacts/publicLinks/revoke": (input) => {
        const link = state.publicLinks.find((l) => l.id === (input as { linkId: string }).linkId);
        const a = state.artifacts.find((x) => x.id === link?.artifactId);
        if (!link || !a || (a.ownerId !== viewer.id && role === "member")) return notFound();
        link.active = false;
        link.revokedAt = new Date().toISOString();
        link.revokedBy = viewer.id;
        link.revokeReason = "manual";
        const { tokenSha256: _, ...result } = link;
        return ok(result);
      },
      "artifacts/publicLinks/orgList": (input) => {
        if (role === "member") return fail("FORBIDDEN", 403, "Chỉ quản trị tổ chức được xem danh sách link.");
        const { cursor, limit = 50 } = input as { cursor?: string; limit?: number };
        const active = state.publicLinks.filter((l) => l.active && Date.parse(l.expiresAt) > Date.now()).reverse();
        const offset = Number(cursor ?? 0);
        const items = active.slice(offset, offset + limit).map(({ tokenSha256: _, ...l }) => {
          const a = state.artifacts.find((x) => x.id === l.artifactId) as FakeArtifact;
          return {
            ...l,
            artifactTitle: a.title,
            artifactType: a.type,
            owner: { id: a.ownerId, name: ownerOf(a).name },
          };
        });
        return ok({ items, nextCursor: offset + limit < active.length ? String(offset + limit) : null });
      },
    };
  }

  return { state, leaderSave, message, rpcFor };
}

export type ArtifactsFixture = ReturnType<typeof artifactsFixture>;

let libManifest: LibManifest | undefined;

/**
 * Bộ thư viện của khung (`artifacts-runtime/dist/lib`). Job e2e của CI không build package, nên dựng ở đây khi thiếu
 * (script tự bỏ qua khi đã dựng đúng phiên bản).
 */
function artifactLib(): LibManifest {
  if (libManifest) return libManifest;
  try {
    libManifest = readLibManifest();
  } catch {
    execFileSync(process.execPath, [join(LIB_DIST_DIR, "..", "..", "scripts", "build-lib.ts")], { stdio: "ignore" });
    libManifest = readLibManifest();
  }
  return libManifest;
}

const LIB_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
};

/**
 * `/_artifact/frame/<vé>` và `/_artifact/lib/*` như hub (T012): tài liệu dựng bằng `buildFrameDocument`, header CSP bằng
 * `buildCsp`, thư viện từ `dist/lib` với CORS `*`. `frameRequests` ghi mọi yêu cầu do khung (không phải trang) gửi đi, để
 * test khẳng định khung không gọi gì ngoài hai đường này (SC-001).
 */
export async function fakeArtifactFrames(page: Page, fixture: ArtifactsFixture) {
  const manifest = artifactLib();
  const frameRequests: string[] = [];
  // Chỉ yêu cầu thật sự ra mạng: Chromium vẫn báo sự kiện `request` cho yêu cầu mà CSP chặn ngay trong trình duyệt.
  const fromFrame = (request: Request) =>
    request.frame() !== page.mainFrame() && !request.url().startsWith("data:") && frameRequests.push(request.url());
  page.on("requestfinished", fromFrame);
  page.on("requestfailed", (request) => {
    // Chromium ghi lý do là "csp" (hoặc mã net::ERR_BLOCKED_BY_CSP ở bản khác).
    if (!/^csp$|ERR_BLOCKED_BY_CSP/.test(request.failure()?.errorText ?? "")) fromFrame(request);
  });
  await page.route("**/_artifact/**", async (route) => {
    const url = new URL(route.request().url());
    const libBase = `${url.origin}/_artifact/lib/`;
    const publicMissing = () =>
      route.fulfill({
        status: 404,
        body: '<!doctype html><html lang="vi"><body>Liên kết không tồn tại hoặc đã hết hạn.</body></html>',
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'",
        },
      });
    const publicActive = (link: ArtifactPublicLink | undefined) => {
      const a = fixture.state.artifacts.find((x) => x.id === link?.artifactId);
      return (
        link?.active &&
        Date.parse(link.expiresAt) > Date.now() &&
        a &&
        !a.deletedAt &&
        a.ownerId === link.createdBy &&
        a.versions.some((v) => v.version === link.version && v.content !== null) &&
        fixture.state.policy.artifacts.enabled &&
        fixture.state.policy.artifacts.publicLinks.enabled
      );
    };
    const limited = (linkId?: string) => {
      const cutoff = Date.now() - 60_000;
      fixture.state.publicRequests = fixture.state.publicRequests.filter((at) => at > cutoff);
      const perLink = linkId ? (fixture.state.publicLinkRequests.get(linkId) ?? []).filter((at) => at > cutoff) : [];
      if (fixture.state.publicRequests.length >= 60 || perLink.length >= 600) return true;
      fixture.state.publicRequests.push(Date.now());
      if (linkId) {
        perLink.push(Date.now());
        fixture.state.publicLinkRequests.set(linkId, perLink);
      }
      return false;
    };
    const tooMany = () =>
      route.fulfill({
        status: 429,
        body: "Quá nhiều yêu cầu. Thử lại sau.",
        headers: { "Retry-After": "60", "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
      });
    if (url.pathname.startsWith("/_artifact/s/")) {
      const link = fixture.state.publicLinks.find(
        (l) => l.tokenSha256 === sha(url.pathname.slice("/_artifact/s/".length)),
      );
      if (limited(link?.id)) return tooMany();
      if (!link || !publicActive(link)) return publicMissing();
      const a = fixture.state.artifacts.find((x) => x.id === link.artifactId) as FakeArtifact;
      const ticket = randomUUID();
      fixture.state.tickets.set(ticket, {
        kind: "version",
        id: a.id,
        version: link.version,
        theme: "light",
        publicLinkId: link.id,
      });
      const frameUrl = `${url.origin}/_artifact/frame/${ticket}`;
      link.viewCount++;
      link.lastViewedAt = new Date().toISOString();
      return route.fulfill({
        status: 200,
        body: buildPublicPage({
          title: a.title,
          type: a.type,
          version: link.version,
          expiresAt: link.expiresAt,
          frameUrl,
        }),
        headers: { ...publicPageHeaders({ frameUrl }), "Content-Type": "text/html; charset=utf-8" },
      });
    }
    const frameHeaders = {
      "Cross-Origin-Resource-Policy": "same-site",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    };
    if (url.pathname.startsWith("/_artifact/lib/")) {
      const file = resolve(LIB_DIST_DIR, `.${decodeURIComponent(url.pathname.slice("/_artifact/lib".length))}`);
      if (!file.startsWith(`${LIB_DIST_DIR}${sep}`) || !existsSync(file)) return route.fulfill({ status: 404 });
      return route.fulfill({
        status: 200,
        body: readFileSync(file),
        headers: {
          "Content-Type": LIB_TYPES[extname(file)] ?? "application/octet-stream",
          "Access-Control-Allow-Origin": "*",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    const ticket = fixture.state.tickets.get(url.pathname.replace(/^\/_artifact\/frame\//, ""));
    if (!ticket) return route.fulfill({ status: 403, body: "Vé khung không hợp lệ.", headers: frameHeaders });
    if (ticket.kind === "version" && ticket.publicLinkId) {
      if (limited(ticket.publicLinkId)) return tooMany();
      if (!publicActive(fixture.state.publicLinks.find((l) => l.id === ticket.publicLinkId))) return publicMissing();
    }
    let input: { type: FakeArtifact["type"]; content: string; compiled: string | null; compileError: string | null };
    if (ticket.kind === "preview") {
      input = { type: ticket.type, content: ticket.content, compiled: null, compileError: null };
    } else {
      const a = fixture.state.artifacts.find((x) => x.id === ticket.id);
      const v = a?.versions.find((x) => x.version === ticket.version);
      if (!a || !v || v.content === null) return route.fulfill({ status: 404, headers: frameHeaders });
      if (a.deletedAt) return route.fulfill({ status: 410, headers: frameHeaders });
      input = { type: a.type, content: v.content, compiled: v.compiled, compileError: v.compileError };
    }
    return route.fulfill({
      status: 200,
      body: buildFrameDocument({ ...input, theme: ticket.theme, manifest, libBase }),
      headers: {
        ...frameHeaders,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": buildCsp({ libBase }),
      },
    });
  });
  return { frameRequests };
}
