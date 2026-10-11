// Dữ liệu cho bảng việc và màn chi tiết run trên web: tasks.list không cần dự án, runs.latest, runs.steer. Gọi qua
// app.request (không cần cổng mạng); không có worker nên run giao ra nằm ở queued.
import { randomBytes, randomUUID } from "node:crypto";
import type { Run, Task } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import { seedProject } from "../test/project-fixture.ts";
import { createApp } from "./app.ts";
import { createAuth } from "./modules/identity/index.ts";
import { createPool, parseMasterKey } from "./modules/platform/index.ts";
import { createRunsEngine, type RunsEngine } from "./modules/runs/index.ts";
import { createMemoryProvider } from "./modules/scm/index.ts";

const { adminUrl, appUrl, authUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const authPool = createPool(authUrl);
// Cùng secret với các file test khác: JWKS của Better Auth nằm chung database và được mã hoá bằng secret này.
const secret = "test-secret-0123456789abcdef-0123456789";
const publicUrl = "http://hub.test";
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

let org: OrgFixture & { user: (n: string) => string };
let projectId = "";
let otherProjectId = "";
let engine: RunsEngine;
let app: ReturnType<typeof createApp>;
let cookie = "";
let devUserId = "";

beforeAll(async () => {
  org = await seedOrg(admin, `board-${tag}`);
  ({ projectId } = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: `bv-${tag}`,
  }));
  ({ projectId: otherProjectId } = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.otherTeamId,
    systemId: org.otherSystemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: `kh-${tag}`,
  }));
  const provider = createMemoryProvider("gitlab", ["xdev-team"]);
  const auth = createAuth({ pool: authPool, baseURL: publicUrl, secret, allowEmailSignUp: true });
  engine = createRunsEngine({
    pool,
    publicUrl,
    authSecret: secret,
    masterKey,
    providerFactory: () => provider,
    logger: quiet,
  });
  app = createApp({ config: { port: 0, version: "test", publicUrl }, auth, pool, runs: engine });

  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Dev", email: `board-${tag}@example.com`, password: "mat-khau-du-dai-123" }),
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
  // Chỉ thuộc đội chính: dự án của đội kia không được lọt vào bảng việc.
  await admin.query("insert into hive.team_members (team_id, org_id, user_id, role) values ($1, $2, $3, 'member')", [
    org.teamId,
    org.orgId,
    devUserId,
  ]);
});

afterAll(async () => {
  engine.stop();
  await Promise.all([admin.end(), pool.end(), authPool.end()]);
});

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { "content-type": "application/json", cookie, "x-hive-org": org.orgId },
    body: body === undefined ? null : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as T };
}

async function newTask(title: string): Promise<Task> {
  const { status, data } = await api<Task>("POST", "/v1/tasks", { projectId, title });
  expect(status).toBe(200);
  return data;
}

/** Run đã xong chèn thẳng bằng superuser; luồng chạy thật đã có test ở runs.db.test.ts. */
async function seedRun(
  task: { id: string; teamId: string; projectId: string },
  opts: { state: string; kind?: string; createdAt: string; parentRunId?: string; machineId?: string },
): Promise<string> {
  const { rows } = await admin.query(
    `insert into hive.runs (org_id, team_id, task_id, project_id, kind, parent_run_id, state, branch, policy_snapshot,
       created_by, created_at, machine_id)
     values ($1, $2, $3, $4, $5, $6, $7, 'ai/x', '[]', 'seed', $8, $9) returning id`,
    [
      org.orgId,
      task.teamId,
      task.id,
      task.projectId,
      opts.kind ?? "code",
      opts.parentRunId ?? null,
      opts.state,
      opts.createdAt,
      opts.machineId ?? null,
    ],
  );
  return rows[0].id as string;
}

