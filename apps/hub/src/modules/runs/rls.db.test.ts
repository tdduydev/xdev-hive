import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, pgCode, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, withTenant } from "../platform/index.ts";
import { runEvents, runLeases, runLogs, runs } from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));

type Org = OrgFixture & { user: (n: string) => string };
const seeded: Record<"a" | "b", { org: Org; runId: string; machineId: string }> = {} as never;
const tables = [runs, runEvents, runLogs, runLeases];

/** Seed một run kèm sự kiện, log, lease bằng superuser để test RLS đứng độc lập với lõi giao run. */
async function seed(name: "a" | "b") {
  const org = await seedOrg(admin, `runs-rls-${name}-${randomUUID().slice(0, 6)}`);
  const { projectId } = await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: `rls-${name}`,
  });
  const one = async (q: string, p: unknown[]) => (await admin.query(q, p)).rows[0].id as string;
  const taskId = await one(
    `insert into hive.tasks (org_id, team_id, project_id, number, key, title, created_by)
     values ($1, $2, $3, 1, 'k-1', 't', 'u') returning id`,
    [org.orgId, org.teamId, projectId],
  );
  const runId = await one(
    `insert into hive.runs (org_id, team_id, task_id, project_id, branch, policy_snapshot, created_by, state, machine_id)
     values ($1, $2, $3, $4, 'ai/k-1', '[]', 'u', 'running', null) returning id`,
    [org.orgId, org.teamId, taskId, projectId],
  );
  const machineId = await one(
    "insert into hive.machines (org_id, team_id, name, os, version) values ($1, $2, $3, 'linux', '1') returning id",
    [org.orgId, org.teamId, `m-${name}-${randomUUID().slice(0, 6)}`],
  );
  await admin.query("insert into hive.run_events (org_id, run_id, attempt, seq, type) values ($1, $2, 1, 0, 'phase')", [
    org.orgId,
    runId,
  ]);
  await admin.query(
    "insert into hive.run_logs (org_id, run_id, attempt, seq, \"offset\", data) values ($1, $2, 1, 1, 0, 'x')",
    [org.orgId, runId],
  );
  await admin.query(
    `insert into hive.run_leases (org_id, team_id, run_id, attempt, machine_id, expires_at)
     values ($1, $2, $3, 1, $4, now() + interval '1 minute')`,
    [org.orgId, org.teamId, runId, machineId],
  );
  seeded[name] = { org, runId, machineId };
}

beforeAll(async () => {
  await seed("a");
  await seed("b");
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("RLS bảng runs", () => {
  it("không có context thì cả bốn bảng trả 0 dòng", async () => {
    await withTenant(app, {}, async (tx) => {
      for (const t of tables) expect(await tx.select().from(t)).toHaveLength(0);
    });
  });

  it("context tổ chức A chỉ thấy dữ liệu của A", async () => {
    await withTenant(app, { orgId: seeded.a.org.orgId }, async (tx) => {
      for (const t of tables) {
        const rows = await tx.select().from(t);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.orgId === seeded.a.org.orgId)).toBe(true);
      }
    });
  });

  it("không ghi được sự kiện, log, lease cho run của tổ chức khác", async () => {
    const a = seeded.a.org.orgId;
    const b = seeded.b;
    const inA = (fn: Parameters<typeof withTenant>[2]) => pgCode(() => withTenant(app, { orgId: a }, fn));
    expect(
      await inA((tx) => tx.insert(runEvents).values({ orgId: b.org.orgId, runId: b.runId, attempt: 1, type: "x" })),
    ).toBe("42501");
    // Ghi org của mình nhưng trỏ tới run của tổ chức khác: khoá kép chặn.
    expect(await inA((tx) => tx.insert(runEvents).values({ orgId: a, runId: b.runId, attempt: 1, type: "x" }))).toBe(
      "23503",
    );
    expect(
      await inA((tx) =>
        tx
          .insert(runLogs)
          .values({ orgId: b.org.orgId, runId: b.runId, attempt: 1, seq: 9, offset: 9, data: Buffer.from("x") }),
      ),
    ).toBe("42501");
    expect(
      await inA((tx) =>
        tx.update(runLeases).set({ machineId: b.machineId }).where(eq(runLeases.runId, seeded.a.runId)),
      ),
    ).toBe("23503");
  });

  it("UPDATE không chuyển được run sang tổ chức khác", async () => {
    const code = await pgCode(() =>
      withTenant(app, { orgId: seeded.a.org.orgId }, (tx) =>
        tx.update(runs).set({ orgId: seeded.b.org.orgId }).where(eq(runs.id, seeded.a.runId)),
      ),
    );
    expect(code).toBe("42501");
  });

  it("run_events chỉ thêm, không sửa hay xoá được", async () => {
    const inA = (fn: Parameters<typeof withTenant>[2]) =>
      pgCode(() => withTenant(app, { orgId: seeded.a.org.orgId }, fn));
    expect(await inA((tx) => tx.update(runEvents).set({ type: "y" }))).toBe("42501");
    expect(await inA((tx) => tx.delete(runEvents))).toBe("42501");
  });

  it("mỗi task chỉ một run đang sống", async () => {
    const { rows } = await admin.query("select task_id, project_id from hive.runs where id = $1", [seeded.a.runId]);
    const code = await pgCode(() =>
      withTenant(app, { orgId: seeded.a.org.orgId }, (tx) =>
        tx.insert(runs).values({
          orgId: seeded.a.org.orgId,
          teamId: seeded.a.org.teamId,
          taskId: rows[0].task_id,
          projectId: rows[0].project_id,
          branch: "ai/k-1",
          policySnapshot: [],
          createdBy: "u",
        }),
      ),
    );
    expect(code).toBe("23505");
  });
});
