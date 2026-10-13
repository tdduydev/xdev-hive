// Agent trong run gọi /mcp bằng HIVE_RUN_TOKEN: hub thật trên cổng ngẫu nhiên (issuer và aud phải khớp baseURL),
// run và task chèn thẳng bằng superuser vì luồng giao run đã có test riêng ở runs.db.test.ts.
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";
import { type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import { seedProject } from "../test/project-fixture.ts";
import { createApp } from "./app.ts";
import { type Auth, createAuth } from "./modules/identity/index.ts";
import { createMcpEndpoint, McpToolRegistry } from "./modules/mcp/index.ts";
import { createPool, parseMasterKey } from "./modules/platform/index.ts";
import { createRunsEngine, type RunsEngine, runTokenKey, signRunToken } from "./modules/runs/index.ts";
import { createMemoryProvider } from "./modules/scm/index.ts";

const { adminUrl, appUrl, authUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const authPool = createPool(authUrl);
// Cùng secret với các file test khác: JWKS của Better Auth nằm chung database và được mã hoá bằng secret này.
const secret = "test-secret-0123456789abcdef-0123456789";
const tag = randomUUID().slice(0, 6);
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

let org: OrgFixture & { user: (n: string) => string };
let auth: Auth;
let engine: RunsEngine;
let server: ReturnType<typeof serve>;
let baseURL = "";
let fetchApp: (req: Request) => Response | Promise<Response> = () => new Response(null, { status: 503 });
const clients: Client[] = [];

interface Seeded {
  taskId: string;
  key: string;
  runId: string;
}
const seeded: Record<string, Seeded> = {};

async function seedTaskAndRun(projectId: string, n: number, state = "running"): Promise<Seeded> {
  const key = `MR${tag}-${n}`;
  const task = await admin.query(
    `insert into hive.tasks (org_id, team_id, project_id, number, key, title, body, status, created_by)
     values ($1, $2, $3, $4, $5, $6, 'Mô tả', 'running', $7) returning id`,
    [org.orgId, org.teamId, projectId, n, key, `Task ${n}`, org.user("tmember")],
  );
  const taskId = task.rows[0].id as string;
  const run = await admin.query(
    `insert into hive.runs (org_id, team_id, task_id, project_id, state, branch, policy_snapshot, created_by)
     values ($1, $2, $3, $4, $5, $6, '[]'::jsonb, $7) returning id`,
    [org.orgId, org.teamId, taskId, projectId, state, `ai/${key}`, org.user("tmember")],
  );
  return { taskId, key, runId: run.rows[0].id as string };
}

function tokenFor(s: Seeded, opts: { attempt?: number; ttlSec?: number; now?: number; taskId?: string } = {}) {
  return signRunToken(
    runTokenKey(secret),
    baseURL,
    {
      runId: s.runId,
      taskId: opts.taskId ?? s.taskId,
      orgId: org.orgId,
      attempt: opts.attempt ?? 1,
      ttlSec: opts.ttlSec ?? 600,
    },
    opts.now,
  ).token;
}

async function connect(token: string, path = "/mcp"): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseURL}${path}`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "agent-thu", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

/** Gọi tools/list thô để xem mã HTTP (client MCP chỉ báo lỗi chung chung). */
const rawList = (token: string) =>
  fetch(`${baseURL}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

const text = (result: unknown) => {
  const r = result as { content: { type: string; text: string }[]; isError?: boolean };
  return { isError: r.isError ?? false, text: r.content.map((c) => c.text).join("\n") };
};
const json = (result: unknown) => JSON.parse(text(result).text) as Record<string, unknown>;

beforeAll(async () => {
  server = serve({ fetch: (req) => fetchApp(req), port: 0 });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  baseURL = `http://localhost:${(server.address() as AddressInfo).port}`;

  org = await seedOrg(admin, `mcprun-${tag}`);
  const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
  const { projectId } = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: `MR${tag}`,
  });
  seeded.a = await seedTaskAndRun(projectId, 1);
  seeded.b = await seedTaskAndRun(projectId, 2);
  seeded.done = await seedTaskAndRun(projectId, 3, "succeeded");

  auth = createAuth({ pool: authPool, baseURL, secret, allowEmailSignUp: true });
  const providerFactory = () => createMemoryProvider("gitlab", ["xdev-team"]);
  engine = createRunsEngine({
    pool,
    publicUrl: baseURL,
    authSecret: secret,
    masterKey,
    providerFactory,
    logger: quiet,
  });
  // Không truyền runTokens: app phải tự lấy bộ kiểm run token từ lõi giao run.
  const app = createApp({ config: { port: 0, version: "t", publicUrl: baseURL }, auth, pool, runs: engine });
  // Tool giả để kiểm cơ chế mở quyền theo loại run trước khi module review đăng ký tool thật.
  const registry = new McpToolRegistry();
  registry.register({ name: "task_get", description: "Đọc task.", input: z.object({}), handler: async () => null });
  registry.register({
    name: "review_submit",
    description: "Gửi review.",
    input: z.object({}),
    runKinds: ["review"],
    handler: async () => ({ recorded: true }),
  });
  const reviewEndpoint = createMcpEndpoint({ auth, pool, registry, version: "t", runTokens: engine.mcpRunTokens });
  fetchApp = (req) => (new URL(req.url).pathname === "/mcp-types" ? reviewEndpoint(req) : app.fetch(req));
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  engine?.stop();
  await new Promise((resolve) => server?.close(resolve));
  await Promise.all([admin.end(), pool.end(), authPool.end()]);
});

