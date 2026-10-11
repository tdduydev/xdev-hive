// runs.search cho màn danh sách lượt chạy: lọc, phân trang bằng con trỏ, chỉ run của đội mình có vai trò.
import { randomBytes, randomUUID } from "node:crypto";
import type { RunSearchResult } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import { seedProject } from "../test/project-fixture.ts";
import { createApp } from "./app.ts";
import { createAuth } from "./modules/identity/index.ts";
import { createPool, parseMasterKey } from "./modules/platform/index.ts";

const { adminUrl, appUrl, authUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const authPool = createPool(authUrl);
// Cùng secret với các file test khác: JWKS của Better Auth nằm chung database và được mã hoá bằng secret này.
const secret = "test-secret-0123456789abcdef-0123456789";
const publicUrl = "http://hub.test";
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
let projectId = "";
let otherProjectId = "";
let app: ReturnType<typeof createApp>;
let cookie = "";
let devUserId = "";

interface Seeded {
  id: string;
  teamId: string;
  projectId: string;
}

const tasks: Record<string, Seeded> = {};
const runIds: Record<string, string> = {};
let machineA = "";
let machineB = "";

async function seedTask(team: string, project: string, n: number, title: string): Promise<Seeded> {
  const { rows } = await admin.query(
    `insert into hive.tasks (org_id, team_id, project_id, number, key, title, created_by)
     values ($1, $2, $3, $4, $5, $6, 'seed') returning id, team_id as "teamId", project_id as "projectId"`,
    [org.orgId, team, project, n, `ts-${n}`, title],
  );
  return rows[0] as Seeded;
}

async function seedRun(
  task: Seeded,
  opts: { state: string; createdAt: string; cli?: string; machineId?: string; kind?: string },
): Promise<string> {
  const { rows } = await admin.query(
    `insert into hive.runs (org_id, team_id, task_id, project_id, kind, state, branch, policy_snapshot, created_by,
       created_at, cli, machine_id)
     values ($1, $2, $3, $4, $5, $6, 'ai/x', '[]', 'seed', $7, $8, $9) returning id`,
    [
      org.orgId,
      task.teamId,
      task.id,
      task.projectId,
      opts.kind ?? "code",
      opts.state,
      opts.createdAt,
      opts.cli ?? null,
      opts.machineId ?? null,
    ],
  );
  return rows[0].id as string;
}

async function seedMachine(team: string, name: string): Promise<string> {
  const { rows } = await admin.query(
    `insert into hive.machines (org_id, team_id, name, os, version, clis, capacity)
     values ($1, $2, $3, 'linux', '1', '{claude,codex}', 1) returning id`,
    [org.orgId, team, name],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  org = await seedOrg(admin, `rs-${tag}`);
  ({ projectId } = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: `rs-${tag}`,
  }));
  ({ projectId: otherProjectId } = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.otherTeamId,
    systemId: org.otherSystemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: `rk-${tag}`,
  }));
  const auth = createAuth({ pool: authPool, baseURL: publicUrl, secret, allowEmailSignUp: true });
  app = createApp({ config: { port: 0, version: "test", publicUrl }, auth, pool });

  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Dev", email: `rs-${tag}@example.com`, password: "mat-khau-du-dai-123" }),
  });
  expect(res.status).toBe(200);
  cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  devUserId = ((await res.json()) as { user: { id: string } }).user.id;
  await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [
    org.orgId,
    devUserId,
  ]);
  // Chỉ là người xem của đội chính: vẫn thấy run; run của đội kia thì không.
  await admin.query("insert into hive.team_members (team_id, org_id, user_id, role) values ($1, $2, $3, 'viewer')", [
    org.teamId,
    org.orgId,
    devUserId,
  ]);

  machineA = await seedMachine(org.teamId, `may-a-${tag}`);
  machineB = await seedMachine(org.teamId, `may-b-${tag}`);
  const hiddenMachine = await seedMachine(org.otherTeamId, `may-an-${tag}`);
  tasks.fix = await seedTask(org.teamId, projectId, 1, "Sửa lỗi đăng nhập");
  tasks.docs = await seedTask(org.teamId, projectId, 2, "Viết tài liệu");
  tasks.other = await seedTask(org.otherTeamId, otherProjectId, 3, "Việc đội khác");
  // Hai run cùng thời điểm để kiểm con trỏ phân biệt bằng id khi created_at trùng nhau.
  runIds.r1 = await seedRun(tasks.fix, {
    state: "failed",
    createdAt: "2026-10-01T00:00:00Z",
    cli: "claude",
    machineId: machineA,
  });
  runIds.r2 = await seedRun(tasks.fix, {
    state: "succeeded",
    createdAt: "2026-10-02T00:00:00Z",
    cli: "codex",
    machineId: machineB,
  });
  runIds.r3 = await seedRun(tasks.docs, {
    state: "running",
    createdAt: "2026-10-03T00:00:00Z",
    cli: "claude",
    machineId: machineA,
  });
  runIds.r4 = await seedRun(tasks.docs, {
    state: "needs_review",
    createdAt: "2026-10-03T00:00:00Z",
    cli: "claude",
    kind: "review",
  });
  runIds.r5 = await seedRun(tasks.fix, {
    state: "lost",
    createdAt: "2026-10-04T00:00:00Z",
    cli: "codex",
    machineId: machineA,
  });
  runIds.hidden = await seedRun(tasks.other, {
    state: "failed",
    createdAt: "2026-10-05T00:00:00Z",
    cli: "claude",
    machineId: hiddenMachine,
  });
});

