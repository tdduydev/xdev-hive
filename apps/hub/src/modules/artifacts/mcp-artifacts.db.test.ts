import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DEFAULT_AGENT_POLICY } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";
import { type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { type Auth, createAuth } from "../identity/index.ts";
import { createMcpEndpoint, type McpPrincipal, McpToolRegistry } from "../mcp/index.ts";
import { createPool, parseMasterKey } from "../platform/index.ts";
import { requireOrgRole, registerMcpTools as tenancyMcpTools } from "../tenancy/index.ts";
import { artifactError } from "./access.ts";
import { provideTerminalHost, provideThreadHost } from "./hooks.ts";
import { registerMcpTools } from "./mcp-tools.ts";

/*
 * T011: bốn tool `artifact_*` qua cổng MCP thật (JSON-RPC, withTenant, audit) với run `leader`/`code`/`plan`/`doccheck`,
 * người dùng PAT và Terminal Leader. ThreadHost và TerminalHost là bản giả vì module `leader` cài bản thật ở T013.
 */

const { adminUrl, appUrl, authUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const authPool = createPool(authUrl);
const tag = randomUUID().slice(0, 6);
// Mẫu PAT GitHub giả: đủ dạng để bộ quét bắt, không phải token thật.
const FAKE_TOKEN = `ghp_${"A1b2C3d4".repeat(5)}abcd`;

let org: OrgFixture & { user: (n: string) => string };
let projectId = "";
let otherProjectId = "";
let endpoint: (request: Request) => Promise<Response>;
let auth: Auth;
const registry = new McpToolRegistry();
const principals = new Map<string, McpPrincipal>();
const posted: { threadId: string; artifactId: string; version: number; title: string; runId: string | null }[] = [];
/** Cuộc trò chuyện hợp lệ của từng run `leader` (giả `leader_reply`): threadId → người mở. */
const threads = new Map<string, { runId: string; userId: string }>();
/** Phiên Terminal giả: sessionId → người mở. */
const sessions = new Map<string, string>();

async function seedRun(kind: string, createdBy: string, opts: { task?: boolean; project?: string } = {}) {
  let taskId: string | null = null;
  const project = opts.project ?? projectId;
  if (opts.task) {
    const n = Math.floor(Math.random() * 1e9);
    taskId = (
      await admin.query(
        `insert into hive.tasks (org_id, team_id, project_id, number, key, title, body, status, created_by)
         values ($1, $2, $3, $4, $5, 'Việc thử', 'Mô tả', 'running', $6) returning id`,
        [org.orgId, org.teamId, project, n, `MA${tag}-${n}`, createdBy],
      )
    ).rows[0].id as string;
  }
  const runId = (
    await admin.query(
      `insert into hive.runs (org_id, team_id, task_id, project_id, kind, state, branch, policy_snapshot, created_by)
       values ($1, $2, $3, $4, $5, 'running', $6, '[]'::jsonb, $7) returning id`,
      [org.orgId, org.teamId, taskId, project, kind, `ai/${randomUUID().slice(0, 8)}`, createdBy],
    )
  ).rows[0].id as string;
  const token = `run-${runId}`;
  principals.set(token, {
    kind: "run",
    userId: createdBy,
    orgId: org.orgId,
    runId,
    runKind: kind,
    ...(taskId ? { taskId } : {}),
    projectId: project,
    scopes: [],
  });
  return { runId, taskId, token };
}

/** Mở cuộc trò chuyện giả cho run `leader`: chỉ run đó và người mở được gắn vào. */
function openThread(runId: string, userId: string): string {
  const threadId = randomUUID();
  threads.set(threadId, { runId, userId });
  return threadId;
}

async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await endpoint(
    new Request("https://hive.example.com/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const raw = await res.text();
  const data =
    raw.startsWith("event:") || raw.startsWith("data:")
      ? (raw
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice(5) ?? "{}")
      : raw;
  const body = JSON.parse(data) as { result?: { isError?: boolean; content: { text: string }[] }; error?: unknown };
  const text = body.result?.content.map((c) => c.text).join("\n") ?? JSON.stringify(body.error);
  return {
    isError: body.result ? (body.result.isError ?? false) : true,
    text, // biome-ignore lint/suspicious/noExplicitAny: kết quả tool khác nhau theo từng tool, test tự khẳng định dạng.
    json: () => JSON.parse(text) as Record<string, any>,
  };
}

async function listNames(token: string): Promise<string[]> {
  const res = await endpoint(
    new Request("https://hive.example.com/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
  );
  const raw = await res.text();
  const data =
    raw.startsWith("event:") || raw.startsWith("data:")
      ? (raw
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice(5) ?? "{}")
      : raw;
  return (JSON.parse(data) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
}

/** Token cá nhân chèn thẳng bằng superuser: cổng MCP chỉ cần mã băm khớp (createToken không export khỏi module mcp). */
async function pat(userId: string): Promise<string> {
  const token = `hive_pat_${org.orgId}_${randomBytes(32).toString("base64url")}`;
  await admin.query(
    `insert into hive.mcp_user_tokens (org_id, user_id, token_hash, prefix, client_id, expires_at)
     values ($1, $2, $3, $4, 'cursor', now() + interval '30 days')`,
    [org.orgId, userId, createHash("sha256").update(token).digest("hex"), token.slice(0, 17)],
  );
  return token;
}

const rows = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows;
const ARTIFACT_TOOLS = ["artifact_create", "artifact_update", "artifact_get", "artifact_list"];

beforeAll(async () => {
  org = await seedOrg(admin, `mcpart-${tag}`);
  const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
  const seed = (key: string) =>
    seedProject(admin, pool, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key,
    });
  projectId = (await seed(`mca${tag}`)).projectId;
  otherProjectId = (await seed(`mcb${tag}`)).projectId;
  await admin.query("insert into hive.agent_policies (org_id, policy) values ($1, $2)", [
    org.orgId,
    JSON.stringify({
      ...DEFAULT_AGENT_POLICY,
      artifacts: { scopes: ["private", "project"], runLimits: { artifacts: 2, versions: 100 } },
    }),
  ]);

  tenancyMcpTools(registry);
  registry.provideAuthorization(requireOrgRole);
  registry.register({
    name: "task_get",
    description: "Đọc việc",
    input: z.object({}),
    readOnly: true,
    handler: async () => null,
  });
  registry.register({
    name: "leader_reply",
    description: "Trả lời",
    input: z.object({}),
    runKinds: ["leader"],
    handler: async () => null,
  });
  registerMcpTools(registry, { pool });

  provideThreadHost({
    assertRunThread: async (_tx, runId, threadId) => {
      const thread = threads.get(threadId);
      if (!thread || thread.runId !== runId) throw artifactError("ARTIFACT_LINK_FORBIDDEN");
      return { projectId, userId: thread.userId };
    },
    postArtifactCard: async (_tx, input) => {
      posted.push(input);
    },
    postFixRequest: async () => {
      throw new Error("không dùng ở T011");
    },
  });
  provideTerminalHost({
    assertOwner: async (_tx, sessionId, userId) => {
      if (sessions.get(sessionId) !== userId) throw artifactError("ARTIFACT_LINK_FORBIDDEN");
    },
  });

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
    runTokens: { verify: async (token) => principals.get(token) ?? null },
  });
});

afterAll(async () => {
  provideThreadHost(undefined);
  provideTerminalHost(undefined);
  await Promise.all([admin.end(), pool.end(), authPool.end()]);
});

describe("danh sách tool", () => {
  it("run leader thấy leader_reply cạnh bốn tool artifact; run code thấy RUN_TOOLS; người dùng PAT thấy tool không riêng của leader", async () => {
    const leader = await seedRun("leader", org.user("tmember"));
    const code = await seedRun("code", org.user("tmember"), { task: true });
    expect((await listNames(leader.token)).sort()).toEqual(["leader_reply", ...ARTIFACT_TOOLS].sort());
    expect((await listNames(code.token)).sort()).toEqual(["task_get", ...ARTIFACT_TOOLS].sort());
    const names = await listNames(await pat(org.user("tmember")));
    expect(names).toEqual(expect.arrayContaining(ARTIFACT_TOOLS));
    expect(names).not.toContain("leader_reply");
  });

  it("tool bị quản trị tắt (MCP-04) không hiện và không gọi được", async () => {
    const run = await seedRun("code", org.user("tmember"));
    await admin.query(
      "insert into hive.mcp_tool_overrides (org_id, tool_name, enabled, updated_by) values ($1, 'artifact_create', false, $2)",
      [org.orgId, org.user("admin")],
    );
    try {
      expect(await listNames(run.token)).not.toContain("artifact_create");
      expect(await listNames(run.token)).toContain("artifact_get");
      const denied = await call(run.token, "artifact_create", { type: "markdown", title: "X", content: "x" });
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain("đã bị quản trị tắt");
    } finally {
      await admin.query("delete from hive.mcp_tool_overrides where org_id = $1 and tool_name = 'artifact_create'", [
        org.orgId,
      ]);
    }
  });
});

describe("run leader", () => {
  it("tạo artifact riêng cho người mở cuộc trò chuyện, gắn chat_thread, thêm thẻ và trả url", async () => {
    // Người chạy run (tadmin) khác người mở cuộc trò chuyện (tmember): chủ artifact phải là người mở cuộc trò chuyện.
    const run = await seedRun("leader", org.user("tadmin"));
    const threadId = openThread(run.runId, org.user("tmember"));
    const created = await call(run.token, "artifact_create", {
      type: "markdown",
      title: "Kế hoạch",
      content: "# Bản 1",
      threadId,
    });
    expect(created.isError).toBe(false);
    const out = created.json();
    expect(out).toMatchObject({ version: 1, url: `/artifacts/${out.id}/v/1` });
    expect(out).not.toHaveProperty("compileError");
    const [artifact] = await rows(
      "select owner_user_id, scope, origin, origin_project_id from hive.artifacts where id = $1",
      [out.id],
    );
    expect(artifact).toMatchObject({
      owner_user_id: org.user("tmember"),
      scope: "private",
      origin: "leader",
      origin_project_id: projectId,
    });
    const links = await rows(
      "select target_kind, target_id from hive.artifact_links where artifact_id = $1 order by target_kind",
      [out.id],
    );
    expect(links).toEqual([
      { target_kind: "chat_thread", target_id: threadId },
      { target_kind: "run", target_id: run.runId },
    ]);
    expect(posted.at(-1)).toEqual({ threadId, artifactId: out.id, version: 1, title: "Kế hoạch", runId: run.runId });
  });

  it("threadId của run khác bị từ chối và không tạo artifact", async () => {
    const run = await seedRun("leader", org.user("tmember"));
    const stranger = await seedRun("leader", org.user("tmember"));
    const foreign = openThread(stranger.runId, org.user("tmember"));
    const before = (await rows("select count(*)::int as n from hive.artifacts where org_id = $1", [org.orgId]))[0]
      .n as number;
    const denied = await call(run.token, "artifact_create", {
      type: "markdown",
      title: "X",
      content: "x",
      threadId: foreign,
    });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("Không gắn được artifact");
    expect((await rows("select count(*)::int as n from hive.artifacts where org_id = $1", [org.orgId]))[0].n).toBe(
      before,
    );
  });

  it("run leader sau sửa được artifact liên kết với cuộc trò chuyện khi truyền threadId, không truyền thì không thấy", async () => {
    const first = await seedRun("leader", org.user("tmember"));
    const threadId = openThread(first.runId, org.user("tmember"));
    const { id } = (
      await call(first.token, "artifact_create", { type: "markdown", title: "Tài liệu", content: "v1", threadId })
    ).json();
    // Run mới của cùng cuộc trò chuyện (người dùng nhắn tiếp): cuộc trò chuyện thuộc run mới.
    const second = await seedRun("leader", org.user("tmember"));
    threads.set(threadId, { runId: second.runId, userId: org.user("tmember") });
    const blind = await call(second.token, "artifact_get", { id });
    expect(blind.isError).toBe(true);
    expect(blind.text).toContain("Không tìm thấy artifact");
    const seen = await call(second.token, "artifact_get", { id, threadId });
    expect(seen.json()).toMatchObject({ version: { version: 1, content: "v1" }, access: { write: true } });
    const updated = await call(second.token, "artifact_update", { id, threadId, content: "v2", baseVersion: 1 });
    expect(updated.json()).toMatchObject({ id, version: 2 });
    expect((await call(second.token, "artifact_list", { threadId })).json().items).toHaveLength(1);
  });

  it("duplicateOf nhân bản bản đọc được thành artifact riêng của người mở cuộc trò chuyện, ghi duplicated_from", async () => {
    const author = await seedRun("code", org.user("tmember"));
    const shared = (
      await call(author.token, "artifact_create", {
        type: "markdown",
        title: "Dùng chung",
        content: "gốc",
        scope: "project",
      })
    ).json();
    const run = await seedRun("leader", org.user("tviewer"));
    const threadId = openThread(run.runId, org.user("tviewer"));
    const copy = await call(run.token, "artifact_create", {
      type: "markdown",
      title: "Bản của tôi",
      content: "gốc, đã sửa",
      scope: "project",
      threadId,
      duplicateOf: { id: shared.id, version: 1 },
    });
    expect(copy.isError).toBe(false);
    const [row] = await rows(
      "select owner_user_id, scope, duplicated_from_id, duplicated_from_version from hive.artifacts where id = $1",
      [copy.json().id],
    );
    expect(row).toMatchObject({
      owner_user_id: org.user("tviewer"),
      scope: "private",
      duplicated_from_id: shared.id,
      duplicated_from_version: 1,
    });
    // Bản gốc riêng tư của người khác thì không đọc được nên không nhân bản được.
    const hidden = (
      await call((await seedRun("code", org.user("tmember"))).token, "artifact_create", {
        type: "markdown",
        title: "Riêng",
        content: "kín",
      })
    ).json();
    const denied = await call(run.token, "artifact_create", {
      type: "markdown",
      title: "Lén",
      content: "kín",
      threadId,
      duplicateOf: { id: hidden.id, version: 1 },
    });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("Không tìm thấy artifact");
  });
});

describe("run có task", () => {
  it("run code tạo riêng và theo dự án; gắn run + task; sửa được bản mình tạo; người khác không đọc private", async () => {
    const run = await seedRun("code", org.user("tmember"), { task: true });
    const priv = (
      await call(run.token, "artifact_create", { type: "code", title: "Mã", content: "let a = 1", language: "ts" })
    ).json();
    const proj = (
      await call(run.token, "artifact_create", { type: "html", title: "Trang", content: "<p>hi</p>", scope: "project" })
    ).json();
    const [project] = await rows("select scope, project_id, origin from hive.artifacts where id = $1", [proj.id]);
    expect(project).toMatchObject({ scope: "project", project_id: projectId, origin: "run" });
    const links = await rows("select target_kind from hive.artifact_links where artifact_id = $1 order by 1", [
      priv.id,
    ]);
    expect(links).toEqual([{ target_kind: "run" }, { target_kind: "task" }]);
    expect((await call(run.token, "artifact_update", { id: priv.id, content: "let a = 2" })).json()).toMatchObject({
      version: 2,
    });

    // Người cùng đội (tviewer) đọc được artifact dự án, không đọc được private của tmember.
    const viewer = await seedRun("code", org.user("tviewer"));
    expect((await call(viewer.token, "artifact_get", { id: proj.id })).isError).toBe(false);
    const hidden = await call(viewer.token, "artifact_get", { id: priv.id });
    expect(hidden.isError).toBe(true);
    expect(hidden.text).toContain("Không tìm thấy artifact");
    const listed = (await call(viewer.token, "artifact_list", { origin: "run" })).json().items as { id: string }[];
    expect(listed.map((i) => i.id)).toContain(proj.id);
    expect(listed.map((i) => i.id)).not.toContain(priv.id);
  });

  it("run của dự án khác không đọc artifact dự án này; không tạo được artifact dự án khác", async () => {
    const owner = await seedRun("code", org.user("tmember"));
    const shared = (
      await call(owner.token, "artifact_create", { type: "markdown", title: "Dự án A", content: "a", scope: "project" })
    ).json();
    const otherProject = await seedRun("code", org.user("tmember"), { project: otherProjectId });
    expect((await call(otherProject.token, "artifact_get", { id: shared.id })).isError).toBe(true);
    // Run chỉ viết được vào dự án của chính nó: scope project luôn lấy dự án từ run, không từ tham số.
    const made = (
      await call(otherProject.token, "artifact_create", {
        type: "markdown",
        title: "B",
        content: "b",
        scope: "project",
      })
    ).json();
    const [row] = await rows("select project_id from hive.artifacts where id = $1", [made.id]);
    expect(row.project_id).toBe(otherProjectId);
  });

  it("run plan (chỉ đọc repo) vẫn ghi được artifact", async () => {
    const run = await seedRun("plan", org.user("tmember"), { task: true });
    expect(
      (await call(run.token, "artifact_create", { type: "mermaid", title: "Sơ đồ", content: "graph TD; A-->B" }))
        .isError,
    ).toBe(false);
  });

  it("run doccheck, docassist, brief bị từ chối ở cả bốn tool bằng ARTIFACT_RUN_KIND", async () => {
    for (const kind of ["doccheck", "docassist", "brief"]) {
      const run = await seedRun(kind, org.user("tmember"));
      for (const [name, args] of [
        ["artifact_create", { type: "markdown", title: "X", content: "x" }],
        ["artifact_update", { id: randomUUID(), content: "x" }],
        ["artifact_get", { id: randomUUID() }],
        ["artifact_list", {}],
      ] as const) {
        const denied = await call(run.token, name, args);
        expect(denied.isError, `${kind} ${name}`).toBe(true);
        expect(denied.text).toContain("Loại run này không tạo hay sửa được artifact");
      }
    }
  });

  it("xung đột trả bản mới nhất; sai baseVersion không ghi đè", async () => {
    const run = await seedRun("code", org.user("tmember"));
    const { id } = (
      await call(run.token, "artifact_create", { type: "markdown", title: "Cạnh tranh", content: "v1" })
    ).json();
    expect((await call(run.token, "artifact_update", { id, content: "v2", baseVersion: 1 })).isError).toBe(false);
    const stale = await call(run.token, "artifact_update", { id, content: "v2 khác", baseVersion: 1 });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("Artifact đã ở phiên bản 2");
    expect(stale.text).toContain('"latest":{"version":2,"content":"v2"}');
    expect((await rows("select latest_version from hive.artifacts where id = $1", [id]))[0].latest_version).toBe(2);
  });

  it("giới hạn run: tạo quá số artifact cho phép bị chặn, sửa vẫn được", async () => {
    const run = await seedRun("code", org.user("tmember"));
    const made: string[] = [];
    for (const n of [1, 2]) {
      made.push(
        (await call(run.token, "artifact_create", { type: "markdown", title: `Bản ${n}`, content: "x" })).json().id,
      );
    }
    const over = await call(run.token, "artifact_create", { type: "markdown", title: "Thừa", content: "x" });
    expect(over.isError).toBe(true);
    expect(over.text).toContain("Run đã tạo 2 artifact");
    expect((await call(run.token, "artifact_update", { id: made[0], content: "y" })).isError).toBe(false);
  });

  it("chuỗi giống bí mật bị chặn: không lưu, audit chỉ có dòng và loại", async () => {
    const run = await seedRun("code", org.user("tmember"));
    const before = (await rows("select count(*)::int as n from hive.artifacts where org_id = $1", [org.orgId]))[0]
      .n as number;
    const blocked = await call(run.token, "artifact_create", {
      type: "markdown",
      title: "Có khoá",
      content: `dòng 1\ntoken: ${FAKE_TOKEN}`,
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("dòng 2");
    expect(blocked.text).not.toContain(FAKE_TOKEN);
    expect((await rows("select count(*)::int as n from hive.artifacts where org_id = $1", [org.orgId]))[0].n).toBe(
      before,
    );
    const audit = await rows(
      "select data from hive.audit_log where org_id = $1 and action = 'artifact.secret.blocked'",
      [org.orgId],
    );
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(FAKE_TOKEN);
    expect(audit.at(-1)?.data).toMatchObject({ runId: run.runId });
  });

  it("run tạo artifact react qua bộ biên dịch đã bật ở T014", async () => {
    const run = await seedRun("code", org.user("tmember"));
    const created = await call(run.token, "artifact_create", {
      type: "react",
      title: "R",
      content: "export default () => null",
    });
    expect(created.isError).toBe(false);
    const { id } = JSON.parse(created.text) as { id: string };
    const version = (
      await rows("select compiled, compile_error from hive.artifact_versions where artifact_id = $1", [id])
    )[0];
    expect(version.compiled).toContain("export default");
    expect(version.compile_error).toBeNull();
  });
});

describe("người dùng PAT và Terminal Leader", () => {
  it("tạo artifact riêng (origin mcp), từ chối project và threadId; chỉ đọc artifact của chính mình hoặc trong phạm vi", async () => {
    const token = await pat(org.user("tmember"));
    const made = (await call(token, "artifact_create", { type: "markdown", title: "Của tôi", content: "x" })).json();
    expect((await rows("select owner_user_id, origin, scope from hive.artifacts where id = $1", [made.id]))[0]).toEqual(
      {
        owner_user_id: org.user("tmember"),
        origin: "mcp",
        scope: "private",
      },
    );
    const project = await call(token, "artifact_create", {
      type: "markdown",
      title: "P",
      content: "x",
      scope: "project",
    });
    expect(project.isError).toBe(true);
    const thread = await call(token, "artifact_create", {
      type: "markdown",
      title: "T",
      content: "x",
      threadId: randomUUID(),
    });
    expect(thread.isError).toBe(true);
    expect(thread.text).toContain("Chỉ run leader");
    const other = await pat(org.user("tviewer"));
    expect((await call(other, "artifact_get", { id: made.id })).isError).toBe(true);
    expect(
      (await call(token, "artifact_list", { mine: true })).json().items.map((i: { id: string }) => i.id),
    ).toContain(made.id);
    expect(
      (await call(other, "artifact_list", { mine: true })).json().items.map((i: { id: string }) => i.id),
    ).not.toContain(made.id);
  });

  it("terminalSessionId phải thuộc người gọi: đúng thì gắn terminal_session và origin terminal, sai thì từ chối", async () => {
    const token = await pat(org.user("tmember"));
    const mine = randomUUID();
    sessions.set(mine, org.user("tmember"));
    const made = await call(token, "artifact_create", {
      type: "markdown",
      title: "Từ terminal",
      content: "x",
      terminalSessionId: mine,
    });
    expect(made.isError).toBe(false);
    expect((await rows("select origin from hive.artifacts where id = $1", [made.json().id]))[0].origin).toBe(
      "terminal",
    );
    expect(
      (
        await rows(
          "select target_id from hive.artifact_links where artifact_id = $1 and target_kind = 'terminal_session'",
          [made.json().id],
        )
      )[0].target_id,
    ).toBe(mine);
    const theirs = randomUUID();
    sessions.set(theirs, org.user("tviewer"));
    const denied = await call(token, "artifact_create", {
      type: "markdown",
      title: "Lén",
      content: "x",
      terminalSessionId: theirs,
    });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("Không gắn được artifact");
  });

  it("token của phiên Terminal Leader tự gắn phiên của nó; chế độ Đề xuất vẫn thấy tool artifact", async () => {
    const sessionId = randomUUID();
    principals.set("terminal-bypass", {
      kind: "user",
      userId: org.user("tmember"),
      orgId: org.orgId,
      scopes: [],
      terminal: { sessionId, mode: "bypass", threadId: null, projectId },
    });
    principals.set("terminal-propose", {
      kind: "user",
      userId: org.user("tmember"),
      orgId: org.orgId,
      scopes: [],
      terminal: { sessionId, mode: "propose", threadId: null, projectId },
    });
    // Tool khai readOnly (ghi dữ liệu hub, không ghi repo) nên chế độ Đề xuất vẫn thấy đủ bốn tool.
    expect(await listNames("terminal-propose")).toEqual(expect.arrayContaining(ARTIFACT_TOOLS));
    const made = await call("terminal-bypass", "artifact_create", {
      type: "markdown",
      title: "Terminal",
      content: "x",
    });
    expect(made.isError).toBe(false);
    const [row] = await rows("select origin, origin_project_id from hive.artifacts where id = $1", [made.json().id]);
    expect(row).toEqual({ origin: "terminal", origin_project_id: projectId });
    expect(
      (
        await rows(
          "select target_id from hive.artifact_links where artifact_id = $1 and target_kind = 'terminal_session'",
          [made.json().id],
        )
      )[0].target_id,
    ).toBe(sessionId);
  });
});
