// Tool knowledge trên cổng /mcp, gọi bằng client MCP thật: agent trong run (run token) và người dùng (token OAuth).
// Hub chạy trên cổng ngẫu nhiên vì issuer và aud của token phải khớp baseURL. Dữ liệu tri thức seed bằng hàm public
// của knowledge; tổ chức, dự án, task, run seed bằng superuser như mcp-run.db.test.ts.
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import { seedProject } from "../test/project-fixture.ts";
import { createApp } from "./app.ts";
import { type Auth, createAuth } from "./modules/identity/index.ts";
import { MCP_LIMITS, saveDoc, saveSkill, writeMemory } from "./modules/knowledge/index.ts";
import { createPool, parseMasterKey, withTenant } from "./modules/platform/index.ts";
import { createRunsEngine, type RunsEngine, runTokenKey, signRunToken } from "./modules/runs/index.ts";
import { createMemoryProvider } from "./modules/scm/index.ts";

const { adminUrl, appUrl, authUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const authPool = createPool(authUrl);
const secret = "test-secret-0123456789abcdef-0123456789";
const tag = randomUUID().slice(0, 6);
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));

type Org = OrgFixture & { user: (n: string) => string; slug: string };
let orgA: Org;
let orgB: Org;
/** Dự án của đội chính (A), dự án của đội kia trong cùng tổ chức (A2), dự án của tổ chức khác (B). */
const proj = { a: { id: "", key: `kn${tag}a` }, a2: { id: "", key: `kn${tag}c` }, b: { id: "", key: `kn${tag}b` } };
let run = { runId: "", taskId: "" };
let auth: Auth;
let engine: RunsEngine;
let server: ReturnType<typeof serve>;
let baseURL = "";
let fetchApp: (req: Request) => Response | Promise<Response> = () => new Response(null, { status: 503 });
const clients: Client[] = [];
const BIG = `${"Quy ước dài. ".repeat(4000)}HẾT`;

async function seedRun(o: Org, projectId: string) {
  const key = `KN${tag}-1`;
  const task = await admin.query(
    `insert into hive.tasks (org_id, team_id, project_id, number, key, title, body, status, created_by)
     values ($1, $2, $3, 1, $4, 'Làm tròn tiền', 'Mô tả', 'running', $5) returning id`,
    [o.orgId, o.teamId, projectId, key, o.user("tmember")],
  );
  const taskId = task.rows[0].id as string;
  const r = await admin.query(
    `insert into hive.runs (org_id, team_id, task_id, project_id, state, branch, policy_snapshot, created_by)
     values ($1, $2, $3, $4, 'running', $5, '[]'::jsonb, $6) returning id`,
    [o.orgId, o.teamId, taskId, projectId, `ai/${key}`, o.user("tmember")],
  );
  return { runId: r.rows[0].id as string, taskId };
}

const asUser = (o: Org, n: string) => ({ kind: "user" as const, userId: o.user(n) });
const inOrg = <T>(o: Org, n: string, fn: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) =>
  withTenant(pool, { userId: o.user(n), orgId: o.orgId }, fn);

