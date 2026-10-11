import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, pgCode, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { plans } from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));

type Org = OrgFixture & { user: (n: string) => string };
const seeded: Record<"a" | "b", { org: Org; taskId: string; runId: string; planRunId: string; planId: string }> =
  {} as never;
const content = { summary: "Kế hoạch", steps: [{ title: "Bước 1" }], files: [], risks: [], questions: [] };

/** Seed task, run code, run plan và kế hoạch bằng superuser để test RLS đứng độc lập với lõi giao run. */
async function seed(name: "a" | "b") {
  const org = await seedOrg(admin, `plans-rls-${name}-${randomUUID().slice(0, 6)}`);
  const { projectId } = await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: `plans-rls-${name}`,
  });
  const one = async (q: string, p: unknown[]) => (await admin.query(q, p)).rows[0].id as string;
  const taskId = await one(
    `insert into hive.tasks (org_id, team_id, project_id, number, key, title, status, created_by)
     values ($1, $2, $3, 1, 'k-1', 't', 'awaiting_plan', 'u') returning id`,
    [org.orgId, org.teamId, projectId],
  );
  const runId = await one(
    `insert into hive.runs (org_id, team_id, task_id, project_id, branch, policy_snapshot, created_by, state)
     values ($1, $2, $3, $4, 'ai/k-1', '[]', 'u', 'awaiting_plan') returning id`,
    [org.orgId, org.teamId, taskId, projectId],
  );
  const planRunId = await one(
    `insert into hive.runs (org_id, team_id, task_id, project_id, kind, parent_run_id, branch, policy_snapshot,
       created_by, state)
     values ($1, $2, $3, $4, 'plan', $5, 'ai/k-1', '[]', 'u', 'succeeded') returning id`,
    [org.orgId, org.teamId, taskId, projectId, runId],
  );
  const planId = await one(
    `insert into hive.plans (org_id, team_id, task_id, run_id, plan_run_id, revision, content)
     values ($1, $2, $3, $4, $5, 1, $6) returning id`,
    [org.orgId, org.teamId, taskId, runId, planRunId, JSON.stringify(content)],
  );
  seeded[name] = { org, taskId, runId, planRunId, planId };
}

beforeAll(async () => {
  await seed("a");
  await seed("b");
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

const inA = (fn: (tx: Tx) => Promise<unknown>) => pgCode(() => withTenant(app, { orgId: seeded.a.org.orgId }, fn));

describe("RLS bảng plans", () => {
  it("không có context thì 0 dòng; context tổ chức A chỉ thấy kế hoạch của A", async () => {
    await withTenant(app, {}, async (tx) => expect(await tx.select().from(plans)).toHaveLength(0));
    await withTenant(app, { orgId: seeded.a.org.orgId }, async (tx) => {
      const rows = await tx.select().from(plans);
      expect(rows.map((r) => r.id)).toContain(seeded.a.planId);
      expect(rows.every((r) => r.orgId === seeded.a.org.orgId)).toBe(true);
    });
  });

  it("không ghi được kế hoạch cho tổ chức khác, UPDATE không chuyển được sang tổ chức khác", async () => {
    const b = seeded.b;
    const values = {
      orgId: b.org.orgId,
      teamId: b.org.teamId,
      taskId: b.taskId,
      runId: b.runId,
      planRunId: b.planRunId,
      revision: 9,
      content,
    };
    expect(await inA((tx) => tx.insert(plans).values(values))).toBe("42501");
    expect(await inA((tx) => tx.update(plans).set({ orgId: b.org.orgId }).where(eq(plans.id, seeded.a.planId)))).toBe(
      "42501",
    );
    // Context A không thấy dòng của B nên không sửa hay xoá được.
    await withTenant(app, { orgId: seeded.a.org.orgId }, async (tx) => {
      expect(await tx.update(plans).set({ note: "x" }).where(eq(plans.id, b.planId)).returning()).toHaveLength(0);
      expect(await tx.delete(plans).where(eq(plans.id, b.planId)).returning()).toHaveLength(0);
    });
  });

  it("kế hoạch không trỏ được tới task, run hay đội của tổ chức khác (khoá kép)", async () => {
    const a = seeded.a;
    const b = seeded.b;
    // Run plan khác và trạng thái đã quyết, để chỉ khoá ngoại chặn (ràng buộc duy nhất kiểm trước khoá ngoại).
    const { rows } = await admin.query(
      `insert into hive.runs (org_id, team_id, task_id, project_id, kind, parent_run_id, branch, policy_snapshot,
         created_by, state)
       select org_id, team_id, task_id, project_id, 'plan', id, branch, '[]', 'u', 'failed' from hive.runs where id = $1
       returning id`,
      [a.runId],
    );
    const base = {
      orgId: a.org.orgId,
      teamId: a.org.teamId,
      taskId: a.taskId,
      runId: a.runId,
      planRunId: rows[0].id as string,
      revision: 10,
      status: "rejected" as const,
      content,
    };
    expect(await inA((tx) => tx.insert(plans).values(base).returning())).toBeUndefined();
    await admin.query("delete from hive.plans where plan_run_id = $1", [base.planRunId]);
    expect(await inA((tx) => tx.insert(plans).values({ ...base, taskId: b.taskId }))).toBe("23503");
    expect(await inA((tx) => tx.insert(plans).values({ ...base, runId: b.runId }))).toBe("23503");
    expect(await inA((tx) => tx.insert(plans).values({ ...base, planRunId: b.runId }))).toBe("23503");
    expect(await inA((tx) => tx.insert(plans).values({ ...base, teamId: b.org.teamId }))).toBe("23503");
  });

  it("mỗi run code chỉ một kế hoạch chờ duyệt; hive_app không TRUNCATE được", async () => {
    const a = seeded.a;
    const code = await inA((tx) =>
      tx.insert(plans).values({
        orgId: a.org.orgId,
        teamId: a.org.teamId,
        taskId: a.taskId,
        runId: a.runId,
        planRunId: a.runId,
        revision: 2,
        content,
      }),
    );
    expect(code).toBe("23505");
    expect(await inA((tx) => tx.execute(sql`truncate hive.plans`))).toBe("42501");
  });
});
