// Bộ skill mặc định của Hive (packages/skill-pack): tổ chức mới thấy sẵn, bật/tắt theo tổ chức và dự án, skill cùng tên
// của tổ chức được dùng thay; agent đọc qua skill_list/skill_get, worker lấy qua /api/v1/run/skills. Hub chạy trên
// cổng ngẫu nhiên như mcp-knowledge.db.test.ts vì aud của run token phải khớp baseURL.
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { readManifest } from "@xdev-hive/skill-pack";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import { seedProject } from "../test/project-fixture.ts";
import { createApp } from "./app.ts";
import { createAuth } from "./modules/identity/index.ts";
import { getPackSkill, listSkillPack, saveSkill, setSkillPack } from "./modules/knowledge/index.ts";
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
const manifest = readManifest();
const DEFAULT_ON = manifest.skills.filter((s) => s.defaultOn).map((s) => s.name);

type Org = OrgFixture & { user: (n: string) => string };
let orgA: Org;
let orgB: Org;
const proj = { a: { id: "", key: `sp${tag}a` }, a2: { id: "", key: `sp${tag}c` } };
const runs = { code: { runId: "", taskId: "" }, leader: { runId: "", taskId: "" } };
let engine: RunsEngine;
let server: ReturnType<typeof serve>;
let baseURL = "";
let fetchApp: (req: Request) => Response | Promise<Response> = () => new Response(null, { status: 503 });
const clients: Client[] = [];

const asUser = (o: Org, n: string) => ({ kind: "user" as const, userId: o.user(n) });
const inOrg = <T>(o: Org, n: string, fn: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) =>
  withTenant(pool, { userId: o.user(n), orgId: o.orgId }, fn);
const list = (o: Org, n: string, project?: string) =>
  inOrg(o, n, (tx) => listSkillPack(tx, asUser(o, n), project ? { project } : {}));
const set = (o: Org, n: string, name: string, enabled: boolean | null, project?: string) =>
  inOrg(o, n, (tx) => setSkillPack(tx, asUser(o, n), { name, enabled, ...(project ? { project } : {}) }));
const enabledNames = async (o: Org, n: string, project?: string) =>
  (await list(o, n, project)).skills.filter((s) => s.enabled).map((s) => s.name);

async function seedRun(o: Org, projectId: string, kind: "code" | "leader", n: number) {
  const key = `SP${tag}-${n}`;
  const task =
    kind === "code"
      ? await admin.query(
          `insert into hive.tasks (org_id, team_id, project_id, number, key, title, body, status, created_by)
           values ($1, $2, $3, $4, $5, 'Màn danh sách', 'Mô tả', 'running', $6) returning id`,
          [o.orgId, o.teamId, projectId, n, key, o.user("tmember")],
        )
      : null;
  const taskId = (task?.rows[0].id as string | undefined) ?? null;
  const r = await admin.query(
    `insert into hive.runs (org_id, team_id, task_id, project_id, kind, state, branch, policy_snapshot, created_by)
     values ($1, $2, $3, $4, $5, 'running', $6, '[]'::jsonb, $7) returning id`,
    [o.orgId, o.teamId, taskId, projectId, kind, `ai/${key}`, o.user("tmember")],
  );
  const runId = r.rows[0].id as string;
  return { runId, taskId: taskId ?? runId };
}

function runToken(r: { runId: string; taskId: string }) {
  return signRunToken(runTokenKey(secret), baseURL, {
    runId: r.runId,
    taskId: r.taskId,
    orgId: orgA.orgId,
    attempt: 1,
    ttlSec: 600,
  }).token;
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

const runSkills = (token: string | null, have: string[] = []) =>
  fetch(`${baseURL}/api/v1/run/skills`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ have }),
  });