async function seedKnowledge() {
  const mem = (o: Org, n: string, projectId: string, content: string) =>
    inOrg(o, n, (tx) =>
      writeMemory(tx, asUser(o, n), { scope: { level: "project", projectId }, kind: "decision", content }),
    );
  await mem(orgA, "tadmin", proj.a.id, "Làm tròn tiền hoá đơn bằng decimal.js, không dùng Number.");
  await mem(orgA, "oadmin", proj.a2.id, "Làm tròn của đội CRM: bí mật đội khác.");
  await mem(orgB, "tadmin", proj.b.id, "Làm tròn của tổ chức B: bí mật tổ chức khác.");
  // Cùng key ở hai tổ chức: mỗi bên chỉ được thấy bản của mình.
  for (const [o, content] of [
    [orgA, "Quy ước của A."],
    [orgB, "Bí mật của B."],
  ] as const) {
    await inOrg(o, "admin", (tx) =>
      saveDoc(tx, asUser(o, "admin"), { key: "org/quy-uoc", content, baseVersion: 0, title: "Quy ước" }),
    );
  }
  await inOrg(orgA, "admin", (tx) =>
    saveDoc(tx, asUser(orgA, "admin"), { key: "org/dai", content: BIG, baseVersion: 0 }),
  );
  await inOrg(orgA, "tadmin", (tx) =>
    saveDoc(tx, asUser(orgA, "tadmin"), {
      key: `project/${proj.a.key}/kien-truc`,
      content: "Kiến trúc A.",
      baseVersion: 0,
    }),
  );
  await inOrg(orgA, "oadmin", (tx) =>
    saveDoc(tx, asUser(orgA, "oadmin"), {
      key: `project/${proj.a2.key}/kien-truc`,
      content: "Của CRM.",
      baseVersion: 0,
    }),
  );
  const skill = (o: Org, n: string, projectId: string, name: string, content: string) =>
    inOrg(o, n, (tx) =>
      saveSkill(tx, asUser(o, n), {
        scope: { level: "project", projectId },
        name,
        description: `Skill ${name}`,
        content,
        baseVersion: 0,
      }),
    );
  await skill(orgA, "tadmin", proj.a.id, "tao-hoa-don", "# Tạo hoá đơn\nCác bước.");
  await skill(orgA, "oadmin", proj.a2.id, "crm-noi-bo", "# CRM");
  await skill(orgB, "tadmin", proj.b.id, "tao-hoa-don", "# Bản của B");
}

function runToken() {
  return signRunToken(runTokenKey(secret), baseURL, {
    runId: run.runId,
    taskId: run.taskId,
    orgId: orgA.orgId,
    attempt: 1,
    ttlSec: 600,
  }).token;
}

async function userToken(userId: string) {
  const { baseURL: issuer } = await auth.$context;
  const api = auth.api as unknown as { signJWT: (o: unknown) => Promise<{ token: string }> };
  const { token } = await api.signJWT({
    body: { payload: { sub: userId, aud: `${baseURL}/mcp`, iss: issuer, scope: "openid" } },
  });
  return token;
}

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "agent-thu", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  const text = r.content.map((c) => c.text).join("\n");
  return { isError: r.isError ?? false, text, json: () => JSON.parse(text) as Record<string, any> };
}

beforeAll(async () => {
  server = serve({ fetch: (req) => fetchApp(req), port: 0 });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  baseURL = `http://localhost:${(server.address() as AddressInfo).port}`;

  const a = await seedOrg(admin, `kmcpa-${tag}`);
  const b = await seedOrg(admin, `kmcpb-${tag}`);
  const slugOf = async (id: string) =>
    (await admin.query("select slug from hive.orgs where id = $1", [id])).rows[0].slug;
  orgA = { ...a, slug: await slugOf(a.orgId) };
  orgB = { ...b, slug: await slugOf(b.orgId) };
  // Thành viên đội của A cũng thuộc tổ chức B (không thuộc đội nào ở B): phải chọn org khi gọi tool.
  await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [
    orgB.orgId,
    orgA.user("tmember"),
  ]);
  const project = async (o: Org, teamId: string, systemId: string, key: string) =>
    (
      await seedProject(admin, pool, {
        orgId: o.orgId,
        teamId,
        systemId,
        adminUserId: o.user("admin"),
        masterKey,
        key,
      })
    ).projectId;
  proj.a.id = await project(orgA, orgA.teamId, orgA.systemId, proj.a.key);
  proj.a2.id = await project(orgA, orgA.otherTeamId, orgA.otherSystemId, proj.a2.key);
  proj.b.id = await project(orgB, orgB.teamId, orgB.systemId, proj.b.key);
  run = await seedRun(orgA, proj.a.id);
  await seedKnowledge();

  auth = createAuth({ pool: authPool, baseURL, secret, allowEmailSignUp: true });
  engine = createRunsEngine({
    pool,
    publicUrl: baseURL,
    authSecret: secret,
    masterKey,
    providerFactory: () => createMemoryProvider("gitlab", ["xdev-team"]),
    logger: quiet,
  });
  const app = createApp({ config: { port: 0, version: "t", publicUrl: baseURL }, auth, pool, runs: engine });
  fetchApp = (req) => app.fetch(req);
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  engine?.stop();
  await new Promise((resolve) => server?.close(resolve));
  await Promise.all([admin.end(), pool.end(), authPool.end()]);
});

