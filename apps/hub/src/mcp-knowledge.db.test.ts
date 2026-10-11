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
import { saveDoc, saveSkill, writeMemory } from "./modules/knowledge/index.ts";
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
const BIG = `# Tổng quan\n${"Quy ước dài. ".repeat(1000)}\n## Chi tiết\n${"Ví dụ. ".repeat(1000)}\n# Kết luận\nHẾT`;

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

  it("tools/list chỉ có tool knowledge được phép, tool đọc được đánh dấu readOnly", async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(KNOWLEDGE_TOOLS.filter((n) => n !== "memory_write" && n !== "doc_propose")),
    );
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

  it("run bị từ chối mọi tool ngoài danh sách, kể cả tool ghi knowledge", async () => {
    const before = (await admin.query("select count(*)::int as n from hive.memories where org_id = $1", [orgA.orgId]))
      .rows[0].n;
    for (const name of ["memory_write", "doc_propose", "hive_whoami", "orgs_list", "teams_list", "systems_list"]) {
      await expect(client.callTool({ name, arguments: {} })).rejects.toThrow();
    }
    expect(
      (await admin.query("select count(*)::int as n from hive.memories where org_id = $1", [orgA.orgId])).rows[0].n,
    ).toBe(before);
  });

  it("memory_search mặc định 5 mục, cắt mỗi mục 500 ký tự và báo truncated", async () => {
    for (let i = 0; i < 7; i++) {
      await inOrg(orgA, "tadmin", (tx) =>
        writeMemory(tx, asUser(orgA, "tadmin"), {
          scope: { level: "project", projectId: proj.a.id },
          kind: "note",
          content: `Giớihạn ${i} ${"x".repeat(700)}`,
        }),
      );
    }
    const hits = (await call(client, "memory_search", { query: "Giớihạn" })).json().hits;
    expect(hits).toHaveLength(5);
    for (const hit of hits) {
      expect(hit.content).toHaveLength(500);
      expect(hit.truncated).toBe(true);
    }
    const short = (await call(client, "memory_search", { query: "decimal.js" })).json().hits;
    expect(short[0].truncated).toBe(false);
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

  it("doc_get giới hạn ký tự, trả tiêu đề và đọc tiếp bằng offset hoặc section", async () => {
    const first = (await call(client, "doc_get", { key: "org/dai" })).json();
    expect(first.content).toHaveLength(8000);
    expect(first).toMatchObject({
      offset: 0,
      totalChars: BIG.length,
      nextOffset: 8000,
      truncated: true,
      headings: ["Tổng quan", "Chi tiết", "Kết luận"],
    });
    let content = first.content;
    let next = first.nextOffset;
    while (next !== null) {
      const rest = (await call(client, "doc_get", { key: "org/dai", offset: next })).json();
      content += rest.content;
      next = rest.nextOffset;
    }
    expect(content).toBe(BIG);
    const section = (await call(client, "doc_get", { key: "org/dai", section: "Kết luận" })).json();
    expect(section).toMatchObject({ content: "# Kết luận\nHẾT", truncated: false });
    expect(section).not.toHaveProperty("headings");
    const small = (await call(client, "doc_get", { key: "org/dai", section: "Tổng quan", maxChars: 100 })).json();
    expect(small.content).toHaveLength(100);
    expect(small.totalChars).toBe(BIG.indexOf("# Kết luận"));
    const missing = await call(client, "doc_get", { key: "org/dai", section: "Không có" });
    expect(missing.isError).toBe(true);
    expect((await call(client, "doc_get", { key: "org/dai", maxChars: 40_001 })).isError).toBe(true);
  });

  it("doc_get bỏ heading trong code fence và lấy đến mục cùng cấp tiếp theo", async () => {
    const content = "# Mục thật\n```md\n# Mục giả\n```\n## C#\nNội dung.\n# Mục sau ###\nHết.";
    await inOrg(orgA, "admin", (tx) =>
      saveDoc(tx, asUser(orgA, "admin"), { key: "org/heading", content, baseVersion: 0 }),
    );
    const tiny = (await call(client, "doc_get", { key: "org/heading", maxChars: 1 })).json();
    expect(tiny.headings).toEqual(["Mục thật", "C#", "Mục sau"]);
    const section = (await call(client, "doc_get", { key: "org/heading", section: "Mục thật" })).json();
    expect(section.content).toBe(content.slice(0, content.indexOf("# Mục sau")));
    expect(section.truncated).toBe(false);
  });

  it("doc_list và skill_list áp dụng limit và truncated", async () => {
    const docs = (await call(client, "doc_list", { limit: 1 })).json();
    expect(docs.docs).toHaveLength(1);
    expect(docs.truncated).toBe(true);
    for (let i = 0; i < 12; i++) {
      await inOrg(orgA, "tadmin", (tx) =>
        saveSkill(tx, asUser(orgA, "tadmin"), {
          scope: { level: "project", projectId: proj.a.id },
          name: `gioi-han-${i}`,
          description: "Thử giới hạn",
          content: "x",
          baseVersion: 0,
        }),
      );
    }
    const skills = (await call(client, "skill_list", {})).json();
    expect(skills.skills).toHaveLength(10);
    expect(skills.truncated).toBe(true);
    expect(skills.nextOffset).toBe(10);
    const rest = (await call(client, "skill_list", { offset: skills.nextOffset })).json();
    expect(rest.skills).toHaveLength(3);
    expect(rest.nextOffset).toBeNull();
    const all = (await call(client, "skill_list", { limit: 50 })).json();
    expect(all.skills).toHaveLength(13);
    expect(all.truncated).toBe(false);
    expect([...skills.skills, ...rest.skills]).toEqual(all.skills);
  });

  it("skill_list và skill_get theo dự án của run", async () => {
    const names = (await call(client, "skill_list", { limit: 50 })).json().skills.map((s: { name: string }) => s.name);
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

  it("OAuth vẫn thấy toàn bộ tool knowledge", async () => {
    expect((await member.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(KNOWLEDGE_TOOLS));
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
    expect(names.length).toBeLessThanOrEqual(10);
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