beforeAll(async () => {
  server = serve({ fetch: (req) => fetchApp(req), port: 0 });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  baseURL = `http://localhost:${(server.address() as AddressInfo).port}`;
  orgA = await seedOrg(admin, `spa-${tag}`);
  orgB = await seedOrg(admin, `spb-${tag}`);
  const project = async (teamId: string, systemId: string, key: string) =>
    (
      await seedProject(admin, pool, {
        orgId: orgA.orgId,
        teamId,
        systemId,
        adminUserId: orgA.user("admin"),
        masterKey,
        key,
      })
    ).projectId;
  proj.a.id = await project(orgA.teamId, orgA.systemId, proj.a.key);
  proj.a2.id = await project(orgA.otherTeamId, orgA.otherSystemId, proj.a2.key);
  runs.code = await seedRun(orgA, proj.a.id, "code", 1);
  runs.leader = await seedRun(orgA, proj.a.id, "leader", 2);
  const auth = createAuth({ pool: authPool, baseURL, secret, allowEmailSignUp: true });
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

describe("bộ skill mặc định theo tổ chức và dự án", () => {
  it("tổ chức mới thấy cả bộ, chỉ nhóm nhỏ bật sẵn, kèm nguồn và giấy phép", async () => {
    const pack = await list(orgB, "tviewer");
    expect(pack.source).toEqual({ repo: "tdduydev/xdev-skills", commit: manifest.source.commit });
    expect(pack.skills).toHaveLength(manifest.skills.length);
    expect(pack.skills.filter((s) => s.enabled).map((s) => s.name)).toEqual(DEFAULT_ON);
    expect(pack.skills.find((s) => s.name === "ui-ux-pro-max")).toMatchObject({
      license: "MIT",
      upstream: { repo: "nextlevelbuilder/ui-ux-pro-max-skill" },
      org: null,
      project: null,
      shadowedBy: null,
    });
    expect(pack.skills.find((s) => s.name === "hive-run-etiquette")?.upstream).toBeNull();
  });

  it("chỉ quản trị tổ chức bật/tắt cho tổ chức; tổ chức khác không bị ảnh hưởng", async () => {
    expect(await errorCode(() => set(orgA, "tadmin", "shadcn", true))).toBe("ORG_ROLE_REQUIRED");
    await set(orgA, "admin", "shadcn", true);
    await set(orgA, "admin", "test-driven-development", false);
    const names = await enabledNames(orgA, "tmember");
    expect(names).toContain("shadcn");
    expect(names).not.toContain("test-driven-development");
    expect(await enabledNames(orgB, "tmember")).toEqual(DEFAULT_ON);
    const { rows } = await admin.query(
      "select action, target_id from hive.audit_log where org_id = $1 and action = 'skill_pack.set'",
      [orgA.orgId],
    );
    expect(rows.map((r) => r.target_id)).toEqual(expect.arrayContaining(["shadcn", "test-driven-development"]));
  });

  it("dự án đặt riêng thắng tổ chức; quản trị đội sở hữu mới được đặt; bỏ đặt riêng thì theo tổ chức", async () => {
    expect(await errorCode(() => set(orgA, "tmember", "shadcn", false, proj.a.key))).toBe("TEAM_ROLE_REQUIRED");
    expect(await errorCode(() => set(orgA, "oadmin", "shadcn", false, proj.a.key))).toBe("PROJECT_NOT_FOUND");
    const off = await set(orgA, "tadmin", "shadcn", false, proj.a.key);
    expect(off).toMatchObject({ org: true, project: false, enabled: false });
    const on = await set(orgA, "tadmin", "test-driven-development", true, proj.a.key);
    expect(on).toMatchObject({ org: false, project: true, enabled: true });
    expect(await enabledNames(orgA, "tmember", proj.a.key)).not.toContain("shadcn");
    expect(await enabledNames(orgA, "oadmin", proj.a2.key)).toContain("shadcn");
    const reset = await set(orgA, "tadmin", "shadcn", null, proj.a.key);
    expect(reset).toMatchObject({ org: true, project: null, enabled: true });
  });

  it("skill cùng tên của tổ chức hay dự án được dùng thay bản mặc định", async () => {
    await inOrg(orgA, "admin", (tx) =>
      saveSkill(tx, asUser(orgA, "admin"), {
        scope: { level: "org" },
        name: "systematic-debugging",
        description: "Gỡ lỗi theo cách của tổ chức",
        content: "# Gỡ lỗi\nCách của tổ chức.",
        baseVersion: 0,
      }),
    );
    await inOrg(orgA, "tadmin", (tx) =>
      saveSkill(tx, asUser(orgA, "tadmin"), {
        scope: { level: "project", projectId: proj.a.id },
        name: "vietnamese-ui-copy",
        description: "Chữ giao diện của dự án",
        content: "# Chữ giao diện\nTheo từ điển của dự án.",
        baseVersion: 0,
      }),
    );
    const org = (await list(orgA, "tmember")).skills;
    expect(org.find((s) => s.name === "systematic-debugging")?.shadowedBy).toBe("org");
    expect(org.find((s) => s.name === "vietnamese-ui-copy")?.shadowedBy).toBeNull();
    const inProject = (await list(orgA, "tmember", proj.a.key)).skills;
    expect(inProject.find((s) => s.name === "vietnamese-ui-copy")?.shadowedBy).toBe("project");
  });

  it("đọc SKILL.md và danh sách file; tên lạ báo không tìm thấy", async () => {
    const s = await inOrg(orgB, "tviewer", (tx) => getPackSkill(tx, asUser(orgB, "tviewer"), { name: "shadcn" }));
    expect(s.content).toMatch(/^---\nname: shadcn\n/);
    expect(s.paths).toEqual(expect.arrayContaining(["SKILL.md", "LICENSE.md", "SOURCE.md", "rules/forms.md"]));
    expect(await errorCode(() => set(orgA, "admin", "khong-co", true))).toBe("SKILL_NOT_FOUND");
  });
});

describe("agent và worker", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect(runToken(runs.code));
  });

  it("skill_list có skill mặc định đang bật của dự án (scope hive); bản bị che vào hidden", async () => {
    const res = (await call(client, "skill_list", { limit: 50 })).json();
    const hive = res.skills.filter((s: { scope: string }) => s.scope === "hive").map((s: { name: string }) => s.name);
    // Tổ chức tắt TDD nhưng dự án bật lại; shadcn bật ở tổ chức; hai skill bị skill của tổ chức/dự án che.
    expect(hive).toEqual(
      expect.arrayContaining(["ui-ux-pro-max", "web-design-guidelines", "test-driven-development", "shadcn"]),
    );
    expect(hive).not.toContain("systematic-debugging");
    expect(hive).not.toContain("vietnamese-ui-copy");
    expect(hive).not.toContain("brainstorming");
    const names = res.skills.map((s: { name: string; scope: string }) => `${s.scope}:${s.name}`);
    expect(names).toEqual(expect.arrayContaining(["org:systematic-debugging", "project:vietnamese-ui-copy"]));
    expect(res.hidden.map((s: { scope: string; name: string }) => `${s.scope}:${s.name}`)).toEqual(
      expect.arrayContaining(["hive:systematic-debugging", "hive:vietnamese-ui-copy"]),
    );
    expect(res.skills.find((s: { name: string }) => s.name === "shadcn")).toMatchObject({ license: "MIT", version: 1 });
  });

  it("skill_get trả SKILL.md, danh sách file và đọc được file kèm theo", async () => {
    const first = (await call(client, "skill_get", { name: "web-design-guidelines" })).json();
    expect(first).toMatchObject({ scope: "hive", license: "MIT", offset: 0 });
    expect(first.content).toContain("command.md");
    expect(first.files).toEqual(expect.arrayContaining(["SKILL.md", "command.md", "LICENSE", "SOURCE.md"]));
    const file = (await call(client, "skill_get", { name: "web-design-guidelines", file: "command.md" })).json();
    expect(file).toMatchObject({ scope: "hive", file: "command.md" });
    expect(file.content.length).toBeGreaterThan(100);
    expect((await call(client, "skill_get", { name: "web-design-guidelines", file: "../x" })).isError).toBe(true);
    // Bản của tổ chức thắng bản mặc định; skill đang tắt không đọc được.
    const own = (await call(client, "skill_get", { name: "systematic-debugging" })).json();
    expect(own).toMatchObject({ scope: "org", content: "# Gỡ lỗi\nCách của tổ chức." });
    expect((await call(client, "skill_get", { name: "brainstorming" })).isError).toBe(true);
  });

  it("/api/v1/run/skills trả skill áp cho dự án, bỏ file của skill worker đã có", async () => {
    expect((await runSkills(null)).status).toBe(401);
    expect((await runSkills("khong-phai-token")).status).toBe(401);
    const res = await runSkills(runToken(runs.code));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: { name: string; hash: string; source: string; files?: any[] }[] };
    const by = new Map(body.skills.map((s) => [s.name, s]));
    expect(by.get("vietnamese-ui-copy")).toMatchObject({ source: "project" });
    expect(by.get("vietnamese-ui-copy")?.files).toEqual([
      { path: "SKILL.md", text: expect.stringContaining("Theo từ điển của dự án.") },
    ]);
    expect(by.get("systematic-debugging")?.source).toBe("org");
    const uiux = by.get("ui-ux-pro-max");
    expect(uiux).toMatchObject({ source: "hive", hash: manifest.skills.find((s) => s.name === "ui-ux-pro-max")?.hash });
    expect(uiux?.files?.length).toBe(manifest.skills.find((s) => s.name === "ui-ux-pro-max")?.files);
    expect(by.has("brainstorming")).toBe(false);
    const again = (await (await runSkills(runToken(runs.code), [uiux?.hash ?? ""])).json()) as typeof body;
    expect(again.skills.find((s) => s.name === "ui-ux-pro-max")).not.toHaveProperty("files");
    // Run không sửa code (leader) không nhận skill để chép.
    const leader = (await (await runSkills(runToken(runs.leader))).json()) as typeof body;
    expect(leader.skills).toEqual([]);
  });
});