const KNOWLEDGE_TOOLS = [
  "memory_search",
  "memory_write",
  "doc_list",
  "doc_get",
  "doc_propose",
  "skill_list",
  "skill_get",
];

describe("tool knowledge với run token", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect(runToken());
  });

  it("tools/list có đủ bảy tool, tool đọc được đánh dấu readOnly", async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(KNOWLEDGE_TOOLS));
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    expect(readOnly).toEqual(
      expect.arrayContaining(["memory_search", "doc_list", "doc_get", "skill_list", "skill_get"]),
    );
    expect(readOnly).not.toContain("memory_write");
    expect(readOnly).not.toContain("doc_propose");
  });

  it("memory_search mặc định tìm trong dự án của run, không thấy đội khác hay tổ chức khác", async () => {
    const res = await call(client, "memory_search", { query: "làm tròn" });
    expect(res.isError).toBe(false);
    const contents = res.json().hits.map((h: { content: string }) => h.content);
    expect(contents).toContain("Làm tròn tiền hoá đơn bằng decimal.js, không dùng Number.");
    expect(contents.join("\n")).not.toContain("bí mật");
  });

  it("memory_search với dự án khác báo không tìm thấy", async () => {
    for (const project of [proj.a2.key, proj.b.id]) {
      const res = await call(client, "memory_search", { project, query: "làm tròn" });
      expect(res).toMatchObject({ isError: true, text: expect.stringContaining("Không tìm thấy dự án") });
    }
  });

  it("memory_write ghi vào dự án của run, tác giả là run, có audit", async () => {
    const res = await call(client, "memory_write", {
      kind: "gotcha",
      content: "Test hoá đơn cần múi giờ Asia/Ho_Chi_Minh.",
      files: ["src/hoa-don.ts"],
    });
    expect(res.isError).toBe(false);
    const { id } = res.json();
    const { rows } = await admin.query(
      "select org_id, project_id, author_user_id, author_run_id, files from hive.memories where id = $1",
      [id],
    );
    expect(rows[0]).toEqual({
      org_id: orgA.orgId,
      project_id: proj.a.id,
      author_user_id: null,
      author_run_id: run.runId,
      files: ["src/hoa-don.ts"],
    });
    const audit = await admin.query(
      "select action, data from hive.audit_log where org_id = $1 and action in ('mcp.memory_write', 'memory.write') and target_id in ($2, 'memory_write')",
      [orgA.orgId, id],
    );
    expect(audit.rows.map((r) => r.action).sort()).toEqual(
      expect.arrayContaining(["mcp.memory_write", "memory.write"]),
    );
    expect(audit.rows.find((r) => r.action === "memory.write")?.data).toMatchObject({ runId: run.runId });
    // Memory vừa ghi tìm được ngay (không cần embedding).
    const found = await call(client, "memory_search", { query: "múi giờ" });
    expect(found.json().hits.map((h: { id: string }) => h.id)).toContain(id);
  });

  it("run không ghi được memory vào dự án khác, kể cả của tổ chức khác hay qua tham số org", async () => {
    const before = (await admin.query("select count(*)::int as n from hive.memories where org_id = $1", [orgA.orgId]))
      .rows[0].n;
    for (const project of [proj.a2.key, proj.a2.id, proj.b.id, proj.b.key]) {
      const res = await call(client, "memory_write", { project, kind: "note", content: "Ghi lén." });
      expect(res).toMatchObject({ isError: true, text: expect.stringContaining("Không tìm thấy dự án") });
    }
    const viaOrg = await call(client, "memory_write", { org: orgB.orgId, kind: "note", content: "Ghi lén." });
    expect(viaOrg.isError).toBe(true);
    const after = (await admin.query("select count(*)::int as n from hive.memories where org_id = $1", [orgA.orgId]))
      .rows[0].n;
    expect(after).toBe(before);
    // Truyền đúng dự án của run vẫn được.
    const own = await call(client, "memory_write", { project: proj.a.key, kind: "note", content: "Ghi đúng chỗ." });
    expect(own.isError).toBe(false);
  });

  it("doc_list chỉ có tài liệu áp dụng cho dự án của run; doc_get trả bản của tổ chức mình", async () => {
    const keys = (await call(client, "doc_list", {})).json().docs.map((d: { key: string }) => d.key);
    expect(keys).toEqual(expect.arrayContaining(["org/quy-uoc", `project/${proj.a.key}/kien-truc`]));
    expect(keys).not.toContain(`project/${proj.a2.key}/kien-truc`);
    const filtered = (await call(client, "doc_list", { prefix: "project/" })).json().docs;
    expect(filtered.map((d: { key: string }) => d.key)).toEqual([`project/${proj.a.key}/kien-truc`]);
    const doc = (await call(client, "doc_get", { key: "org/quy-uoc" })).json();
    expect(doc).toMatchObject({ key: "org/quy-uoc", version: 1, content: "Quy ước của A.", nextOffset: null });
    const other = await call(client, "doc_get", { key: `project/${proj.a2.key}/kien-truc` });
    expect(other).toMatchObject({ isError: true, text: expect.stringContaining("Không tìm thấy") });
  });

  it("doc_get chia trang tài liệu dài", async () => {
    const first = (await call(client, "doc_get", { key: "org/dai" })).json();
    expect(first.content).toHaveLength(MCP_LIMITS.pageChars);
    expect(first).toMatchObject({ offset: 0, totalChars: BIG.length, nextOffset: MCP_LIMITS.pageChars });
    const rest = (await call(client, "doc_get", { key: "org/dai", offset: first.nextOffset })).json();
    expect(rest.nextOffset).toBeNull();
    expect(first.content + rest.content).toBe(BIG);
  });

  it("doc_propose tạo đề xuất chờ duyệt, tác giả là run; baseVersion cũ bị từ chối", async () => {
    const key = `project/${proj.a.key}/kien-truc`;
    const res = await call(client, "doc_propose", {
      key,
      baseVersion: 1,
      content: "Kiến trúc A, thêm phần làm tròn.",
      note: "Bổ sung quyết định làm tròn.",
    });
    expect(res.isError).toBe(false);
    const { proposalId } = res.json();
    const { rows } = await admin.query(
      "select status, reason, author_user_id, author_run_id, project_id from hive.proposals where id = $1",
      [proposalId],
    );
    expect(rows[0]).toEqual({
      status: "pending",
      reason: "Bổ sung quyết định làm tròn.",
      author_user_id: null,
      author_run_id: run.runId,
      project_id: proj.a.id,
    });
    // Tài liệu chưa đổi: agent không sửa trực tiếp.
    expect((await call(client, "doc_get", { key })).json()).toMatchObject({ version: 1, content: "Kiến trúc A." });
    const stale = await call(client, "doc_propose", { key, baseVersion: 0, content: "x", note: "y" });
    expect(stale.isError).toBe(true);
    const otherTeam = await call(client, "doc_propose", {
      key: `project/${proj.a2.key}/kien-truc`,
      baseVersion: 1,
      content: "x",
      note: "y",
    });
    expect(otherTeam).toMatchObject({ isError: true, text: expect.stringContaining("Không tìm thấy") });
  });

  it("skill_list và skill_get theo dự án của run", async () => {
    const names = (await call(client, "skill_list", {})).json().skills.map((s: { name: string }) => s.name);
    expect(names).toContain("tao-hoa-don");
    expect(names).not.toContain("crm-noi-bo");
    const skill = (await call(client, "skill_get", { name: "tao-hoa-don" })).json();
    expect(skill).toMatchObject({ name: "tao-hoa-don", scope: "project", content: "# Tạo hoá đơn\nCác bước." });
    const hidden = await call(client, "skill_get", { name: "crm-noi-bo" });
    expect(hidden.isError).toBe(true);
  });
});