afterAll(async () => {
  await Promise.all([admin.end(), pool.end(), authPool.end()]);
});

async function search(query = ""): Promise<{ status: number; data: RunSearchResult }> {
  const res = await app.request(`/api/v1/runs/search${query ? `?${query}` : ""}`, {
    headers: { cookie, "x-hive-org": org.orgId },
  });
  return { status: res.status, data: (await res.json()) as RunSearchResult };
}

describe("runs.search", () => {
  it("mới nhất trước, kèm mã và tiêu đề task, máy để lọc; bỏ run của đội khác", async () => {
    const { status, data } = await search();
    expect(status).toBe(200);
    const ids = data.items.map((r) => r.id);
    expect(ids.slice(0, 1)).toEqual([runIds.r5]);
    expect(new Set(ids.slice(1, 3))).toEqual(new Set([runIds.r3, runIds.r4]));
    expect(ids.slice(3)).toEqual([runIds.r2, runIds.r1]);
    expect(data.nextCursor).toBeNull();
    expect(data.items[0]).toMatchObject({
      taskKey: "ts-1",
      taskTitle: "Sửa lỗi đăng nhập",
      machineName: `may-a-${tag}`,
    });
    expect(data.machines).toEqual([
      { id: machineA, name: `may-a-${tag}` },
      { id: machineB, name: `may-b-${tag}` },
    ]);
  });

  it("phân trang bằng con trỏ, không sót hay lặp run tạo cùng lúc", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: { data: RunSearchResult } = await search(`limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...res.data.items.map((r) => r.id));
      if (pages > 0) expect(res.data.machines).toEqual([]);
      cursor = res.data.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).not.toContain(runIds.hidden);
  });

  it.each([
    ["status=failed", ["r5", "r1"]],
    ["status=waiting", ["r4"]],
    ["status=active", ["r3"]],
    ["cli=codex", ["r5", "r2"]],
    ["status=failed&cli=claude", ["r1"]],
  ])("lọc %s", async (query, want) => {
    const { data } = await search(query);
    expect(data.items.map((r) => r.id)).toEqual(want.map((k) => runIds[k]));
  });

  it("lọc theo máy và dự án", async () => {
    expect((await search(`machineId=${machineB}`)).data.items.map((r) => r.id)).toEqual([runIds.r2]);
    expect((await search(`projectId=${projectId}`)).data.items).toHaveLength(5);
    // Dự án của đội mình không có vai trò: báo như không tồn tại.
    expect((await search(`projectId=${otherProjectId}`)).status).toBe(404);
  });

  it("đầu vào sai thì 400", async () => {
    expect((await search("status=xong")).status).toBe(400);
    expect((await search("limit=101")).status).toBe(400);
    expect((await search("cursor=abc")).status).toBe(400);
  });

  it("không thuộc đội nào thì danh sách rỗng", async () => {
    await admin.query("delete from hive.team_members where team_id = $1 and user_id = $2", [org.teamId, devUserId]);
    try {
      const { status, data } = await search();
      expect(status).toBe(200);
      expect(data).toEqual({ items: [], nextCursor: null, machines: [] });
    } finally {
      await admin.query(
        "insert into hive.team_members (team_id, org_id, user_id, role) values ($1, $2, $3, 'viewer')",
        [org.teamId, org.orgId, devUserId],
      );
    }
  });
});