describe("run token ở /mcp", () => {
  it("tools/list có task_get, task_update", async () => {
    const client = await connect(tokenFor(seeded.a as Seeded));
    const listed = await client.listTools();
    console.log("MCP_LEAN_BYTES", Buffer.byteLength(JSON.stringify(listed)));
    const names = listed.tools.map((t) => t.name);
    expect(names.sort()).toEqual(
      [
        "task_get",
        "task_update",
        "memory_search",
        "memory_write",
        "doc_get",
        "doc_list",
        "skill_get",
        "skill_list",
      ].sort(),
    );
    const bytes = Buffer.byteLength(JSON.stringify(listed));
    // Đo tools/list tại 639cbba trước thay đổi: JSON kết quả client, UTF-8, không kèm envelope JSON-RPC. Run code có
    // thêm memory_write (ADR 0022, ~400 byte) để ghi điều học được thay vì run sau phải khảo sát lại.
    expect(bytes).toBeLessThan(5000);
    expect(bytes).toBeLessThan(11_383 * 0.45);
    expect(listed.tools.every((tool) => !("org" in (tool.inputSchema.properties ?? {})))).toBe(true);
  });

  it("task_get không truyền key trả task và run hiện tại", async () => {
    const a = seeded.a as Seeded;
    const client = await connect(tokenFor(a));
    const got = json(await client.callTool({ name: "task_get", arguments: {} }));
    expect(got).toMatchObject({
      task: { id: a.taskId, key: a.key, title: "Task 1" },
      run: { id: a.runId, state: "running", attempt: 1 },
    });
    const byKey = json(await client.callTool({ name: "task_get", arguments: { key: a.key } }));
    expect(byKey).toMatchObject({ task: { id: a.taskId }, run: { id: a.runId } });
  });

  it("task_get cắt nội dung dài, full lấy đủ nội dung và metadata", async () => {
    const a = seeded.a as Seeded;
    const body = "Ghi chú. ".repeat(1000);
    await admin.query("update hive.tasks set body = $1 where id = $2", [body, a.taskId]);
    const client = await connect(tokenFor(a));
    const compact = json(await client.callTool({ name: "task_get", arguments: {} }));
    expect(compact).toMatchObject({ task: { body: body.slice(0, 2000), truncated: true } });
    expect(compact.task).not.toHaveProperty("source");
    const full = json(await client.callTool({ name: "task_get", arguments: { full: true } }));
    expect(full).toMatchObject({ task: { body, source: {} } });
    await admin.query("update hive.tasks set body = 'Mô tả' where id = $1", [a.taskId]);
  });

  it("review_submit chỉ được list và call khi loại run trong database là review", async () => {
    const a = seeded.a as Seeded;
    const client = await connect(tokenFor(a), "/mcp-types");
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["task_get"]);
    await expect(client.callTool({ name: "review_submit", arguments: {} })).rejects.toThrow();
    await admin.query("update hive.runs set kind = 'review' where id = $1", [a.runId]);
    try {
      const reviewer = await connect(tokenFor(a), "/mcp-types");
      expect((await reviewer.listTools()).tools.map((tool) => tool.name)).toEqual(["task_get", "review_submit"]);
      expect(json(await reviewer.callTool({ name: "review_submit", arguments: {} }))).toEqual({ recorded: true });
    } finally {
      await admin.query("update hive.runs set kind = 'code' where id = $1", [a.runId]);
    }
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["task_get"]);
  });

  it("run không có task (doccheck) dùng được token: thấy doc_check_submit, đọc tri thức của dự án", async () => {
    const a = seeded.a as Seeded;
    const { rows } = await admin.query(
      `insert into hive.runs (org_id, team_id, task_id, project_id, kind, state, branch, policy_snapshot, created_by)
       select org_id, team_id, null, project_id, 'doccheck', 'running', $2, '[]'::jsonb, created_by
       from hive.runs where id = $1 returning id`,
      [a.runId, `doccheck/${tag}`],
    );
    const runId = rows[0].id as string;
    const check: Seeded = { taskId: runId, key: "", runId };
    const client = await connect(tokenFor(check));
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("doc_check_submit");
    const listed = text(await client.callTool({ name: "doc_list", arguments: {} }));
    expect(listed.isError).toBe(false);
    const submitted = text(
      await client.callTool({
        name: "doc_check_submit",
        arguments: { score: 8, checklist: [{ label: "Đủ mục", passed: true }], summary: "Ổn" },
      }),
    );
    expect(submitted.isError).toBe(false);
    const { rows: events } = await admin.query(
      "select count(*)::int as n from hive.run_events where run_id = $1 and type = 'doccheck_result'",
      [runId],
    );
    expect(events[0].n).toBe(1);
    // Token ghép run không có task với task của run khác thì bị từ chối.
    expect((await rawList(tokenFor({ ...check, taskId: a.taskId }))).status).toBe(401);
  });

  it("run trợ lý tài liệu đọc bản nháp, đề xuất, bình luận rồi nộp tóm tắt", async () => {
    const a = seeded.a as Seeded;
    const { rows } = await admin.query(
      `insert into hive.runs (org_id, team_id, task_id, project_id, kind, state, branch, policy_snapshot, created_by)
       select org_id, team_id, null, project_id, 'docassist', 'running', $2, '[]'::jsonb, created_by
       from hive.runs where id = $1 returning id, project_id`,
      [a.runId, `docassist/${tag}`],
    );
    const runId = rows[0].id as string;
    // Key dự án ở fixture có chữ hoa, không hợp lệ trong key tài liệu: dùng id dự án.
    const docKey = `project/${rows[0].project_id}/prd-assist`;
    await admin.query(
      `insert into hive.doc_drafts (org_id, team_id, project_id, key, title, content, base_version, updated_by_user_id)
       select org_id, team_id, id, $2, 'PRD', $3, 0, $4 from hive.projects where id = $1`,
      [rows[0].project_id, docKey, "# PRD\n\nPhí 2%.\n", org.user("admin")],
    );
    const client = await connect(tokenFor({ taskId: runId, key: "", runId }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["doc_draft_get", "doc_suggest", "doc_comment", "doc_assist_submit"]));
    expect(names).not.toContain("doc_check_submit");
    const draft = json(await client.callTool({ name: "doc_draft_get", arguments: { key: docKey } }));
    expect(draft).toMatchObject({ key: docKey, content: "# PRD\n\nPhí 2%.\n" });
    const sug = json(
      await client.callTool({ name: "doc_suggest", arguments: { key: docKey, before: "Phí 2%.", after: "Phí 1%." } }),
    );
    expect(sug).toMatchObject({ status: "pending" });
    const bad = text(
      await client.callTool({ name: "doc_suggest", arguments: { key: docKey, before: "x", after: "y" } }),
    );
    expect(bad.isError).toBe(true);
    json(await client.callTool({ name: "doc_comment", arguments: { key: docKey, quote: "Phí", body: "Theo ai?" } }));
    json(await client.callTool({ name: "doc_assist_submit", arguments: { summary: "Đã góp ý phí." } }));
    const authors = await admin.query(
      `select (select count(*)::int from hive.doc_suggestions where author_run_id = $1) as s,
              (select count(*)::int from hive.doc_comments where author_run_id = $1) as c,
              (select count(*)::int from hive.run_events where run_id = $1 and type = 'docassist_result') as e`,
      [runId],
    );
    expect(authors.rows[0]).toEqual({ s: 1, c: 1, e: 1 });
  });

  it("task_update ghi run_event agent_report cho lần thử hiện tại và audit kèm runId", async () => {
    const a = seeded.a as Seeded;
    const client = await connect(tokenFor(a));
    const res = json(
      await client.callTool({ name: "task_update", arguments: { status: "review", note: "Đã sửa lỗi làm tròn." } }),
    );
    expect(res).toMatchObject({ runId: a.runId, taskId: a.taskId, attempt: 1, recorded: "agent_report" });
    const { rows } = await admin.query(
      "select attempt, seq, data from hive.run_events where run_id = $1 and type = $2",
      [a.runId, "agent_report"],
    );
    expect(rows).toEqual([{ attempt: 1, seq: null, data: { note: "Đã sửa lỗi làm tròn.", status: "review" } }]);
    // Trạng thái task do chính sách kết quả quyết định khi run kết thúc, tool không đổi thẳng.
    const task = await admin.query("select status from hive.tasks where id = $1", [a.taskId]);
    expect(task.rows[0].status).toBe("running");
    const audit = await admin.query(
      "select data from hive.audit_log where org_id = $1 and action = 'mcp.task_update' order by created_at",
      [org.orgId],
    );
    expect(audit.rows.at(-1)?.data).toMatchObject({ via: "run", runId: a.runId });
  });

  it("task_update của run khác chỉ ghi vào run đó, không đụng task của run này", async () => {
    const [a, b] = [seeded.a as Seeded, seeded.b as Seeded];
    const client = await connect(tokenFor(b));
    const res = json(await client.callTool({ name: "task_update", arguments: { note: "Run B báo cáo." } }));
    expect(res).toMatchObject({ runId: b.runId, taskId: b.taskId });
    const { rows } = await admin.query(
      "select run_id from hive.run_events where type = 'agent_report' and data->>'note' = 'Run B báo cáo.'",
    );
    expect(rows.map((r) => r.run_id)).toEqual([b.runId]);
    expect(rows.map((r) => r.run_id)).not.toContain(a.runId);
  });

  it("từ chối token hết hạn, sai chữ ký, ghép run với task khác, attempt cũ, run đã kết thúc", async () => {
    const [a, b] = [seeded.a as Seeded, seeded.b as Seeded];
    const expired = tokenFor(a, { ttlSec: 60, now: Date.now() - 120_000 });
    const forged = signRunToken(runTokenKey("secret-khac-0123456789abcdef-0123456789"), baseURL, {
      runId: a.runId,
      taskId: a.taskId,
      orgId: org.orgId,
      attempt: 1,
      ttlSec: 600,
    }).token;
    const crossed = tokenFor(a, { taskId: b.taskId });
    const oldAttempt = tokenFor(a, { attempt: 2 });
    const finished = tokenFor(seeded.done as Seeded);
    for (const token of [expired, forged, crossed, oldAttempt, finished]) {
      const res = await rawList(token);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/error="invalid_token"/);
    }
  });

  it("run sang lần thử mới thì token của lần thử cũ bị từ chối", async () => {
    const b = seeded.b as Seeded;
    const token = tokenFor(b);
    expect((await rawList(token)).status).toBe(200);
    await admin.query("update hive.runs set attempt = 2 where id = $1", [b.runId]);
    expect((await rawList(token)).status).toBe(401);
    expect((await rawList(tokenFor(b, { attempt: 2 }))).status).toBe(200);
  });

  it("người dùng OAuth đọc được task theo key nhưng không gọi được task_update", async () => {
    const a = seeded.a as Seeded;
    const { baseURL: issuer } = await auth.$context;
    const api = auth.api as unknown as { signJWT: (o: unknown) => Promise<{ token: string }> };
    const { token } = await api.signJWT({
      body: { payload: { sub: org.user("tmember"), aud: `${baseURL}/mcp`, iss: issuer, scope: "openid" } },
    });
    const client = await connect(token);
    const got = json(await client.callTool({ name: "task_get", arguments: { key: a.key } }));
    expect(got).toMatchObject({ task: { id: a.taskId } });
    expect(got).not.toHaveProperty("run");
    const noKey = text(await client.callTool({ name: "task_get", arguments: {} }));
    expect(noKey).toMatchObject({ isError: true, text: expect.stringContaining("key") });
    const upd = text(await client.callTool({ name: "task_update", arguments: { note: "Giả agent." } }));
    expect(upd.isError).toBe(true);
    expect(upd.text).toContain("HIVE_RUN_TOKEN");
  });
});