describe("tool knowledge với token người dùng", () => {
  let member: Client;
  beforeAll(async () => {
    member = await connect(await userToken(orgA.user("tmember")));
  });

  it("thuộc hai tổ chức thì phải chọn org", async () => {
    const res = await call(member, "memory_search", { query: "làm tròn" });
    expect(res).toMatchObject({ isError: true, text: expect.stringContaining("nhiều tổ chức") });
  });

  it("memory_search trong tổ chức A chỉ thấy đội của mình; trong B không thấy gì của đội B", async () => {
    const inA = (await call(member, "memory_search", { org: orgA.slug, query: "làm tròn" })).json();
    const textA = inA.hits.map((h: { content: string }) => h.content).join("\n");
    expect(textA).toContain("decimal.js");
    expect(textA).not.toContain("bí mật");
    const inB = (await call(member, "memory_search", { org: orgB.orgId, query: "làm tròn" })).json();
    expect(inB.hits).toEqual([]);
  });

  it("memory_write cần project, tác giả là người dùng", async () => {
    const missing = await call(member, "memory_write", { org: orgA.slug, kind: "note", content: "Thiếu dự án." });
    expect(missing).toMatchObject({ isError: true, text: expect.stringContaining("project") });
    const res = await call(member, "memory_write", {
      org: orgA.slug,
      project: proj.a.key,
      kind: "convention",
      content: "Tên nhánh theo ai/<task>.",
    });
    expect(res.isError).toBe(false);
    const { rows } = await admin.query(
      "select author_user_id, author_run_id, project_id from hive.memories where id = $1",
      [res.json().id],
    );
    expect(rows[0]).toEqual({ author_user_id: orgA.user("tmember"), author_run_id: null, project_id: proj.a.id });
    // Dự án của tổ chức B khi đang làm việc ở A: không thấy.
    const cross = await call(member, "memory_write", {
      org: orgA.slug,
      project: proj.b.id,
      kind: "note",
      content: "x",
    });
    expect(cross.isError).toBe(true);
  });

  it("doc_get cùng key cho bản của tổ chức đã chọn", async () => {
    const a = (await call(member, "doc_get", { org: orgA.slug, key: "org/quy-uoc" })).json();
    const b = (await call(member, "doc_get", { org: orgB.slug, key: "org/quy-uoc" })).json();
    expect(a.content).toBe("Quy ước của A.");
    expect(b.content).toBe("Bí mật của B.");
    const listA = (await call(member, "doc_list", { org: orgA.slug })).json().docs.map((d: { key: string }) => d.key);
    expect(listA).not.toContain(`project/${proj.a2.key}/kien-truc`);
  });

  it("doc_propose, skill_list, skill_get theo dự án truyền vào", async () => {
    const p = await call(member, "doc_propose", {
      org: orgA.slug,
      key: "org/quy-uoc",
      baseVersion: 1,
      content: "Quy ước của A, bản 2.",
      note: "Thêm mục mới.",
    });
    expect(p.isError).toBe(false);
    const { rows } = await admin.query("select author_user_id from hive.proposals where id = $1", [
      p.json().proposalId,
    ]);
    expect(rows[0].author_user_id).toBe(orgA.user("tmember"));
    const names = (await call(member, "skill_list", { org: orgA.slug, project: proj.a.key }))
      .json()
      .skills.map((s: { name: string }) => s.name);
    expect(names).toEqual(["tao-hoa-don"]);
    const skill = (
      await call(member, "skill_get", { org: orgA.slug, name: "tao-hoa-don", project: proj.a.key })
    ).json();
    expect(skill.content).toBe("# Tạo hoá đơn\nCác bước.");
    const inB = await call(member, "skill_get", { org: orgB.slug, name: "tao-hoa-don", project: proj.b.key });
    expect(inB.isError).toBe(true);
  });

  it("người không thuộc tổ chức B không chọn được B", async () => {
    const loner = await connect(await userToken(orgA.user("loner")));
    const res = await call(loner, "doc_get", { org: orgB.slug, key: "org/quy-uoc" });
    expect(res).toMatchObject({ isError: true, text: expect.stringContaining("không phải thành viên") });
  });
});
