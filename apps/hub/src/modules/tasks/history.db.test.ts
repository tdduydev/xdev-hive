import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { ClientEventRejected, createPool, parseMasterKey, withClientEvent, withTenant } from "../platform/index.ts";
import { taskHistory } from "./history.ts";

/* T011 (specs/027 FR-006): lịch sử task gộp lần ghi từ client và trạng thái run, theo giờ hub nhận. */

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
let taskId = "";
let otherTaskId = "";
let runId = "";
let machineId = "";
const key = () => `k${randomUUID().replaceAll("-", "")}`;

async function seedTask(projectId: string, n: number): Promise<string> {
  return (
    await admin.query(
      `insert into hive.tasks (org_id, team_id, project_id, number, key, title, created_by)
       values ($1, $2, $3, $4, $5, 'Task', $6) returning id`,
      [org.orgId, org.teamId, projectId, n, `hist${tag}-${n}`, org.user("tmember")],
    )
  ).rows[0].id as string;
}

beforeAll(async () => {
  org = await seedOrg(admin, `hist-${tag}`);
  const { projectId } = await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: `hist${tag}`,
  });
  taskId = await seedTask(projectId, 1);
  otherTaskId = await seedTask(projectId, 2);
  machineId = (
    await admin.query(
      "insert into hive.machines (org_id, team_id, name, os, version, registered_by) values ($1, $2, 'mac-mini', 'macos', '1', $3) returning id",
      [org.orgId, org.teamId, org.user("tmember")],
    )
  ).rows[0].id as string;
  runId = (
    await admin.query(
      `insert into hive.runs (org_id, team_id, task_id, project_id, state, branch, policy_snapshot, created_by, machine_id)
       values ($1, $2, $3, $4, 'running', $5, '[]'::jsonb, $6, $7) returning id`,
      [org.orgId, org.teamId, taskId, projectId, `ai/hist${tag}-1`, org.user("tmember"), machineId],
    )
  ).rows[0].id as string;
  await admin.query(
    `insert into hive.run_events (org_id, run_id, attempt, type, data, created_at) values
       ($1, $2, 1, 'state', $3, now() - interval '3 minutes'),
       ($1, $2, 1, 'log', '{}', now() - interval '2 minutes')`,
    [org.orgId, runId, JSON.stringify({ from: null, to: "queued", by: org.user("tmember") })],
  );
  const tenant = { userId: org.user("tmember"), orgId: org.orgId };
  const meta = (k: string, target: string) => ({
    key: k,
    source: "mcp-local" as const,
    kind: "task_update",
    userId: org.user("tmember"),
    machineId,
    targetType: "task",
    targetId: target,
    clientCreatedAt: new Date(Date.now() - 10 * 60_000),
  });
  const accepted = key();
  await withClientEvent(app, tenant, meta(accepted, taskId), async () => ({ ok: true }));
  // Gửi lại cùng khoá: không thêm dòng lịch sử.
  await withClientEvent(app, tenant, meta(accepted, taskId), async () => ({ ok: true }));
  await withClientEvent(app, tenant, meta(key(), taskId), async () => {
    throw new ClientEventRejected("TASK_CANCELLED", "Task đã huỷ.");
  });
  await withClientEvent(app, tenant, meta(key(), otherTaskId), async () => ({ ok: true }));
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("tasks.history", () => {
  it("gộp trạng thái run và lần ghi của client, cũ trước", async () => {
    const items = await withTenant(app, { userId: org.user("tmember"), orgId: org.orgId }, (tx) =>
      taskHistory(tx, org.user("tmember"), taskId),
    );
    expect(items.map((i) => [i.kind, i.outcome])).toEqual([
      ["run.queued", "accepted"],
      ["task_update", "accepted"],
      ["task_update", "rejected"],
    ]);
    expect(items[0]).toMatchObject({
      source: "worker-run",
      machine: { id: machineId, name: "mac-mini" },
      actor: { id: org.user("tmember") },
    });
    expect(items[1]).toMatchObject({ source: "mcp-local", clientCreatedAt: expect.any(String), reasonCode: null });
    expect(items[2]).toMatchObject({ reasonCode: "TASK_CANCELLED", reason: "Task đã huỷ." });
  });

  it("người ngoài đội không xem được", async () => {
    const loner = org.user("loner");
    const code = await errorCode(() =>
      withTenant(app, { userId: loner, orgId: org.orgId }, (tx) => taskHistory(tx, loner, taskId)),
    );
    expect(code).toBeTruthy();
  });
});