describe("bảng việc", () => {
  it("tasks.list bỏ trống projectId: task của mọi dự án mình thấy, mới nhất trước", async () => {
    const a = await newTask("Việc thứ nhất");
    const b = await newTask("Việc thứ hai");
    const { rows } = await admin.query(
      `insert into hive.tasks (org_id, team_id, project_id, number, key, title, created_by)
       values ($1, $2, $3, 1, 'kh-1', 'Việc của đội khác', 'u') returning id`,
      [org.orgId, org.otherTeamId, otherProjectId],
    );
    const all = await api<Task[]>("GET", "/v1/tasks");
    expect(all.status).toBe(200);
    const ids = all.data.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(ids).not.toContain(rows[0].id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));

    const todo = await api<Task[]>("GET", "/v1/tasks?status=todo");
    expect(todo.data.every((t) => t.status === "todo")).toBe(true);
    // Có projectId thì vẫn kiểm quyền với dự án như trước.
    expect((await api("GET", `/v1/tasks?projectId=${otherProjectId}`)).status).toBe(404);
  });

  it("runs.latest: run code mới nhất của mỗi task kèm tên máy, bỏ run review và run của đội khác", async () => {
    const t1 = await newTask("Có hai run");
    const t2 = await newTask("Có một run");
    await newTask("Chưa có run");
    const machine = await admin.query(
      `insert into hive.machines (org_id, team_id, name, os, version, clis, capacity)
       values ($1, $2, $3, 'linux', '1', '{claude}', 1) returning id`,
      [org.orgId, org.teamId, `may-${tag}`],
    );
    const machineId = machine.rows[0].id as string;
    const older = await seedRun(t1, { state: "failed", createdAt: "2026-10-01T00:00:00Z" });
    const newer = await seedRun(t1, { state: "needs_review", createdAt: "2026-10-02T00:00:00Z", machineId });
    await seedRun(t1, { state: "succeeded", kind: "review", parentRunId: newer, createdAt: "2026-10-03T00:00:00Z" });
    const { status, data: started } = await api<Run>("POST", "/v1/runs", { taskId: t2.id });
    expect(status).toBe(200);
    const { rows } = await admin.query(
      `insert into hive.tasks (org_id, team_id, project_id, number, key, title, created_by)
       values ($1, $2, $3, 2, 'kh-2', 'Đội khác có run', 'u') returning id, team_id as "teamId", project_id as "projectId"`,
      [org.orgId, org.otherTeamId, otherProjectId],
    );
    const hidden = await seedRun(rows[0], { state: "failed", createdAt: "2026-10-04T00:00:00Z" });

    const inProject = await api<Run[]>("GET", `/v1/runs?projectId=${projectId}`);
    expect(inProject.status).toBe(200);
    const byTask = new Map(inProject.data.map((r) => [r.taskId, r.id]));
    expect(byTask.get(t1.id)).toBe(newer);
    expect(byTask.get(t2.id)).toBe(started.id);
    expect(inProject.data.map((r) => r.id)).not.toContain(older);
    expect(inProject.data.find((r) => r.id === newer)?.machineName).toBe(`may-${tag}`);
    expect(inProject.data.find((r) => r.id === started.id)?.machineName).toBeNull();
    // Người không quản trị đội vẫn thấy tên máy ở chi tiết run.
    expect((await api<Run>("GET", `/v1/runs/${newer}`)).data).toMatchObject({ machineId, machineName: `may-${tag}` });

    const all = await api<Run[]>("GET", "/v1/runs");
    expect(all.data.map((r) => r.id)).not.toContain(hidden);
    expect(all.data.every((r) => r.kind === "code")).toBe(true);
    expect((await api("GET", `/v1/runs?projectId=${otherProjectId}`)).status).toBe(404);
  });
});

describe("runs.steer", () => {
  it("run chưa tới máy: ghi chỉ dẫn chờ giao, có audit; run đã huỷ thì không nhận; người xem không gửi được", async () => {
    const task = await newTask("Gửi chỉ dẫn");
    const { data: run } = await api<Run>("POST", "/v1/runs", { taskId: task.id });

    const empty = await api("POST", `/v1/runs/${run.id}/steer`, { input: "   " });
    expect(empty.status).toBe(400);

    const sent = await api<{ status: string }>("POST", `/v1/runs/${run.id}/steer`, { input: "Thêm test cho số âm" });
    expect(sent).toEqual({ status: 200, data: { status: "pending" } });
    const events = await admin.query("select data from hive.run_events where run_id = $1 and type = 'steer'", [run.id]);
    expect(events.rows.map((r) => r.data)).toEqual([
      { input: "Thêm test cho số âm", by: devUserId, delivered: false, sent: false },
    ]);
    const audit = await admin.query(
      "select data from hive.audit_log where action = 'run.steer' and target_id = $1::text",
      [run.id],
    );
    expect(audit.rows.map((r) => r.data)).toEqual([{ status: "pending" }]);

    expect((await api("POST", `/v1/runs/${run.id}/cancel`)).status).toBe(200);
    const late = await api<{ status: string }>("POST", `/v1/runs/${run.id}/steer`, { input: "Muộn rồi" });
    expect(late.data.status).toBe("closing");

    await admin.query("update hive.team_members set role = 'viewer' where team_id = $1 and user_id = $2", [
      org.teamId,
      devUserId,
    ]);
    try {
      expect((await api("POST", `/v1/runs/${run.id}/steer`, { input: "Không được" })).status).toBe(403);
    } finally {
      await admin.query("update hive.team_members set role = 'member' where team_id = $1 and user_id = $2", [
        org.teamId,
        devUserId,
      ]);
    }
  });
});
